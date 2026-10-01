import asyncio
import base64
import json
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError

from services.comfyui.comfyui_generate import finalize_backend_response
from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.processors.mask_crop import create_mask_crop_processor
from services.gen_pipeline.processors.utils.aspect_ratio_processing import (
    apply_aspect_ratio_processing,
)
from services.workflow_rules import (
    load_rules_model_for_workflow,
    normalize_rules_model,
)
from services.workflow_rules.mask_pairs import collect_mask_crop_pairs
from services.workflow_rules.pipeline import (
    iter_pipeline_stages,
    resolve_pipeline_control_values,
    resolve_pipeline_control_values_with_warnings,
)
from services.workflow_rules.schema import (
    ResolvedWorkflowRules,
    dump_resolved_rules,
    get_pipeline_stage,
)


DEFAULT_WORKFLOWS_DIR = (
    Path(__file__).resolve().parent.parent
    / "assets"
    / ".config"
    / "default_workflows"
)


def test_vace_inpaint_uses_v3_pipeline_stage_controls():
    rules, warnings = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_VACE_inpaint.json",
    )

    assert warnings == []
    assert rules.version == 3

    mask_stage = get_pipeline_stage(rules, "mask_processing")
    assert mask_stage is not None
    assert mask_stage.after == ["aspect_ratio"]
    assert [control.key for control in mask_stage.controls] == [
        "crop_mode",
        "crop_dilation",
    ]
    assert rules.derived_widgets[0].kind == "single_sampler_denoise"
    assert rules.derived_widgets[0].id == "single_sampler_denoise"
    assert len(rules.effect_switches) == 1

    aspect_stage = get_pipeline_stage(rules, "aspect_ratio")
    assert aspect_stage is not None
    assert [target.width.node_id for target in aspect_stage.targets] == ["104", "105"]


def test_ttm_sidecar_loads_track_selection_message_and_mask_selection_modes():
    rules, warnings = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_minimax_h3_ttm.json",
    )

    assert warnings == []
    assert rules.version == 3

    source_video_rule = rules.nodes["1"]
    assert source_video_rule.selection is not None
    assert source_video_rule.selection.include_tracks is True
    assert (
        source_video_rule.selection.message
        == "Select which track(s) contain the moving object(s)"
    )

    mask_stage = get_pipeline_stage(rules, "mask_processing")
    assert mask_stage is not None
    assert len(mask_stage.targets) == 1
    assert mask_stage.targets[0].source_selection == "full_selection"
    assert mask_stage.targets[0].mask_selection == "input_selection"
    assert mask_stage.targets[0].source_video_treatment == "preserve_transparency"


def test_ttm_sidecar_defaults_to_full_mask_mode_and_disables_mask_attachment():
    rules, warnings = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_minimax_h3_ttm.json",
    )

    assert warnings == []
    assert rules.version == 3

    mask_stage = get_pipeline_stage(rules, "mask_processing")
    assert mask_stage is not None
    assert mask_stage.controls[0].key == "crop_mode"
    assert mask_stage.controls[0].default == "full"
    assert mask_stage.controls[0].expose == "none"
    assert mask_stage.controls[1].key == "crop_dilation"
    assert mask_stage.controls[1].expose == "none"

    output_assembly = get_pipeline_stage(rules, "output_assembly")
    assert output_assembly is not None
    assert output_assembly.config.attach_generation_mask is False


def test_vace_inpaint_collects_mask_crop_pairs():
    rules_model, _ = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_VACE_inpaint.json",
    )
    rules = dump_resolved_rules(rules_model)
    assert collect_mask_crop_pairs(rules) == [("118", "119")]


