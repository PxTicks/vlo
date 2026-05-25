import asyncio
import base64
import json
import os
import sys
from pathlib import Path

import httpx

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

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


def test_wan_animate_sidecar_loads_mask_processing_rules():
    rules, warnings = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_wan_animate.json",
    )

    assert warnings == []
    assert rules.version == 3

    mask_stage = get_pipeline_stage(rules, "mask_processing")
    assert mask_stage is not None
    assert [(target.source.node_id, target.mask.node_id) for target in mask_stage.targets] == [
        ("185", "190")
    ]
    assert [control.key for control in mask_stage.controls] == [
        "crop_mode",
        "crop_dilation",
    ]
    assert mask_stage.controls[0].default_rules is not None
    assert mask_stage.controls[0].default_rules[0].when.ref.control_id == "animate_mode"
    assert mask_stage.controls[0].default_rules[0].value == "full"

    output_assembly = get_pipeline_stage(rules, "output_assembly")
    assert output_assembly is not None
    attach_mask_control = output_assembly.controls[0]
    assert attach_mask_control.key == "attach_generation_mask"
    assert attach_mask_control.default is True
    assert attach_mask_control.default_rules is not None
    assert attach_mask_control.default_rules[0].when.ref.control_id == "animate_mode"
    assert attach_mask_control.default_rules[0].value is False


def test_wan_ttm_sidecar_loads_track_selection_message_and_mask_selection_modes():
    rules, warnings = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_wan_ttm.json",
    )

    assert warnings == []
    assert rules.version == 3

    source_video_rule = rules.nodes["129"]
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


def test_wan_ttm_sidecar_defaults_to_full_mask_mode_and_disables_mask_attachment():
    rules, warnings = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_wan_ttm.json",
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


def test_vace_inpaint_hidden_target_aspect_ratio_accepts_frontend_submission():
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
    assert target_aspect_ratio_control.expose == "none"
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


def test_ic_edit_rules_allow_frontend_control_prompt_enhancer_rewrites():
    rules_model, warnings = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_ltx2_3_ic_edit.json",
    )

    assert warnings == []
    assert rules_model.media_fallbacks == []
    assert "prompt_enhancer_enabled" in rules_model.frontend_controls
    assert len(rules_model.rewrites) == 2

    off_rewrite = rules_model.rewrites[0]

    assert off_rewrite.when.kind == "compare"
    assert off_rewrite.when.ref.kind == "frontend_control"
    assert off_rewrite.when.ref.control_id == "prompt_enhancer_enabled"
    assert off_rewrite.when.operator == "eq"
    assert off_rewrite.when.value is False
    assert off_rewrite.bypass == ["599"]
    assert off_rewrite.set_widgets == []

    missing_mask_rewrite = rules_model.rewrites[1]
    assert missing_mask_rewrite.when.kind == "input_presence"
    assert missing_mask_rewrite.when.inputs == ["689"]
    assert missing_mask_rewrite.when.match == "all_missing"
    assert missing_mask_rewrite.bypass == ["689", "693", "694", "703", "708"]

def test_ltx23_inpaint_rules_allow_prompt_enhancer_rewrites_and_retake_widget():
    rules_model, warnings = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_ltx2_3_inpaint.json",
    )

    assert warnings == []
    assert "prompt_enhancer_enabled" in rules_model.frontend_controls
    assert len(rules_model.derived_widgets) == 1
    assert rules_model.derived_widgets[0].kind == "video_audio_retake"
    assert len(rules_model.rewrites) == 1

    false_rewrite = rules_model.rewrites[0]

    assert false_rewrite.when.kind == "compare"
    assert false_rewrite.when.ref.kind == "frontend_control"
    assert false_rewrite.when.ref.control_id == "prompt_enhancer_enabled"
    assert false_rewrite.when.operator == "eq"
    assert false_rewrite.when.value is False
    assert false_rewrite.bypass == ["599"]
    assert false_rewrite.set_widgets == []


def test_ltx23_inpaint_workflow_emits_websocket_frames_and_preview_audio():
    workflow_graph = json.loads(
        (DEFAULT_WORKFLOWS_DIR / "vlo_ltx2_3_inpaint.json").read_text(
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
    assert rules_model.nodes["10"].present is not None
    assert rules_model.nodes["10"].present.section_id == "prompts"
    assert rules_model.nodes["20"].widgets["strength"].section_id == "masking"
    assert rules_model.derived_widgets[0].section_id == "masking"
    assert rules_model.pipeline[0].controls[0].section_id == "masking"


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
