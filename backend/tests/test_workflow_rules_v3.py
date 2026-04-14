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
from services.workflow_rules import load_rules_model_for_workflow, normalize_rules_model
from services.workflow_rules.mask_pairs import collect_mask_crop_pairs
from services.workflow_rules.pipeline import (
    iter_pipeline_stages,
    resolve_pipeline_control_values,
    resolve_pipeline_control_values_with_warnings,
)
from services.workflow_rules.schema import dump_resolved_rules, get_pipeline_stage


DEFAULT_WORKFLOWS_DIR = (
    Path(__file__).resolve().parent.parent
    / "assets"
    / ".config"
    / "default_workflows"
)


def test_vace_inpaint_new_uses_v3_pipeline_stage_controls():
    rules, warnings = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_VACE_inpaint_new.json",
    )

    assert warnings == []
    assert rules.version == 3

    mask_stage = get_pipeline_stage(rules, "mask_processing")
    assert mask_stage is not None
    treatment_control = next(
        control
        for control in mask_stage.controls
        if control.key == "source_video_treatment"
    )
    assert mask_stage.after == ["aspect_ratio"]
    assert treatment_control.expose == "none"
    assert treatment_control.source == "backend"
    assert treatment_control.description is not None
    assert treatment_control.exclude_options == ["preserve_transparency"]

    aspect_stage = get_pipeline_stage(rules, "aspect_ratio")
    assert aspect_stage is not None
    assert [target.width.node_id for target in aspect_stage.targets] == ["104", "105"]


def test_vace_inpaint_new_resolves_denoise_driven_source_video_treatment():
    rules_model, _ = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_VACE_inpaint_new.json",
    )
    rules = dump_resolved_rules(rules_model)

    resolved = resolve_pipeline_control_values(
        rules,
        workflow={"92": {"inputs": {"denoise": 0.6}}},
        pipeline_inputs={},
        control_option_fallbacks={
            ("mask_processing", "source_video_treatment"): [
                "preserve_transparency",
                "fill_transparent_with_neutral_gray",
                "remove_transparency",
            ]
        },
    )

    assert resolved["mask_processing"]["source_video_treatment"] == "remove_transparency"
    assert collect_mask_crop_pairs(rules) == [("98", "101")]


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
            "source": {"node_id": "98", "input_type": "video", "bytes": b"source"},
            "mask": {"node_id": "101", "input_type": "video", "bytes": b"mask"},
        },
        resolved_pipeline_controls=resolved_controls,
    )
    processor = create_mask_crop_processor(
        lambda *_args, **_kwargs: (100, 50, 300, 150),
        lambda video_bytes, _crop: video_bytes,
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


def test_hidden_pipeline_controls_are_resolved_authoritatively():
    rules = {
        "version": 3,
        "pipeline": [
            {
                "id": "mask_processing",
                "kind": "mask_processing",
                "targets": [],
                "controls": [
                    {
                        "key": "source_video_treatment",
                        "value_type": "enum",
                        "expose": "none",
                        "source": "backend",
                        "default": "fill_transparent_with_neutral_gray",
                        "exclude_options": ["preserve_transparency"],
                        "default_rules": [
                            {
                                "when": {
                                    "ref": {
                                        "kind": "workflow_param",
                                        "node_id": "92",
                                        "param": "denoise",
                                    },
                                    "operator": "lt",
                                    "value": 1,
                                },
                                "value": "remove_transparency",
                            }
                        ],
                    }
                ],
            }
        ]
    }
    resolved, warnings = resolve_pipeline_control_values_with_warnings(
        rules,
        workflow={"92": {"inputs": {"denoise": 0.5}}},
        pipeline_inputs={
            "mask_processing": {
                "source_video_treatment": "fill_transparent_with_neutral_gray",
            }
        },
        control_option_fallbacks={
            ("mask_processing", "source_video_treatment"): [
                "preserve_transparency",
                "fill_transparent_with_neutral_gray",
                "remove_transparency",
            ]
        },
    )

    assert resolved["mask_processing"]["source_video_treatment"] == "remove_transparency"
    assert any(
        warning["code"] == "ignored_pipeline_control_submission"
        for warning in warnings
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


def test_normalize_rules_model_normalizes_legacy_source_video_treatment_aliases():
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
                            "key": "source_video_treatment",
                            "value_type": "enum",
                            "default": "keep transparency",
                            "options": [
                                "keep transparency",
                                "remove transparency",
                            ],
                        }
                    ],
                }
            ],
        }
    )

    mask_stage = get_pipeline_stage(rules_model, "mask_processing")
    assert mask_stage is not None
    control = next(
        control for control in mask_stage.controls if control.key == "source_video_treatment"
    )
    assert control.default == "preserve_transparency"
    assert control.options == ["preserve_transparency", "remove_transparency"]
    assert any(
        warning.code == "normalized_source_video_treatment_value"
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