def test_vace_inpaint_client_target_aspect_ratio_accepts_frontend_submission():
    rules_model, _ = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_VACE_inpaint.json",
    )
    aspect_stage = get_pipeline_stage(rules_model, "aspect_ratio")

    assert aspect_stage is not None
    target_aspect_ratio_control = next(
        control
        for control in aspect_stage.controls
        if control.key == "target_aspect_ratio"
    )
    # The panel presents the selector; the value still arrives from the client
    # rather than being read back off a workflow widget.
    assert target_aspect_ratio_control.expose == "widget"
    assert target_aspect_ratio_control.source == "client"

    resolved, warnings = resolve_pipeline_control_values_with_warnings(
        dump_resolved_rules(rules_model),
        workflow={},
        pipeline_inputs={
            "aspect_ratio": {
                "target_aspect_ratio": "16:9",
                "target_resolution": 720,
            }
        },
    )

    assert resolved["aspect_ratio"]["target_aspect_ratio"] == "16:9"
    assert not any(
        warning["code"] == "ignored_pipeline_control_submission"
        and warning.get("control_key") == "target_aspect_ratio"
        for warning in warnings
    )


def test_pipeline_controls_can_bind_to_input_metadata():
    resolved, warnings = resolve_pipeline_control_values_with_warnings(
        {
            "version": 3,
            "pipeline": [
                {
                    "id": "output_assembly",
                    "kind": "output_assembly",
                    "controls": [
                        {
                            "key": "mode",
                            "value_type": "string",
                            "default": "auto",
                            "default_rules": [
                                {
                                    "when": {
                                        "ref": {
                                            "kind": "input_metadata",
                                            "input": "89",
                                            "field": "timelineSelection.durationSeconds",
                                        },
                                        "operator": "gt",
                                        "value": 5,
                                    },
                                    "value": "stitch_frames_with_audio",
                                }
                            ],
                        }
                    ],
                }
            ],
        },
        workflow={},
        pipeline_inputs={},
        input_metadata={
            "89": {
                "sourceKind": "timeline_selection",
                "timelineSelection": {
                    "durationSeconds": 6,
                },
            }
        },
    )

    assert warnings == []
    assert resolved["output_assembly"]["mode"] == "stitch_frames_with_audio"


def test_vace_inpaint_mask_crop_records_crop_metadata_from_pipeline_outputs():
    rules_model, _ = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_VACE_inpaint.json",
    )
    rules = dump_resolved_rules(rules_model)
    resolved_controls = resolve_pipeline_control_values(
        rules,
        workflow={},
        pipeline_inputs={
            "aspect_ratio": {
                "target_aspect_ratio": "16:9",
                "target_resolution": 720,
            },
            "mask_processing": {
                "crop_mode": "crop",
                "crop_dilation": 0.1,
            },
        },
    )
    ctx = BackendPipelineContext(
        client=httpx.AsyncClient(base_url="http://example.test"),
        client_id="client",
        workflow={},
        rules=rules,
        buffered_media={
            "source": {"node_id": "118", "input_type": "video", "bytes": b"source"},
            "mask": {"node_id": "119", "input_type": "video", "bytes": b"mask"},
        },
        resolved_pipeline_controls=resolved_controls,
    )
    processor = create_mask_crop_processor(
        lambda *_args, **_kwargs: (100, 50, 300, 150),
        lambda video_bytes, _crop, **_kwargs: video_bytes,
        lambda _video_bytes: (1000, 500),
    )

    asyncio.run(processor.execute(ctx))

    assert ctx.pipeline_outputs["mask_processing"]["mask_crop_metadata"] == {
        "mode": "cropped",
        "crop_position": [100, 50],
        "crop_size": [200, 100],
        "container_size": [1000, 500],
        "scale": 0.2,
    }
    assert ctx.pipeline_outputs["mask_processing"]["processed_mask_bytes"] == b"mask"


def test_aspect_ratio_processing_normalizes_resize_image_mask_targets_in_v3_schema():
    workflow = {
        "693": {
            "class_type": "ResizeImageMaskNode",
            "inputs": {
                "resize_type": "scale by multiplier",
                "scale_method": "area",
                "input": ["690", 0],
            },
        }
    }
    rules = {
        "version": 3,
        "pipeline": [
            {
                "id": "aspect_ratio",
                "kind": "aspect_ratio",
                "config": {
                    "stride": 32,
                    "search_steps": 2,
                    "resolutions": [720, 1080],
                },
                "targets": [
                    {
                        "width": {"node_id": "693", "param": "resize_type.width"},
                        "height": {"node_id": "693", "param": "resize_type.height"},
                    }
                ],
                "controls": [
                    {
                        "key": "target_resolution",
                        "value_type": "int",
                        "expose": "widget",
                        "default": 1080,
                    },
                    {
                        "key": "target_aspect_ratio",
                        "value_type": "string",
                        "expose": "none",
                        "source": "client",
                    },
                ],
            }
        ],
    }

    metadata, warnings = apply_aspect_ratio_processing(
        workflow,
        rules,
        "16:9",
        1080,
    )

    assert warnings == []
    assert metadata is not None
    assert workflow["693"]["inputs"]["resize_type"] == "scale dimensions"
    assert workflow["693"]["inputs"]["resize_type.crop"] == "disabled"
    assert workflow["693"]["inputs"]["resize_type.width"] == metadata["strided"]["width"]
    assert (
        workflow["693"]["inputs"]["resize_type.height"]
        == metadata["strided"]["height"]
    )
    assert workflow["693"]["inputs"]["resize_type.width"] % 32 == 0
    assert workflow["693"]["inputs"]["resize_type.height"] % 32 == 0


def _postprocess_targets_workflow_and_rules():
    workflow = {
        "145": {"class_type": "PrimitiveInt", "inputs": {"value": 0}},
        "146": {"class_type": "PrimitiveInt", "inputs": {"value": 0}},
        "152": {
            "class_type": "ResizeImageMaskNode",
            "inputs": {
                "resize_type": "scale by multiplier",
                "scale_method": "lanczos",
                "input": ["122", 0],
            },
        },
    }
    rules = {
        "version": 3,
        "pipeline": [
            {
                "id": "aspect_ratio",
                "kind": "aspect_ratio",
                "config": {
                    "stride": 32,
                    "search_steps": 2,
                    "resolution_ladder": {"min": 240, "max": 720, "steps": 5},
                    "postprocess": {
                        "enabled": True,
                        "mode": "stretch_exact",
                        "apply_to": "all_visual_outputs",
                        "targets": [
                            {
                                "width": {
                                    "node_id": "152",
                                    "param": "resize_type.width",
                                },
                                "height": {
                                    "node_id": "152",
                                    "param": "resize_type.height",
                                },
                            }
                        ],
                    },
                },
                "targets": [
                    {
                        "width": {"node_id": "145", "param": "value"},
                        "height": {"node_id": "146", "param": "value"},
                    }
                ],
            }
        ],
    }
    return workflow, rules


def test_aspect_ratio_postprocess_targets_receive_true_dimensions():
    workflow, rules = _postprocess_targets_workflow_and_rules()

    metadata, warnings = apply_aspect_ratio_processing(workflow, rules, "16:9", 720)

    assert warnings == []
    assert metadata is not None

    # The generation canvas is strided; the post-decode resize is not.
    assert workflow["145"]["inputs"]["value"] == metadata["strided"]["width"]
    assert workflow["146"]["inputs"]["value"] == metadata["strided"]["height"]
    assert workflow["145"]["inputs"]["value"] % 32 == 0
    assert workflow["146"]["inputs"]["value"] % 32 == 0

    assert workflow["152"]["inputs"]["resize_type"] == "scale dimensions"
    assert workflow["152"]["inputs"]["resize_type.crop"] == "disabled"
    assert workflow["152"]["inputs"]["resize_type.width"] == 1280
    assert workflow["152"]["inputs"]["resize_type.height"] == 720
    # The authored scale method survives normalization.
    assert workflow["152"]["inputs"]["scale_method"] == "lanczos"

    # The two dimension sets genuinely differ, so this test would catch the
    # postprocess target being fed the strided numbers by mistake.
    assert (
        metadata["strided"]["width"],
        metadata["strided"]["height"],
    ) != (1280, 720)

    assert metadata["postprocess"]["target_width"] == 1280
    assert metadata["postprocess"]["target_height"] == 720
    assert metadata["postprocess"]["applied_nodes"] == [
        {
            "width": {"node_id": "152", "param": "resize_type.width"},
            "height": {"node_id": "152", "param": "resize_type.height"},
        }
    ]
    assert metadata["postprocess"]["all_visual_outputs_handled"] is True


def test_aspect_ratio_postprocess_targets_degrade_when_node_is_missing():
    workflow, rules = _postprocess_targets_workflow_and_rules()
    del workflow["152"]

    metadata, warnings = apply_aspect_ratio_processing(workflow, rules, "16:9", 720)

    assert metadata is not None
    # The strided dispatch still applies; only the in-workflow resize is lost.
    assert workflow["145"]["inputs"]["value"] == metadata["strided"]["width"]
    assert metadata["postprocess"]["applied_nodes"] == []
    assert metadata["postprocess"]["all_visual_outputs_handled"] is False

    codes = {warning["code"] for warning in warnings}
    assert "aspect_ratio_processing_target_node_missing" in codes
    assert "aspect_ratio_processing_postprocess_nodes_not_applied" in codes


def test_aspect_ratio_postprocess_disabled_neutralises_the_output_resize_node():
    """
    A disabled postprocess cannot unwire a node that is already in the graph.
    Leaving it at its authored size would deliver that size, so it is pointed
    at the generation size instead — an identity resize, which is what
    "outputs stay strided" means in practice.
    """
    workflow, rules = _postprocess_targets_workflow_and_rules()
    rules["pipeline"][0]["config"]["postprocess"]["enabled"] = False
    workflow["152"]["inputs"]["resize_type.width"] = 1280
    workflow["152"]["inputs"]["resize_type.height"] = 720

    metadata, warnings = apply_aspect_ratio_processing(workflow, rules, "16:9", 240)

    assert metadata is not None
    assert metadata["postprocess"]["enabled"] is False
    assert metadata["postprocess"]["applied_nodes"] == []
    assert metadata["postprocess"]["all_visual_outputs_handled"] is False

    # The authored 1280x720 would otherwise have been delivered for a 240p
    # request; the node now matches the generation canvas exactly.
    assert workflow["152"]["inputs"]["resize_type.width"] == metadata["strided"]["width"]
    assert (
        workflow["152"]["inputs"]["resize_type.height"] == metadata["strided"]["height"]
    )
    assert [w["code"] for w in warnings] == [
        "aspect_ratio_processing_postprocess_disabled_with_targets"
    ]


def test_aspect_ratio_postprocess_target_is_encoder_aligned():
    """16:9 at 240 wants 427x240; no yuv420p encoder can emit an odd width."""
    workflow, rules = _postprocess_targets_workflow_and_rules()

    metadata, warnings = apply_aspect_ratio_processing(workflow, rules, "16:9", 240)

    assert warnings == []
    assert metadata is not None
    # The request is recorded as asked...
    assert metadata["requested"]["width"] == 427
    # ...but what is promised and written is what an encoder can produce.
    assert metadata["postprocess"]["target_width"] == 428
    assert metadata["postprocess"]["target_height"] == 240
    assert workflow["152"]["inputs"]["resize_type.width"] == 428
    assert workflow["152"]["inputs"]["resize_type.height"] == 240
    assert metadata["postprocess"]["all_visual_outputs_handled"] is True


def test_aspect_ratio_postprocess_partial_application_does_not_claim_coverage():
    """
    One written node must not suppress the frontend fallback for the outputs a
    second, missing node was meant to cover.
    """
    workflow, rules = _postprocess_targets_workflow_and_rules()
    rules["pipeline"][0]["config"]["postprocess"]["targets"].append(
        {
            "width": {"node_id": "153", "param": "resize_type.width"},
            "height": {"node_id": "153", "param": "resize_type.height"},
        }
    )

    metadata, warnings = apply_aspect_ratio_processing(workflow, rules, "16:9", 720)

    assert metadata is not None
    assert len(metadata["postprocess"]["applied_nodes"]) == 1
    assert metadata["postprocess"]["all_visual_outputs_handled"] is False

    codes = {w["code"] for w in warnings}
    assert "aspect_ratio_processing_postprocess_nodes_not_applied" in codes


@pytest.mark.parametrize(
    "workflow_name",
    ["vlo_ltx2_5_ic_edit.json", "vlo_ltx2_5_clean_plate.json"],
)
def test_ic_lora_rules_bypass_mask_chain_when_mask_missing(workflow_name):
    rules_model, warnings = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        workflow_name,
    )

    assert warnings == []
    assert rules_model.media_fallbacks == []
    assert rules_model.frontend_controls == {}
    assert len(rules_model.rewrites) == 1

    missing_mask_rewrite = rules_model.rewrites[0]
    assert missing_mask_rewrite.when.kind == "input_presence"
    assert missing_mask_rewrite.when.inputs == ["689"]
    assert missing_mask_rewrite.when.match == "all_missing"
    assert missing_mask_rewrite.bypass == ["689", "693", "694", "703", "708"]


def test_ltx23_inpaint_rules_expose_retake_widget():
    rules_model, warnings = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_ltx2_5_inpaint.json",
    )

    assert warnings == []
    assert rules_model.frontend_controls == {}
    assert len(rules_model.derived_widgets) == 1
    assert rules_model.derived_widgets[0].kind == "video_audio_retake"
    assert rules_model.rewrites == []


def test_ltx23_inpaint_workflow_emits_websocket_frames_and_preview_audio():
    workflow_graph = json.loads(
        (DEFAULT_WORKFLOWS_DIR / "vlo_ltx2_5_inpaint.json").read_text(
            encoding="utf-8"
        )
    )

    nodes_by_id = {str(node["id"]): node for node in workflow_graph["nodes"]}
    assert all(
        node["type"] not in {"SaveImageWebsocket", "PreviewAudio"}
        for node in nodes_by_id.values()
    )

    prompt_snapshot = workflow_graph["extra"]["prompt"]
    assert prompt_snapshot["15"]["class_type"] == "SaveImageWebsocket"
    assert prompt_snapshot["21"]["class_type"] == "PreviewAudio"
    assert prompt_snapshot["15"]["inputs"] == {"images": ["12", 0]}
    assert prompt_snapshot["21"]["inputs"]["audio"] == ["14", 0]


def test_default_workflow_rules_parse_with_current_schema():
    for rules_path in sorted(DEFAULT_WORKFLOWS_DIR.glob("*.rules.json")):
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
        ResolvedWorkflowRules.model_validate(rules)


def test_schema_accepts_section_metadata():
    rules_model, warnings = normalize_rules_model(
        {
            "version": 3,
            "sections": [
                {
                    "id": "masking",
                    "title": "Masking",
                    "order": 1,
                    "default_open": False,
                    "extension": {
                        "extension_id": "example.path-tools",
                        "contribution_id": "canvas",
                        "config": {"stroke": "#22d3ee", "snap": True},
                    },
                }
            ],
            "nodes": {
                "10": {
                    "present": {
                        "input_type": "text",
                        "param": "text",
                        "section_id": "prompts",
                    }
                },
                "20": {
                    "widgets": {
                        "strength": {
                            "value_type": "float",
                            "section_id": "masking",
                        }
                    }
                },
            },
            "derived_widgets": [
                {
                    "id": "retake_mode",
                    "kind": "video_audio_retake",
                    "label": "Retake",
                    "section_id": "masking",
                    "video_bypass": {"node_id": "705", "param": "switch"},
                    "audio_bypass": {"node_id": "714", "param": "switch"},
                }
            ],
            "pipeline": [
                {
                    "id": "mask_processing",
                    "kind": "mask_processing",
                    "targets": [],
                    "controls": [
                        {
                            "key": "crop_mode",
                            "value_type": "enum",
                            "options": ["crop", "full"],
                            "section_id": "masking",
                        }
                    ],
                }
            ],
        }
    )

    assert warnings == []
    assert rules_model.sections[0].id == "masking"
    assert rules_model.sections[0].default_open is False
    assert rules_model.sections[0].extension is not None
    assert rules_model.sections[0].extension.extension_id == "example.path-tools"
    assert rules_model.sections[0].extension.contribution_id == "canvas"
    assert rules_model.sections[0].extension.config == {
        "stroke": "#22d3ee",
        "snap": True,
    }
    assert rules_model.nodes["10"].present is not None
    assert rules_model.nodes["10"].present.section_id == "prompts"
    assert rules_model.nodes["20"].widgets["strength"].section_id == "masking"
    assert rules_model.derived_widgets[0].section_id == "masking"
    assert rules_model.pipeline[0].controls[0].section_id == "masking"


@pytest.mark.parametrize(
    ("field", "value"),
    [("extension_id", "Example Path"), ("contribution_id", "canvas/other")],
)
def test_schema_rejects_invalid_extension_section_ids(field: str, value: str):
    extension = {
        "extension_id": "example.path-tools",
        "contribution_id": "canvas",
    }
    extension[field] = value

    with pytest.raises(ValidationError):
        ResolvedWorkflowRules.model_validate(
            {
                "version": 3,
                "sections": [{"id": "path", "extension": extension}],
            }
        )


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_schema_rejects_non_finite_extension_section_config(value: float):
    with pytest.raises(ValidationError, match="config must be finite JSON"):
        ResolvedWorkflowRules.model_validate(
            {
                "version": 3,
                "sections": [
                    {
                        "id": "path",
                        "extension": {
                            "extension_id": "example.path-tools",
                            "contribution_id": "canvas",
                            "config": {"coordinate": value},
                        },
                    }
                ],
            }
        )


def test_schema_rejects_oversize_extension_section_config():
    with pytest.raises(ValidationError, match="exceeds 100000 serialized characters"):
        ResolvedWorkflowRules.model_validate(
            {
                "version": 3,
                "sections": [
                    {
                        "id": "path",
                        "extension": {
                            "extension_id": "example.path-tools",
                            "contribution_id": "canvas",
                            "config": {"path": "x" * 100_001},
                        },
                    }
                ],
            }
        )


def test_schema_rejects_legacy_fields():
    rules_model, warnings = normalize_rules_model(
        {
            "version": 3,
            "nodes": {"2": {"binary_derived_mask_of": "1"}},
        }
    )

    assert rules_model.version == 3
    assert rules_model.pipeline == []
    assert any(
        warning.code == "invalid_workflow_rules"
        and "Extra inputs are not permitted" in warning.message
        for warning in warnings
    )


def test_schema_rejects_pipeline_control_cycles():
    rules_model, warnings = normalize_rules_model(
        {
            "version": 3,
            "pipeline": [
                {
                    "id": "mask_processing",
                    "kind": "mask_processing",
                    "targets": [],
                    "controls": [
                        {
                            "key": "a",
                            "value_type": "enum",
                            "options": ["x"],
                            "bind": {
                                "kind": "pipeline_control",
                                "stage_id": "mask_processing",
                                "key": "b",
                            },
                        },
                        {
                            "key": "b",
                            "value_type": "enum",
                            "options": ["x"],
                            "bind": {
                                "kind": "pipeline_control",
                                "stage_id": "mask_processing",
                                "key": "a",
                            },
                        },
                    ],
                }
            ],
        }
    )

    assert rules_model.version == 3
    assert rules_model.pipeline == []
    assert any(
        warning.code == "invalid_workflow_rules"
        and "reference cycle" in warning.message.lower()
        for warning in warnings
    )


def test_iter_pipeline_stages_uses_explicit_after_dependencies():
    ordered_stages = iter_pipeline_stages(
        {
            "version": 3,
            "pipeline": [
                {
                    "id": "mask_processing",
                    "kind": "mask_processing",
                    "after": ["custom_aspect"],
                    "targets": [],
                    "controls": [],
                },
                {
                    "id": "custom_aspect",
                    "kind": "aspect_ratio",
                    "targets": [],
                    "controls": [],
                },
            ],
        }
    )

    assert [stage["id"] for stage in ordered_stages] == [
        "custom_aspect",
        "mask_processing",
    ]


def test_finalize_backend_response_serializes_pipeline_outputs():
    ctx = BackendPipelineContext(
        client=httpx.AsyncClient(base_url="http://example.test"),
        client_id="client",
        workflow={"1": {"inputs": {}}},
        pipeline_outputs={
            "mask_processing": {
                "mask_crop_metadata": {"mode": "full"},
                "processed_mask_bytes": b"abc",
            }
        },
        comfyui_response=httpx.Response(
            200,
            json={
                "prompt_id": "prompt-1",
                "number": 1,
                "node_errors": {},
            },
        ),
    )

    result = finalize_backend_response(ctx)
    payload = json.loads(result.content)

    assert payload["pipeline_outputs"]["mask_processing"]["mask_crop_metadata"] == {
        "mode": "full"
    }
    assert payload["pipeline_outputs"]["mask_processing"]["processed_mask_video"] == (
        base64.b64encode(b"abc").decode("ascii")
    )
    assert "processed_mask_bytes" not in payload["pipeline_outputs"]["mask_processing"]


def test_pipeline_control_source_defaults_to_client_for_widget():
    rules_model, warnings = normalize_rules_model(
        {
            "version": 3,
            "pipeline": [
                {
                    "id": "aspect_ratio",
                    "kind": "aspect_ratio",
                    "targets": [],
                    "controls": [
                        {
                            "key": "target_resolution",
                            "value_type": "int",
                            "expose": "widget",
                            "options": [480, 720],
                            "default": 720,
                        }
                    ],
                }
            ],
        }
    )

    stage = get_pipeline_stage(rules_model, "aspect_ratio")
    assert stage is not None
    control = stage.controls[0]
    assert control.expose == "widget"
    assert control.source == "client"
    assert not any(w.code.startswith("invalid_") for w in warnings)


def test_aspect_ratio_resolution_ladder_rejects_ambiguous_or_excessive_rules():
    for config, expected_message in (
        (
            {
                "resolutions": [480, 720],
                "resolution_ladder": {"min": 240, "max": 720, "steps": 5},
            },
            "either resolutions or resolution_ladder",
        ),
        (
            {"resolution_ladder": {"min": 240, "max": 720, "steps": 21}},
            "less than or equal to 20",
        ),
    ):
        _, warnings = normalize_rules_model(
            {
                "version": 3,
                "pipeline": [
                    {
                        "id": "aspect_ratio",
                        "kind": "aspect_ratio",
                        "config": config,
                        "targets": [],
                    }
                ],
            }
        )

        assert any(
            warning.code == "invalid_workflow_rules"
            and expected_message in warning.message
            for warning in warnings
        )


def test_pipeline_control_source_required_when_not_widget():
    _, warnings = normalize_rules_model(
        {
            "version": 3,
            "pipeline": [
                {
                    "id": "aspect_ratio",
                    "kind": "aspect_ratio",
                    "targets": [],
                    "controls": [
                        {
                            "key": "target_aspect_ratio",
                            "value_type": "string",
                            "expose": "none",
                        }
                    ],
                }
            ],
        }
    )

    # Control without explicit source on a non-widget control must fail
    # validation — this is the invariant that prevents the previous
    # target_aspect_ratio regression.
    assert any(
        warning.code == "invalid_workflow_rules"
        and "must declare source" in warning.message
        for warning in warnings
    )


def test_pipeline_control_rejects_widget_with_backend_source():
    _, warnings = normalize_rules_model(
        {
            "version": 3,
            "pipeline": [
                {
                    "id": "aspect_ratio",
                    "kind": "aspect_ratio",
                    "targets": [],
                    "controls": [
                        {
                            "key": "target_resolution",
                            "value_type": "int",
                            "expose": "widget",
                            "source": "backend",
                            "options": [480, 720],
                        }
                    ],
                }
            ],
        }
    )

    assert any(
        warning.code == "invalid_workflow_rules"
        and "source != 'client'" in warning.message
        for warning in warnings
    )
