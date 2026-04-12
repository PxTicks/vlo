import json
import os
import random
import sys
from pathlib import Path
from tempfile import SpooledTemporaryFile
from typing import Any, BinaryIO, cast

import pytest
from starlette.datastructures import FormData, Headers, UploadFile
from starlette.requests import Request

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routers import comfyui  # noqa: E402
from services.gen_pipeline.processors.utils.aspect_ratio_processing import (  # noqa: E402
    apply_aspect_ratio_processing,
    derive_true_dimensions_from_short_edge,
    find_best_strided_dimensions,
)
from services.workflow_rules import (  # noqa: E402
    AuthoredWorkflowRulesV1,
    apply_rules_to_workflow,
    collect_mask_crop_pairs,
    evaluate_input_validation,
    enrich_rules_with_object_info,
    find_unsatisfied_input_conditions,
    load_rules_model_for_workflow,
    load_rules_for_workflow,
    migrate_authored_v1_to_v2,
    normalize_rules_model,
)
from services.workflow_rules.object_info import set_object_info_cache  # noqa: E402
from services.workflow_rules import object_info as workflow_object_info  # noqa: E402
from services.workflow_rules.schema import (  # noqa: E402
    ResolvedWorkflowRules,
    compile_authored_v1_to_resolved,
    compile_authored_v2_to_resolved,
    dump_resolved_rules,
)


def _base_prompt() -> dict:
    return {
        "1": {"class_type": "SourceA", "inputs": {}},
        "2": {"class_type": "ConsumerA", "inputs": {"input": ["1", 0]}},
        "9": {"class_type": "SourceB", "inputs": {}},
    }


def test_load_rules_for_workflow_without_sidecar(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")
    assert warnings == []
    assert rules["version"] == 1
    assert rules["nodes"] == {}
    assert rules["output_injections"] == {}
    assert rules["mask_cropping"] == {"mode": "crop"}
    assert rules["postprocessing"] == {
        "mode": "auto",
        "panel_preview": "raw_outputs",
        "on_failure": "fallback_raw",
    }
    assert rules["aspect_ratio_processing"] == {
        "enabled": True,
        "stride": 16,
        "search_steps": 2,
        "resolutions": [],
        "target_nodes": [],
        "postprocess": {
            "enabled": True,
            "mode": "stretch_exact",
            "apply_to": "all_visual_outputs",
        },
    }


def test_load_rules_for_workflow_malformed_sidecar(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text("{this is not valid json")

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")
    assert rules["nodes"] == {}
    assert rules["mask_cropping"] == {"mode": "crop"}
    assert any(w["code"] == "invalid_rules_json" for w in warnings)
    assert rules["postprocessing"] == {
        "mode": "auto",
        "panel_preview": "raw_outputs",
        "on_failure": "fallback_raw",
    }


def test_load_rules_for_workflow_normalizes_postprocessing(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "postprocessing": {
                    "mode": "stitch_frames_with_audio",
                    "panel_preview": "replace_outputs",
                    "on_failure": "show_error",
                    "stitch_fps": 24,
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")
    assert warnings == []
    assert rules["postprocessing"] == {
        "mode": "stitch_frames_with_audio",
        "panel_preview": "replace_outputs",
        "on_failure": "show_error",
        "stitch_fps": 24,
    }


def test_load_rules_for_workflow_reports_invalid_postprocessing(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "postprocessing": {
                    "mode": "bad_mode",
                    "panel_preview": "bad_preview",
                    "on_failure": 42,
                    "stitch_fps": "bad",
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")
    assert rules["postprocessing"] == {
        "mode": "auto",
        "panel_preview": "raw_outputs",
        "on_failure": "fallback_raw",
    }


def test_load_rules_for_workflow_normalizes_node_selection(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "98": {
                        "selection": {
                            "export_fps": 16,
                            "frame_step": 4,
                            "max_frames": 81,
                        }
                    }
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")

    assert warnings == []
    assert rules["nodes"]["98"]["selection"] == {
        "export_fps": 16,
        "frame_step": 4,
        "max_frames": 81,
    }


def test_load_rules_for_workflow_preserves_present_group_metadata(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "62": {
                        "present": {
                            "label": "Start frame",
                            "group_id": "frames",
                            "group_title": "Frames",
                            "group_order": 0,
                        }
                    }
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")

    assert warnings == []
    assert rules["nodes"]["62"]["present"] == {
        "label": "Start frame",
        "group_id": "frames",
        "group_title": "Frames",
        "group_order": 0,
    }


def test_load_rules_for_workflow_normalizes_slot_selection_config(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "slots": {
                    "control_frames": {
                        "input_type": "frame_batch",
                        "export_fps": 16,
                        "frame_step": 4,
                        "max_frames": 81,
                    }
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")
    assert warnings == []
    assert rules["slots"]["control_frames"]["export_fps"] == 16
    assert rules["slots"]["control_frames"]["frame_step"] == 4
    assert rules["slots"]["control_frames"]["max_frames"] == 81


def test_load_rules_for_workflow_reports_invalid_slot_selection_config(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "slots": {
                    "control_frames": {
                        "input_type": "frame_batch",
                        "export_fps": 0,
                        "frame_step": -2,
                        "max_frames": "abc",
                    }
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")
    assert "export_fps" not in rules["slots"]["control_frames"]
    assert "frame_step" not in rules["slots"]["control_frames"]
    assert "max_frames" not in rules["slots"]["control_frames"]
    assert any(w["code"] == "invalid_slot_export_fps" for w in warnings)
    assert any(w["code"] == "invalid_slot_frame_step" for w in warnings)
    assert any(w["code"] == "invalid_slot_max_frames" for w in warnings)


def test_load_rules_for_workflow_preserves_frontend_only_widget_metadata(
    tmp_path: Path,
):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "1": {
                        "widgets": {
                            "__derived_mask_video_treatment": {
                                "label": "Transparency handling",
                                "value_type": "enum",
                                "options": [
                                    "Keep transparency",
                                    "Fill transparent with neutral gray",
                                    "Remove transparency",
                                ],
                                "default": "Keep transparency",
                                "frontend_only": True,
                            }
                        }
                    }
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")

    assert warnings == []
    assert (
        rules["nodes"]["1"]["widgets"]["__derived_mask_video_treatment"][
            "frontend_only"
        ]
        is True
    )


def test_load_rules_for_workflow_normalizes_derived_widgets_and_hidden_widgets(
    tmp_path: Path,
):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "145": {
                        "widgets": {
                            "start_step": {
                                "value_type": "int",
                                "hidden": True,
                            },
                            "split_step": {
                                "value_type": "int",
                                "hidden": True,
                            },
                        }
                    }
                },
                "derived_widgets": [
                    {
                        "id": "denoise",
                        "kind": "dual_sampler_denoise",
                        "label": "Denoise",
                        "total_steps": {"node_id": "145", "param": "steps"},
                        "start_step": {"node_id": "145", "param": "start_step"},
                        "base_split_step": {
                            "node_id": "145",
                            "param": "split_step",
                        },
                        "split_step_targets": [
                            {"node_id": "145", "param": "split_step"},
                            {"node_id": "146", "param": "start_at_step"},
                        ],
                    }
                ],
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")

    assert warnings == []
    assert rules["nodes"]["145"]["widgets"]["start_step"]["hidden"] is True
    assert rules["derived_widgets"] == [
        {
            "id": "denoise",
            "kind": "dual_sampler_denoise",
            "label": "Denoise",
            "total_steps": {"node_id": "145", "param": "steps"},
            "start_step": {"node_id": "145", "param": "start_step"},
            "base_split_step": {"node_id": "145", "param": "split_step"},
            "split_step_targets": [
                {"node_id": "145", "param": "split_step"},
                {"node_id": "146", "param": "start_at_step"},
            ],
        }
    ]


def test_enrich_rules_with_object_info_groups_proxy_widgets_under_parent_template():
    workflow = {
        "nodes": [
            {
                "id": 267,
                "type": "template-subgraph-id",
                "properties": {
                    "proxyWidgets": [
                        ["257", "value"],
                        ["258", "value"],
                    ]
                },
            }
        ],
        "definitions": {
            "subgraphs": [
                {
                    "id": "template-subgraph-id",
                    "name": "Video Generation (LTX-2.3)",
                    "nodes": [
                        {
                            "id": 257,
                            "type": "PrimitiveInt",
                            "title": "Width",
                            "widgets_values": [1280, "fixed"],
                        },
                        {
                            "id": 258,
                            "type": "PrimitiveInt",
                            "title": "Height",
                            "widgets_values": [720, "fixed"],
                        },
                    ],
                }
            ]
        },
    }
    rules = {
        "version": 1,
        "nodes": {},
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "PrimitiveInt": {
            "input": {
                "required": {
                    "value": [
                        "INT",
                        {
                            "control_after_generate": True,
                        },
                    ]
                }
            },
            "input_order": {
                "required": ["value"],
            },
        }
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    width_widget = rules["nodes"]["267:257"]["widgets"]["value"]
    height_widget = rules["nodes"]["267:258"]["widgets"]["value"]

    assert width_widget["label"] == "Width"
    assert width_widget["group_id"] == "267"
    assert width_widget["group_title"] == "Video Generation (LTX-2.3)"
    assert width_widget["group_order"] == 0

    assert height_widget["label"] == "Height"
    assert height_widget["group_id"] == "267"
    assert height_widget["group_title"] == "Video Generation (LTX-2.3)"
    assert height_widget["group_order"] == 1


def test_enrich_rules_with_object_info_auto_discovers_ltx_ar_target_from_subgraph():
    workflow = {
        "nodes": [
            {
                "id": 267,
                "type": "template-subgraph-id",
                "properties": {
                    "proxyWidgets": [
                        ["257", "value"],
                        ["258", "value"],
                    ]
                },
            }
        ],
        "definitions": {
            "subgraphs": [
                {
                    "id": "template-subgraph-id",
                    "name": "Video Generation (LTX-2.3)",
                    "nodes": [
                        {
                            "id": 228,
                            "type": "EmptyLTXVLatentVideo",
                            "widgets_values": [768, 512, 97, 1],
                        },
                        {
                            "id": 257,
                            "type": "PrimitiveInt",
                            "title": "Width",
                            "widgets_values": [1280, "fixed"],
                        },
                        {
                            "id": 258,
                            "type": "PrimitiveInt",
                            "title": "Height",
                            "widgets_values": [720, "fixed"],
                        },
                    ],
                }
            ]
        },
    }
    rules = {
        "version": 1,
        "nodes": {},
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
        "aspect_ratio_processing": {
            "enabled": True,
            "stride": 16,
            "search_steps": 2,
            "resolutions": [],
            "target_nodes": [],
            "postprocess": {
                "enabled": True,
                "mode": "stretch_exact",
                "apply_to": "all_visual_outputs",
            },
        },
    }
    object_info = {
        "EmptyLTXVLatentVideo": {
            "input": {
                "required": {
                    "width": ["INT", {}],
                    "height": ["INT", {}],
                    "length": ["INT", {}],
                }
            },
            "input_order": {
                "required": ["width", "height", "length"],
            },
        },
        "PrimitiveInt": {
            "input": {
                "required": {
                    "value": [
                        "INT",
                        {
                            "control_after_generate": True,
                        },
                    ]
                }
            },
            "input_order": {
                "required": ["value"],
            },
        },
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    assert rules["aspect_ratio_processing"]["target_nodes"] == [
        {
            "node_id": "267:228",
            "width_param": "width",
            "height_param": "height",
        }
    ]


def test_enrich_rules_with_object_info_respects_disabled_default_ar_processing():
    workflow = {
        "nodes": [
            {
                "id": 267,
                "type": "template-subgraph-id",
            }
        ],
        "definitions": {
            "subgraphs": [
                {
                    "id": "template-subgraph-id",
                    "nodes": [
                        {
                            "id": 228,
                            "type": "EmptyLTXVLatentVideo",
                            "widgets_values": [768, 512, 97, 1],
                        },
                    ],
                }
            ]
        },
    }
    rules = {
        "version": 1,
        "nodes": {},
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
        "aspect_ratio_processing": {
            "enabled": False,
            "stride": 16,
            "search_steps": 2,
            "resolutions": [],
            "target_nodes": [],
            "postprocess": {
                "enabled": True,
                "mode": "stretch_exact",
                "apply_to": "all_visual_outputs",
            },
        },
    }
    object_info = {
        "EmptyLTXVLatentVideo": {
            "input": {
                "required": {
                    "width": ["INT", {}],
                    "height": ["INT", {}],
                    "length": ["INT", {}],
                }
            },
            "input_order": {
                "required": ["width", "height", "length"],
            },
        }
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    assert rules["aspect_ratio_processing"]["enabled"] is False
    assert rules["aspect_ratio_processing"]["target_nodes"] == []


def test_enrich_rules_with_object_info_auto_discovers_required_validation_for_media_inputs_only():
    workflow = {
        "nodes": [
            {"id": 10, "type": "ImageUploadNode", "title": "Image Upload"},
            {"id": 11, "type": "VideoUploadNode", "title": "Video Upload"},
            {"id": 12, "type": "AudioUploadNode", "title": "Audio Upload"},
            {"id": 13, "type": "PromptNode", "title": "Prompt"},
        ]
    }
    rules = {
        "version": 1,
        "nodes": {},
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "ImageUploadNode": {
            "input": {
                "required": {
                    "image": [["example.png"], {"image_upload": True}],
                }
            },
            "input_order": {"required": ["image"]},
        },
        "VideoUploadNode": {
            "input": {
                "required": {
                    "video": ["STRING", {"video_upload": True}],
                }
            },
            "input_order": {"required": ["video"]},
        },
        "AudioUploadNode": {
            "input": {
                "required": {
                    "audio": [["example.wav"], {"audio_upload": True}],
                }
            },
            "input_order": {"required": ["audio"]},
        },
        "PromptNode": {
            "input": {
                "required": {
                    "text": ["STRING", {"dynamicPrompts": True}],
                }
            },
            "input_order": {"required": ["text"]},
        },
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    assert rules["validation"]["inputs"] == [
        {"kind": "required", "input": "10", "message": "Image is required."},
        {"kind": "required", "input": "11", "message": "Video is required."},
        {"kind": "required", "input": "12", "message": "Audio is required."},
    ]
    failures = evaluate_input_validation(rules, set())
    assert failures == [
        {
            "kind": "required",
            "input": "10",
            "message": "Image is required.",
        },
        {
            "kind": "required",
            "input": "11",
            "message": "Video is required.",
        },
        {
            "kind": "required",
            "input": "12",
            "message": "Audio is required.",
        },
    ]


def test_parse_workflow_inputs_includes_load_audio_by_default():
    set_object_info_cache({})
    try:
        inputs = comfyui._parse_workflow_inputs(
            {
                "145": {
                    "class_type": "LoadAudio",
                    "inputs": {"audio": "default.wav"},
                }
            }
        )
    finally:
        set_object_info_cache(None)

    assert inputs == [
        {
            "id": "145:audio",
            "nodeId": "145",
            "classType": "LoadAudio",
            "inputType": "audio",
            "param": "audio",
            "label": "LoadAudio",
            "description": None,
            "currentValue": "default.wav",
        }
    ]


def test_enrich_rules_with_object_info_uses_param_specific_required_validation_for_multi_input_nodes():
    workflow = {
        "nodes": [
            {"id": 20, "type": "DualImageInputNode", "title": "Dual Image Input"},
        ]
    }
    rules = {
        "version": 1,
        "nodes": {},
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "DualImageInputNode": {
            "input": {
                "required": {
                    "start_image": [["start.png"], {"image_upload": True}],
                    "end_image": [["end.png"], {"image_upload": True}],
                }
            },
            "input_order": {"required": ["start_image", "end_image"]},
        }
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    assert rules["validation"]["inputs"] == [
        {
            "kind": "required",
            "input": "20:start_image",
            "message": "Start Image is required.",
        },
        {
            "kind": "required",
            "input": "20:end_image",
            "message": "End Image is required.",
        },
    ]


def test_enrich_rules_with_object_info_skips_default_required_validation_for_optional_sidecar_inputs():
    workflow = {
        "nodes": [
            {"id": 10, "type": "ImageUploadNode", "title": "Image Upload"},
        ]
    }
    rules = {
        "version": 1,
        "nodes": {
            "10": {
                "present": {
                    "required": False,
                }
            }
        },
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "ImageUploadNode": {
            "input": {
                "required": {
                    "image": [["example.png"], {"image_upload": True}],
                }
            },
            "input_order": {"required": ["image"]},
        }
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    assert rules["validation"]["inputs"] == []


def test_real_wan_default_workflow_sidecar_waives_default_required_inputs():
    base = Path(__file__).resolve().parents[1] / "assets" / ".config" / "default_workflows"
    workflow_path = base / "wan2_2_flf2v.json"
    workflow = json.loads(workflow_path.read_text(encoding="utf-8"))

    set_object_info_cache(None)
    try:
        rules_model, warnings = load_rules_model_for_workflow(base, workflow_path.name)
        assert warnings == []
        rules_model = enrich_rules_with_object_info(rules_model, workflow)
        rules = dump_resolved_rules(rules_model)
    finally:
        set_object_info_cache(None)

    validation_inputs = rules["validation"]["inputs"]
    assert {
        "kind": "at_least_n",
        "inputs": ["62", "68"],
        "min": 1,
        "message": "Provide at least one frame input.",
    } in validation_inputs
    assert not any(
        rule.get("kind") == "required" and rule.get("input") in {"62", "68"}
        for rule in validation_inputs
        if isinstance(rule, dict)
    )


def test_real_ltx_flf2v_core_workflow_exposes_optional_custom_audio():
    base = Path(__file__).resolve().parents[1] / "assets" / ".config" / "default_workflows"
    workflow_path = base / "video_ltx2_3_flf2v.json"
    workflow = json.loads(workflow_path.read_text(encoding="utf-8"))

    set_object_info_cache(None)
    try:
        rules_model, warnings = load_rules_model_for_workflow(base, workflow_path.name)
        assert warnings == []
        rules_model = enrich_rules_with_object_info(rules_model, workflow)
        rules = dump_resolved_rules(rules_model)
    finally:
        set_object_info_cache(None)

    assert rules["name"] == "LTX2.3 FLF2V"
    assert rules["nodes"]["14"]["widgets"]["noise_seed"] == {
        "label": "Upscale noise seed",
        "control_after_generate": True,
        "hidden": True,
        "value_type": "int",
        "min": 0,
        "max": 18446744073709551615,
        "default": 0,
    }
    assert rules["nodes"]["15"]["widgets"]["noise_seed"] == {
        "label": "Noise seed",
        "control_after_generate": True,
        "value_type": "int",
        "group_id": "video_generation",
        "group_title": "Video Generation",
        "group_order": 0,
        "min": 0,
        "max": 18446744073709551615,
        "default": 0,
    }
    assert rules["nodes"]["232"]["present"] == {
        "label": "Custom audio (optional)",
        "group_id": "audio",
        "group_title": "Audio",
        "group_order": 0,
        "required": False,
    }
    assert rules["nodes"]["239"]["widgets"]["switch"] == {
        "label": "Voice only",
        "control_after_generate": False,
        "value_type": "boolean",
        "default": False,
        "group_id": "audio",
        "group_title": "Audio",
        "group_order": 1,
    }

    validation_inputs = rules["validation"]["inputs"]
    assert {
        "kind": "at_least_n",
        "inputs": ["45", "47"],
        "min": 1,
        "message": "Provide at least one frame input.",
    } in validation_inputs
    assert not any(
        rule.get("kind") == "required" and rule.get("input") in {"45", "47", "232"}
        for rule in validation_inputs
        if isinstance(rule, dict)
    )


def test_real_ltx_i2v_default_workflow_hides_t2v_toggle_and_waives_image_requirement():
    base = Path(__file__).resolve().parents[1] / "assets" / ".config" / "default_workflows"
    workflow_path = base / "video_ltx2_3_i2v.json"
    workflow = json.loads(workflow_path.read_text(encoding="utf-8"))

    set_object_info_cache(None)
    try:
        rules_model, warnings = load_rules_model_for_workflow(base, workflow_path.name)
        assert warnings == []
        rules_model = enrich_rules_with_object_info(rules_model, workflow)
        rules = dump_resolved_rules(rules_model)
    finally:
        set_object_info_cache(None)

    assert rules["name"] == "LTX2.3 I2V / T2V"
    assert rules["nodes"]["269"]["present"] == {
        "required": False,
        "label": "Source image",
    }
    assert rules["nodes"]["267"]["widgets"]["value_1"] == {
        "control_after_generate": False,
        "value_type": "boolean",
        "hidden": True,
        "default_overrides": [
            {
                "when": {
                    "kind": "input_presence",
                    "inputs": ["269"],
                    "match": "all_missing",
                },
                "value": True,
            },
            {
                "when": {
                    "kind": "input_presence",
                    "inputs": ["269"],
                    "match": "all_present",
                },
                "value": False,
            },
        ],
    }
    assert rules["nodes"]["267:201"]["widgets"]["value"] == {
        "label": "Text to Video",
        "control_after_generate": False,
        "value_type": "boolean",
        "hidden": True,
    }
    assert rules["validation"]["inputs"] == []


def test_real_ltx_basic_i2v_core_workflow_exposes_optional_image_and_auto_toggles_t2v():
    base = Path(__file__).resolve().parents[1] / "assets" / ".config" / "default_workflows"
    workflow_path = base / "video_ltx2_3_i2v_t2v_basic.json"
    workflow = json.loads(workflow_path.read_text(encoding="utf-8"))

    set_object_info_cache(None)
    try:
        rules_model, warnings = load_rules_model_for_workflow(base, workflow_path.name)
        assert warnings == []
        rules_model = enrich_rules_with_object_info(rules_model, workflow)
        rules = dump_resolved_rules(rules_model)
    finally:
        set_object_info_cache(None)

    assert rules["name"] == "LTX2.3 Basic I2V / T2V"
    assert rules["nodes"]["114"]["widgets"]["noise_seed"] == {
        "label": "Upscale noise seed",
        "control_after_generate": True,
        "hidden": True,
        "value_type": "int",
        "min": 0,
        "max": 18446744073709551615,
        "default": 0,
    }
    assert rules["nodes"]["115"]["widgets"]["noise_seed"] == {
        "label": "Noise seed",
        "control_after_generate": True,
        "value_type": "int",
        "group_id": "video_generation",
        "group_title": "Video Generation",
        "group_order": 3,
        "min": 0,
        "max": 18446744073709551615,
        "default": 0,
    }
    assert rules["nodes"]["167"]["present"] == {
        "label": "Source image",
        "required": False,
    }
    assert rules["nodes"]["290"]["widgets"]["value"] == {
        "label": "Text to Video",
        "control_after_generate": False,
        "value_type": "boolean",
        "hidden": True,
        "default_overrides": [
            {
                "when": {
                    "kind": "input_presence",
                    "inputs": ["167"],
                    "match": "all_missing",
                },
                "value": True,
            },
            {
                "when": {
                    "kind": "input_presence",
                    "inputs": ["167"],
                    "match": "all_present",
                },
                "value": False,
            },
        ],
    }
    assert rules["nodes"]["160"]["ignore_overrides"] == [
        {
            "when": {
                "kind": "input_presence",
                "inputs": ["167"],
                "match": "all_missing",
            },
            "value": True,
        }
    ]
    assert rules["nodes"]["349"]["widgets"]["sampling_mode"] == {
        "label": "Enable prompt enhancer",
        "control_after_generate": False,
        "default": False,
        "false_value": "off",
        "group_id": "prompt",
        "group_order": 0,
        "group_title": "Prompt",
        "true_value": "on",
        "value_type": "boolean",
    }
    assert rules["nodes"]["349"]["ignore_overrides"] == [
        {
            "when": {
                "kind": "input_presence",
                "inputs": ["167"],
                "match": "all_missing",
            },
            "value": True,
        }
    ]
    assert rules["nodes"]["291"]["widgets"]["value"] == {
        "label": "Duration",
        "control_after_generate": False,
        "control": "slider",
        "slider_display": "number",
        "unit": "s",
        "group_id": "video_generation",
        "group_title": "Video Generation",
        "group_order": 0,
        "min": 0.3333333333,
        "max": 20,
        "step": 0.3333333333,
        "value_type": "float",
    }
    assert rules["nodes"]["292"]["widgets"]["value"] == {
        "label": "Width",
        "control_after_generate": False,
        "hidden": True,
        "group_id": "video_generation",
        "group_title": "Video Generation",
        "group_order": 1,
        "min": -18446744073709551615,
        "max": 18446744073709551615,
        "default": 0,
        "value_type": "int",
    }
    assert rules["nodes"]["293"]["widgets"]["value"] == {
        "label": "Height",
        "control_after_generate": False,
        "hidden": True,
        "group_id": "video_generation",
        "group_title": "Video Generation",
        "group_order": 2,
        "min": -18446744073709551615,
        "max": 18446744073709551615,
        "default": 0,
        "value_type": "int",
    }
    assert rules["aspect_ratio_processing"]["enabled"] is True
    assert rules["aspect_ratio_processing"]["stride"] == 32
    assert rules["aspect_ratio_processing"]["search_steps"] == 2
    assert rules["aspect_ratio_processing"]["resolutions"] == [480, 720, 1080]
    assert {
        "width": {
            "node_id": "292",
            "param": "value",
        },
        "height": {
            "node_id": "293",
            "param": "value",
        },
    } in rules["aspect_ratio_processing"]["target_nodes"]
    assert rules["aspect_ratio_processing"]["postprocess"] == {
        "enabled": True,
        "mode": "stretch_exact",
        "apply_to": "all_visual_outputs",
    }
    assert rules["output_injections"]["160"]["0"] == {
        "source": {
            "kind": "node_output",
            "node_id": "118",
            "output_index": 0,
        },
        "when": {
            "kind": "input_presence",
            "inputs": ["167"],
            "match": "all_missing",
        },
    }
    assert rules["output_injections"]["349"]["0"] == {
        "source": {
            "kind": "node_output",
            "node_id": "352",
            "output_index": 0,
        },
        "when": {
            "kind": "input_presence",
            "inputs": ["167"],
            "match": "all_missing",
        },
    }
    assert rules["validation"]["inputs"] == [
        {
            "kind": "optional",
            "input": "167",
        }
    ]


def test_real_ltx_basic_i2v_core_workflow_prunes_missing_source_image_and_flips_t2v():
    base = Path(__file__).resolve().parents[1] / "assets" / ".config" / "default_workflows"
    rules_path = base / "video_ltx2_3_i2v_t2v_basic.rules.json"
    rules = json.loads(rules_path.read_text(encoding="utf-8"))

    workflow = {
        "167": {
            "class_type": "LoadImage",
            "inputs": {"image": "egyptian_queen.png"},
        },
        "290": {
            "class_type": "PrimitiveBoolean",
            "inputs": {"value": False},
        },
        "999": {
            "class_type": "Consumer",
            "inputs": {
                "image": ["167", 0],
                "text_to_video": ["290", 0],
            },
        },
    }

    rewritten, warnings = apply_rules_to_workflow(
        workflow,
        rules,
        provided_input_ids=set(),
    )

    assert all(
        warning["code"] in {"ignored_node_missing", "injection_target_missing"}
        for warning in warnings
    )
    assert "167" not in rewritten
    assert rewritten["290"]["inputs"]["value"] is True
    assert "image" not in rewritten["999"]["inputs"]
    assert rewritten["999"]["inputs"]["text_to_video"] == ["290", 0]


def test_real_ltx_basic_i2v_core_workflow_rewrites_full_t2v_branch_when_image_missing():
    base = Path(__file__).resolve().parents[1] / "assets" / ".config" / "default_workflows"
    rules_path = base / "video_ltx2_3_i2v_t2v_basic.rules.json"
    rules = json.loads(rules_path.read_text(encoding="utf-8"))

    workflow = {
        "108": {
            "class_type": "EmptyLTXVLatentVideo",
            "inputs": {
                "width": ["236", 0],
                "height": ["237", 0],
            },
        },
        "109": {
            "class_type": "LTXVConcatAVLatent",
            "inputs": {"video_latent": ["161", 0]},
        },
        "117": {
            "class_type": "LTXVConcatAVLatent",
            "inputs": {"video_latent": ["160", 0]},
        },
        "118": {"class_type": "LTXVLatentUpsampler", "inputs": {}},
        "121": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": ["349", 0]},
        },
        "160": {
            "class_type": "LTXVImgToVideoInplace",
            "inputs": {
                "image": ["212", 0],
                "latent": ["118", 0],
            },
        },
        "161": {
            "class_type": "LTXVImgToVideoInplace",
            "inputs": {
                "image": ["162", 0],
                "latent": ["108", 0],
            },
        },
        "162": {
            "class_type": "LTXVPreprocess",
            "inputs": {"image": ["210", 0]},
        },
        "165": {
            "class_type": "ImageResizeKJv2",
            "inputs": {
                "image": ["167", 0],
                "width": ["243", 0],
                "height": ["244", 0],
            },
        },
        "167": {"class_type": "LoadImage", "inputs": {"image": "egyptian_queen.png"}},
        "209": {"class_type": "SetNode", "inputs": {"IMAGE": ["246", 0]}},
        "210": {"class_type": "GetNode", "inputs": {}},
        "211": {"class_type": "SetNode", "inputs": {"IMAGE": ["162", 0]}},
        "212": {"class_type": "GetNode", "inputs": {}},
        "233": {"class_type": "SetNode", "inputs": {"INT": ["163", 0]}},
        "234": {"class_type": "SetNode", "inputs": {"INT": ["163", 1]}},
        "236": {"class_type": "GetNode", "inputs": {}},
        "237": {"class_type": "GetNode", "inputs": {}},
        "243": {"class_type": "GetNode", "inputs": {}},
        "244": {"class_type": "GetNode", "inputs": {}},
        "246": {
            "class_type": "ResizeImagesByLongerEdge",
            "inputs": {"images": ["165", 0]},
        },
        "248": {"class_type": "SetNode", "inputs": {"IMAGE": ["164", 0]}},
        "290": {"class_type": "PrimitiveBoolean", "inputs": {"value": False}},
        "349": {
            "class_type": "TextGenerateLTX2Prompt",
            "inputs": {
                "image": ["165", 0],
                "prompt": ["352", 0],
            },
        },
        "352": {"class_type": "PrimitiveStringMultiline", "inputs": {}},
        "163": {"class_type": "GetImageSize", "inputs": {"image": ["164", 0]}},
        "164": {
            "class_type": "ResizeImageMaskNode",
            "inputs": {"input": ["165", 0]},
        },
    }

    rewritten, warnings = apply_rules_to_workflow(
        workflow,
        rules,
        provided_input_ids=set(),
    )

    assert warnings == []
    assert rewritten["290"]["inputs"]["value"] is True
    assert rewritten["121"]["inputs"]["text"] == ["352", 0]
    assert rewritten["108"]["inputs"]["width"] == ["243", 0]
    assert rewritten["108"]["inputs"]["height"] == ["244", 0]
    assert rewritten["109"]["inputs"]["video_latent"] == ["108", 0]
    assert rewritten["117"]["inputs"]["video_latent"] == ["118", 0]
    for node_id in (
        "160",
        "161",
        "162",
        "163",
        "164",
        "165",
        "167",
        "209",
        "210",
        "211",
        "212",
        "233",
        "234",
        "246",
        "248",
        "349",
    ):
        assert node_id not in rewritten


def test_core_ltx_workflows_do_not_include_gguf_or_debug_only_nodes():
    base = Path(__file__).resolve().parents[1] / "assets" / ".config" / "default_workflows"

    basic_workflow = json.loads(
        (base / "video_ltx2_3_i2v_t2v_basic.json").read_text(encoding="utf-8")
    )
    basic_types = {
        node.get("type")
        for node in basic_workflow.get("nodes", [])
        if isinstance(node, dict)
    }
    assert "UnetLoaderGGUF" not in basic_types
    assert "DualCLIPLoaderGGUF" not in basic_types
    assert "easy showAnything" not in basic_types
    assert "Power Lora Loader (rgthree)" not in basic_types

    flf_workflow = json.loads(
        (base / "video_ltx2_3_flf2v.json").read_text(encoding="utf-8")
    )
    flf_types = {
        node.get("type")
        for node in flf_workflow.get("nodes", [])
        if isinstance(node, dict)
    }
    assert "UnetLoaderGGUF" not in flf_types
    assert "DualCLIPLoaderGGUF" not in flf_types


def test_real_video_wan_default_workflow_sidecar_requires_video_and_derives_denoise():
    base = Path(__file__).resolve().parents[1] / "assets" / ".config" / "default_workflows"
    workflow_path = base / "video_wan2_2_14B_flfv2v_vlo.json"
    workflow = json.loads(workflow_path.read_text(encoding="utf-8"))

    set_object_info_cache(None)
    try:
        rules_model, warnings = load_rules_model_for_workflow(base, workflow_path.name)
        assert warnings == []
        rules_model = enrich_rules_with_object_info(rules_model, workflow)
        rules = dump_resolved_rules(rules_model)
    finally:
        set_object_info_cache(None)

    assert rules["name"] == "Wan2.2 FLFV2V"
    assert rules["derived_widgets"] == [
        {
            "id": "dual_sampler_denoise",
            "kind": "dual_sampler_denoise",
            "label": "Denoise",
            "total_steps": {"node_id": "85", "param": "value"},
            "start_step": {"node_id": "57", "param": "start_at_step"},
            "base_split_step": {"node_id": "86", "param": "value"},
            "split_step_targets": [
                {"node_id": "57", "param": "end_at_step"},
                {"node_id": "58", "param": "start_at_step"},
            ],
        }
    ]

    validation_inputs = rules["validation"]["inputs"]
    assert {
        "kind": "at_least_n",
        "inputs": ["62", "68"],
        "min": 1,
        "message": "Provide at least one frame input.",
    } in validation_inputs
    assert {"kind": "required", "input": "89", "message": "Video is required."} in (
        validation_inputs
    )
    assert not any(
        rule.get("kind") == "required" and rule.get("input") in {"62", "68"}
        for rule in validation_inputs
        if isinstance(rule, dict)
    )

    sampler_widgets = rules["nodes"]["57"]["widgets"]
    assert "cfg" in sampler_widgets
    assert "noise_seed" in sampler_widgets
    assert sampler_widgets["start_at_step"]["hidden"] is True


def test_real_vace_inpaint_default_validation_requires_video_not_text():
    base = Path(__file__).resolve().parents[1] / "assets" / ".config" / "default_workflows"
    workflow_path = base / "vlo_VACE_inpaint.json"
    workflow = json.loads(workflow_path.read_text(encoding="utf-8"))

    set_object_info_cache(None)
    try:
        rules_model, warnings = load_rules_model_for_workflow(base, workflow_path.name)
        assert warnings == []
        rules_model = enrich_rules_with_object_info(rules_model, workflow)
        rules = dump_resolved_rules(rules_model)
    finally:
        set_object_info_cache(None)

    validation_inputs = rules["validation"]["inputs"]
    assert {"kind": "required", "input": "98", "message": "Video is required."} in validation_inputs
    assert not any(
        rule.get("kind") == "required" and rule.get("input") == "75"
        for rule in validation_inputs
        if isinstance(rule, dict)
    )


def test_real_vace_inpaint_discovers_seed_widget_for_ksampler():
    base = Path(__file__).resolve().parents[1] / "assets" / ".config" / "default_workflows"
    workflow_path = base / "vlo_VACE_inpaint.json"
    workflow = json.loads(workflow_path.read_text(encoding="utf-8"))

    set_object_info_cache(None)
    try:
        rules_model, warnings = load_rules_model_for_workflow(base, workflow_path.name)
        assert warnings == []
        rules_model = enrich_rules_with_object_info(rules_model, workflow)
        rules = dump_resolved_rules(rules_model)
    finally:
        set_object_info_cache(None)

    sampler_widgets = rules["nodes"]["92"]["widgets"]
    assert "cfg" in sampler_widgets
    assert "seed" in sampler_widgets
    assert sampler_widgets["seed"]["control_after_generate"] is True


def test_real_ltx_retake_rules_define_dual_masks_and_primary_seed():
    base = Path(__file__).resolve().parents[1] / "assets" / ".config" / "default_workflows"
    workflow_path = base / "video_ltx2_3_retake.json"
    workflow = json.loads(workflow_path.read_text(encoding="utf-8"))

    set_object_info_cache(None)
    try:
        rules_model, warnings = load_rules_model_for_workflow(base, workflow_path.name)
        assert warnings == []
        rules_model = enrich_rules_with_object_info(rules_model, workflow)
        rules = dump_resolved_rules(rules_model)
    finally:
        set_object_info_cache(None)

    assert rules["mask_cropping"]["mode"] == "crop"
    assert rules["nodes"]["689"]["binary_derived_mask_of"] == "644"
    assert rules["nodes"]["691"]["binary_audio_derived_mask_of"] == "644"
    assert rules["nodes"]["691"]["audio_derived_mask_fps"] == 25
    assert rules["nodes"]["644"]["present"]["input_type"] == "video"
    assert rules["nodes"]["644"]["present"]["param"] == "video"
    assert rules["nodes"]["644"].get("widgets", {}) == {}
    assert rules["nodes"]["626"]["present"]["enabled"] is False

    sampler_widgets = rules["nodes"]["115"]["widgets"]
    upscale_widgets = rules["nodes"]["243"]["widgets"]
    prompt_widgets = rules["nodes"]["594"]["widgets"]
    assert sampler_widgets["noise_seed"]["control_after_generate"] is True
    assert sampler_widgets["noise_seed"].get("hidden") is not True
    assert upscale_widgets["noise_seed"]["hidden"] is True
    assert prompt_widgets["value"]["default"] is False
    assert "661" not in rules["nodes"]
    assert "662" not in rules["nodes"]
    assert rules["name"] == "LTX2.3 ReTake"


def test_real_ltx_single_stage_discovers_resize_image_mask_node_as_ar_target():
    workflow_path = (
        Path(__file__).resolve().parents[2]
        / "LTX-2.3_T2V_I2V_Single_Stage_Distilled_Full.json"
    )
    workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
    rules = {
        "version": 1,
        "nodes": {},
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
        "aspect_ratio_processing": {
            "enabled": True,
            "stride": 16,
            "search_steps": 2,
            "resolutions": [],
            "target_nodes": [],
            "postprocess": {
                "enabled": True,
                "mode": "stretch_exact",
                "apply_to": "all_visual_outputs",
            },
        },
    }

    set_object_info_cache(None)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    assert {
        "node_id": "4981",
        "width_param": "resize_type.width",
        "height_param": "resize_type.height",
    } in rules["aspect_ratio_processing"]["target_nodes"]


def test_enrich_rules_with_object_info_auto_discovers_length_widget_for_video_nodes():
    workflow = {
        "nodes": [
            {
                "id": 67,
                "type": "WanFirstLastFrameToVideo",
                "title": "WanFirstLastFrameToVideo",
                "inputs": [
                    {
                        "name": "width",
                        "type": "INT",
                        "widget": {"name": "width"},
                        "link": None,
                    },
                    {
                        "name": "height",
                        "type": "INT",
                        "widget": {"name": "height"},
                        "link": None,
                    },
                    {
                        "name": "length",
                        "type": "INT",
                        "widget": {"name": "length"},
                        "link": None,
                    },
                ],
                "widgets_values": [832, 480, 81, 1],
            }
        ]
    }
    rules = {
        "version": 1,
        "nodes": {},
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "WanFirstLastFrameToVideo": {
            "input": {
                "required": {
                    "width": ["INT", {"default": 832, "min": 16, "max": 16384}],
                    "height": ["INT", {"default": 480, "min": 16, "max": 16384}],
                    "length": ["INT", {"default": 81, "min": 1, "max": 16384}],
                    "batch_size": ["INT", {"default": 1, "min": 1, "max": 4096}],
                },
            },
            "input_order": {
                "required": ["width", "height", "length", "batch_size"],
            },
            "output": ["CONDITIONING", "CONDITIONING", "LATENT"],
        }
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    assert rules["nodes"]["67"]["widgets"]["length"] == {
        "label": "Length",
        "control_after_generate": False,
        "value_type": "int",
        "min": 1,
        "max": 16384,
        "default": 81,
    }


def test_enrich_rules_with_object_info_auto_discovers_num_frames_as_length_widget():
    workflow = {
        "nodes": [
            {
                "id": 91,
                "type": "WanVideoImageToVideoEncode",
                "title": "WanVideoImageToVideoEncode",
                "inputs": [
                    {
                        "name": "width",
                        "type": "INT",
                        "widget": {"name": "width"},
                        "link": None,
                    },
                    {
                        "name": "height",
                        "type": "INT",
                        "widget": {"name": "height"},
                        "link": None,
                    },
                    {
                        "name": "num_frames",
                        "type": "INT",
                        "widget": {"name": "num_frames"},
                        "link": None,
                    },
                ],
                "widgets_values": [832, 480, 81],
            }
        ]
    }
    rules = {
        "version": 1,
        "nodes": {},
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "WanVideoImageToVideoEncode": {
            "input": {
                "required": {
                    "width": ["INT", {"default": 832, "min": 64, "max": 8096}],
                    "height": ["INT", {"default": 480, "min": 64, "max": 8096}],
                    "num_frames": [
                        "INT",
                        {"default": 81, "min": 1, "max": 10000},
                    ],
                },
            },
            "input_order": {
                "required": ["width", "height", "num_frames"],
            },
            "output": ["WANVIDIMAGE_EMBEDS"],
        }
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    assert rules["nodes"]["91"]["widgets"]["num_frames"] == {
        "label": "Length",
        "control_after_generate": False,
        "value_type": "int",
        "min": 1,
        "max": 10000,
        "default": 81,
    }


def test_enrich_rules_with_object_info_skips_linked_length_widget_targets():
    workflow = {
        "nodes": [
            {
                "id": 267,
                "type": "template-subgraph-id",
                "properties": {
                    "proxyWidgets": [
                        ["225", "value"],
                    ]
                },
            }
        ],
        "definitions": {
            "subgraphs": [
                {
                    "id": "template-subgraph-id",
                    "name": "Video Generation (LTX-2.3)",
                    "nodes": [
                        {
                            "id": 225,
                            "type": "PrimitiveInt",
                            "title": "Length",
                            "inputs": [
                                {
                                    "name": "value",
                                    "type": "INT",
                                    "widget": {"name": "value"},
                                    "link": None,
                                }
                            ],
                            "widgets_values": [121, "fixed"],
                        },
                        {
                            "id": 228,
                            "type": "EmptyLTXVLatentVideo",
                            "inputs": [
                                {
                                    "name": "width",
                                    "type": "INT",
                                    "widget": {"name": "width"},
                                    "link": None,
                                },
                                {
                                    "name": "height",
                                    "type": "INT",
                                    "widget": {"name": "height"},
                                    "link": None,
                                },
                                {
                                    "name": "length",
                                    "type": "INT",
                                    "widget": {"name": "length"},
                                    "link": 508,
                                },
                            ],
                            "widgets_values": [768, 512, 97, 1],
                        },
                    ],
                }
            ]
        },
    }
    rules = {
        "version": 1,
        "nodes": {},
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "PrimitiveInt": {
            "input": {
                "required": {
                    "value": ["INT", {"control_after_generate": True}],
                }
            },
            "input_order": {"required": ["value"]},
        },
        "EmptyLTXVLatentVideo": {
            "input": {
                "required": {
                    "width": ["INT", {"default": 768, "min": 64, "max": 16384}],
                    "height": ["INT", {"default": 512, "min": 64, "max": 16384}],
                    "length": ["INT", {"default": 97, "min": 1, "max": 16384}],
                    "batch_size": ["INT", {"default": 1, "min": 1, "max": 4096}],
                }
            },
            "input_order": {
                "required": ["width", "height", "length", "batch_size"],
            },
            "output": ["LATENT"],
        },
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    assert rules["nodes"]["267:225"]["widgets"]["value"]["label"] == "Length"
    assert rules["nodes"]["267:228"].get("widgets", {}) == {}


def test_enrich_rules_with_object_info_defaults_ksampler_to_cfg_and_seed():
    workflow = {
        "145": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 1,
                "steps": 20,
                "cfg": 7.5,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1,
                "model": ["1", 0],
                "positive": ["2", 0],
                "negative": ["3", 0],
                "latent_image": ["4", 0],
            },
            "_meta": {"title": "KSampler"},
        }
    }
    rules = {
        "version": 1,
        "nodes": {},
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "KSampler": {
            "input": {
                "required": {
                    "model": ["MODEL"],
                    "seed": ["INT", {"control_after_generate": True}],
                    "steps": ["INT", {}],
                    "cfg": ["FLOAT", {}],
                    "sampler_name": [["euler", "heun"], {}],
                    "scheduler": [["normal", "karras"], {}],
                    "positive": ["CONDITIONING"],
                    "negative": ["CONDITIONING"],
                    "latent_image": ["LATENT"],
                    "denoise": ["FLOAT", {"default": 1, "min": 0, "max": 1}],
                }
            },
            "input_order": {
                "required": [
                    "model",
                    "seed",
                    "steps",
                    "cfg",
                    "sampler_name",
                    "scheduler",
                    "positive",
                    "negative",
                    "latent_image",
                    "denoise",
                ]
            },
        }
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    widgets = rules["nodes"]["145"]["widgets"]
    assert list(widgets.keys()) == ["cfg", "seed"]
    assert widgets["cfg"]["value_type"] == "float"
    assert widgets["seed"]["control_after_generate"] is True


def test_enrich_rules_with_object_info_defaults_ksampler_advanced_to_cfg_and_noise_seed():
    workflow = {
        "145": {
            "class_type": "KSamplerAdvanced",
            "inputs": {
                "add_noise": "enable",
                "noise_seed": 2,
                "steps": 30,
                "cfg": 6.5,
                "sampler_name": "euler",
                "scheduler": "normal",
                "start_at_step": 0,
                "end_at_step": 30,
                "return_with_leftover_noise": "disable",
                "model": ["1", 0],
                "positive": ["2", 0],
                "negative": ["3", 0],
                "latent_image": ["4", 0],
            },
            "_meta": {"title": "KSampler Advanced"},
        }
    }
    rules = {
        "version": 1,
        "nodes": {},
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "KSamplerAdvanced": {
            "input": {
                "required": {
                    "model": ["MODEL"],
                    "add_noise": [["enable", "disable"], {}],
                    "noise_seed": ["INT", {"control_after_generate": True}],
                    "steps": ["INT", {}],
                    "cfg": ["FLOAT", {}],
                    "sampler_name": [["euler", "heun"], {}],
                    "scheduler": [["normal", "karras"], {}],
                    "positive": ["CONDITIONING"],
                    "negative": ["CONDITIONING"],
                    "latent_image": ["LATENT"],
                    "start_at_step": ["INT", {"min": 0}],
                    "end_at_step": ["INT", {"min": 0}],
                    "return_with_leftover_noise": [["enable", "disable"], {}],
                }
            },
            "input_order": {
                "required": [
                    "model",
                    "add_noise",
                    "noise_seed",
                    "steps",
                    "cfg",
                    "sampler_name",
                    "scheduler",
                    "positive",
                    "negative",
                    "latent_image",
                    "start_at_step",
                    "end_at_step",
                    "return_with_leftover_noise",
                ]
            },
        }
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    widgets = rules["nodes"]["145"]["widgets"]
    assert list(widgets.keys()) == ["cfg", "noise_seed"]
    assert widgets["cfg"]["value_type"] == "float"
    assert widgets["noise_seed"]["control_after_generate"] is True


def test_enrich_rules_with_object_info_always_discovers_seed_widgets_under_policy_overrides(
    monkeypatch,
):
    workflow = {
        "145": {
            "class_type": "CustomSampler",
            "inputs": {
                "seed": 1,
                "cfg": 7.5,
            },
            "_meta": {"title": "CustomSampler"},
        }
    }
    rules = {
        "version": 1,
        "nodes": {},
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "CustomSampler": {
            "input": {
                "required": {
                    "seed": ["INT", {"control_after_generate": True}],
                    "cfg": ["FLOAT", {}],
                }
            },
            "input_order": {
                "required": ["seed", "cfg"],
            },
        }
    }

    monkeypatch.setattr(
        workflow_object_info,
        "resolve_node_policy",
        lambda class_type, class_info, rules=None: (
            {"default_widget_params": ["cfg"]} if class_type == "CustomSampler" else {}
        ),
    )
    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    widgets = rules["nodes"]["145"]["widgets"]
    assert list(widgets.keys()) == ["cfg", "seed"]
    assert widgets["seed"]["control_after_generate"] is True


def test_enrich_rules_with_object_info_always_discovers_randomized_cag_widgets_under_policy_overrides(
    monkeypatch,
):
    workflow = {
        "nodes": [
            {
                "id": 145,
                "type": "CustomRandomizedNode",
                "title": "CustomRandomizedNode",
                "widgets_values": [5, "randomize", 7.5],
            }
        ]
    }
    rules = {
        "version": 1,
        "nodes": {},
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "CustomRandomizedNode": {
            "input": {
                "required": {
                    "strength": ["INT", {"control_after_generate": True}],
                    "cfg": ["FLOAT", {}],
                }
            },
            "input_order": {
                "required": ["strength", "cfg"],
            },
        }
    }

    monkeypatch.setattr(
        workflow_object_info,
        "resolve_node_policy",
        lambda class_type, class_info, rules=None: (
            {"default_widget_params": ["cfg"]}
            if class_type == "CustomRandomizedNode"
            else {}
        ),
    )
    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    widgets = rules["nodes"]["145"]["widgets"]
    assert list(widgets.keys()) == ["cfg", "strength"]
    assert widgets["strength"]["control_after_generate"] is True
    assert widgets["strength"]["default_randomize"] is True


def test_enrich_rules_with_object_info_appends_default_ksampler_advanced_widgets_to_sidecar_widgets():
    workflow = {
        "145": {
            "class_type": "KSamplerAdvanced",
            "inputs": {
                "add_noise": "enable",
                "noise_seed": 2,
                "steps": 30,
                "cfg": 6.5,
                "sampler_name": "euler",
                "scheduler": "normal",
                "start_at_step": 0,
                "end_at_step": 30,
                "return_with_leftover_noise": "disable",
                "model": ["1", 0],
                "positive": ["2", 0],
                "negative": ["3", 0],
                "latent_image": ["4", 0],
            },
            "_meta": {"title": "KSampler Advanced"},
        }
    }
    rules = {
        "version": 1,
        "nodes": {
            "145": {
                "widgets": {
                    "start_at_step": {
                        "value_type": "int",
                        "hidden": True,
                    },
                    "end_at_step": {
                        "value_type": "int",
                        "hidden": True,
                    },
                }
            }
        },
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "KSamplerAdvanced": {
            "input": {
                "required": {
                    "model": ["MODEL"],
                    "add_noise": [["enable", "disable"], {}],
                    "noise_seed": ["INT", {"control_after_generate": True}],
                    "steps": ["INT", {}],
                    "cfg": ["FLOAT", {}],
                    "sampler_name": [["euler", "heun"], {}],
                    "scheduler": [["normal", "karras"], {}],
                    "positive": ["CONDITIONING"],
                    "negative": ["CONDITIONING"],
                    "latent_image": ["LATENT"],
                    "start_at_step": ["INT", {"min": 0}],
                    "end_at_step": ["INT", {"min": 0}],
                    "return_with_leftover_noise": [["enable", "disable"], {}],
                }
            },
            "input_order": {
                "required": [
                    "model",
                    "add_noise",
                    "noise_seed",
                    "steps",
                    "cfg",
                    "sampler_name",
                    "scheduler",
                    "positive",
                    "negative",
                    "latent_image",
                    "start_at_step",
                    "end_at_step",
                    "return_with_leftover_noise",
                ]
            },
        }
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    widgets = rules["nodes"]["145"]["widgets"]
    assert list(widgets.keys()) == ["cfg", "noise_seed", "start_at_step", "end_at_step"]
    assert widgets["cfg"]["value_type"] == "float"
    assert widgets["noise_seed"]["control_after_generate"] is True
    assert widgets["start_at_step"]["hidden"] is True
    assert widgets["end_at_step"]["hidden"] is True


def test_enrich_rules_with_object_info_respects_explicit_widgets_mode_override():
    workflow = {
        "145": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 1,
                "steps": 20,
            },
            "_meta": {"title": "KSampler"},
        }
    }
    rules = {
        "version": 1,
        "nodes": {
            "145": {
                "widgets_mode": "control_after_generate",
            }
        },
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "KSampler": {
            "input": {
                "required": {
                    "seed": ["INT", {"control_after_generate": True}],
                    "steps": ["INT", {}],
                }
            },
            "input_order": {
                "required": ["seed", "steps"],
            },
        }
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    widgets = rules["nodes"]["145"]["widgets"]
    assert list(widgets.keys()) == ["seed"]


def test_enrich_rules_with_object_info_respects_explicit_widgets_mode_all_override():
    workflow = {
        "145": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 1,
                "steps": 20,
                "cfg": 7.5,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1,
            },
            "_meta": {"title": "KSampler"},
        }
    }
    rules = {
        "version": 1,
        "nodes": {
            "145": {
                "widgets_mode": "all",
            }
        },
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "KSampler": {
            "input": {
                "required": {
                    "seed": ["INT", {"control_after_generate": True}],
                    "steps": ["INT", {}],
                    "cfg": ["FLOAT", {}],
                    "sampler_name": [["euler", "heun"], {}],
                    "scheduler": [["normal", "karras"], {}],
                    "denoise": ["FLOAT", {"default": 1, "min": 0, "max": 1}],
                }
            },
            "input_order": {
                "required": [
                    "seed",
                    "steps",
                    "cfg",
                    "sampler_name",
                    "scheduler",
                    "denoise",
                ],
            },
        }
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    widgets = rules["nodes"]["145"]["widgets"]
    assert list(widgets.keys()) == [
        "seed",
        "steps",
        "cfg",
        "sampler_name",
        "scheduler",
        "denoise",
    ]


def test_load_rules_for_workflow_normalizes_aspect_ratio_processing(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "aspect_ratio_processing": {
                    "enabled": True,
                    "stride": 32,
                    "search_steps": 3,
                    "resolutions": [480, 720],
                    "target_nodes": [
                        {
                            "node_id": "49",
                            "width_param": "width",
                            "height_param": "height",
                        }
                    ],
                    "postprocess": {
                        "enabled": True,
                        "mode": "stretch_exact",
                        "apply_to": "all_visual_outputs",
                    },
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")
    assert warnings == []
    assert rules["aspect_ratio_processing"] == {
        "enabled": True,
        "stride": 32,
        "search_steps": 3,
        "resolutions": [480, 720],
        "target_nodes": [
            {
                "node_id": "49",
                "width_param": "width",
                "height_param": "height",
            }
        ],
        "postprocess": {
            "enabled": True,
            "mode": "stretch_exact",
            "apply_to": "all_visual_outputs",
        },
    }


def test_load_rules_for_workflow_normalizes_aspect_ratio_processing_split_refs(
    tmp_path: Path,
):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "aspect_ratio_processing": {
                    "enabled": True,
                    "stride": 32,
                    "search_steps": 3,
                    "target_nodes": [
                        {
                            "width": {
                                "node_id": "292",
                                "param": "value",
                            },
                            "height": {
                                "node_id": "293",
                                "param": "value",
                            },
                        }
                    ],
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")
    assert warnings == []
    assert rules["aspect_ratio_processing"]["target_nodes"] == [
        {
            "width": {
                "node_id": "292",
                "param": "value",
            },
            "height": {
                "node_id": "293",
                "param": "value",
            },
        }
    ]


def test_load_rules_for_workflow_reports_invalid_aspect_ratio_processing(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "aspect_ratio_processing": {
                    "enabled": True,
                    "stride": 0,
                    "search_steps": -1,
                    "resolutions": ["bad", 720, 0],
                    "target_nodes": [{"node_id": "49"}],
                    "postprocess": {
                        "mode": "bad_mode",
                        "apply_to": "bad_target",
                    },
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")
    assert rules["aspect_ratio_processing"]["enabled"] is True
    assert rules["aspect_ratio_processing"]["stride"] == 16
    assert rules["aspect_ratio_processing"]["search_steps"] == 2
    assert rules["aspect_ratio_processing"]["resolutions"] == [720]
    assert rules["aspect_ratio_processing"]["target_nodes"] == []
    assert rules["aspect_ratio_processing"]["postprocess"] == {
        "enabled": True,
        "mode": "stretch_exact",
        "apply_to": "all_visual_outputs",
    }
    assert any(
        w["code"] == "invalid_aspect_ratio_processing_stride" for w in warnings
    )
    assert any(
        w["code"] == "invalid_aspect_ratio_processing_search_steps"
        for w in warnings
    )
    assert any(
        w["code"] == "invalid_aspect_ratio_processing_resolution"
        for w in warnings
    )
    assert any(
        w["code"] == "invalid_aspect_ratio_processing_target_node"
        for w in warnings
    )
    assert any(
        w["code"] == "invalid_aspect_ratio_processing_postprocess_mode"
        for w in warnings
    )
    assert any(
        w["code"] == "invalid_aspect_ratio_processing_postprocess_apply_to"
        for w in warnings
    )


def test_load_rules_for_workflow_normalizes_mask_cropping(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "mask_cropping": {
                    "mode": "full",
                },
                "nodes": {
                    "2": {
                        "binary_derived_mask_of": "1",
                    }
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")
    assert warnings == []
    assert rules["mask_cropping"] == {"mode": "full"}
    assert collect_mask_crop_pairs(rules) == []


def test_load_rules_for_workflow_supports_legacy_mask_cropping_enabled(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "mask_cropping": {
                    "enabled": False,
                },
                "nodes": {
                    "2": {
                        "binary_derived_mask_of": "1",
                    }
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")
    assert warnings == []
    assert rules["mask_cropping"] == {"mode": "full"}
    assert collect_mask_crop_pairs(rules) == []


def test_load_rules_for_workflow_reports_invalid_mask_cropping(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "mask_cropping": {
                    "mode": "zoom",
                },
                "nodes": {
                    "2": {
                        "binary_derived_mask_of": "1",
                    }
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")
    assert rules["mask_cropping"] == {"mode": "crop"}
    assert collect_mask_crop_pairs(rules) == [("1", "2")]
    assert any(w["code"] == "invalid_mask_cropping_mode" for w in warnings)


def test_load_rules_for_workflow_reports_invalid_legacy_mask_cropping_enabled(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "mask_cropping": {
                    "enabled": "sometimes",
                },
                "nodes": {
                    "2": {
                        "binary_derived_mask_of": "1",
                    }
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")
    assert rules["mask_cropping"] == {"mode": "crop"}
    assert collect_mask_crop_pairs(rules) == [("1", "2")]
    assert any(w["code"] == "invalid_mask_cropping_enabled" for w in warnings)


def test_collect_mask_crop_pairs_allows_runtime_mode_override(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "mask_cropping": {
                    "mode": "full",
                },
                "nodes": {
                    "2": {
                        "binary_derived_mask_of": "1",
                    }
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")
    assert warnings == []
    assert collect_mask_crop_pairs(rules) == []
    assert collect_mask_crop_pairs(rules, "crop") == [("1", "2")]
    assert collect_mask_crop_pairs(rules, "full") == []


def test_load_rules_for_workflow_normalizes_binary_audio_derived_masks(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "2": {
                        "binary_audio_derived_mask_of": "1",
                        "audio_derived_mask_fps": 17,
                    }
                },
            }
        )
    )

    rules, warnings = load_rules_for_workflow(tmp_path, "example.json")

    assert warnings == []
    assert rules["nodes"]["2"]["binary_audio_derived_mask_of"] == "1"
    assert rules["nodes"]["2"]["audio_derived_mask_fps"] == 17


def test_collect_mask_crop_pairs_ignores_binary_audio_derived_masks():
    rules = {
        "nodes": {
            "2": {"binary_audio_derived_mask_of": "1"},
            "3": {"binary_derived_mask_of": "1"},
        }
    }

    assert collect_mask_crop_pairs(rules) == [("1", "3")]


def test_normalize_rules_model_compiles_v2_pipeline_and_typed_validation():
    raw_rules = {
        "version": 2,
        "default_widgets_mode": "all",
        "nodes": {
            "2": {
                "binary_derived_mask_of": "1",
            }
        },
        "pipeline": [
            {
                "kind": "aspect_ratio",
                "enabled": True,
                "resolutions": [720, 1080],
            },
            {
                "kind": "mask_cropping",
                "mode": "crop",
            },
        ],
        "validation": {
            "inputs": [
                {
                    "kind": "required",
                    "input": {"node_id": "11", "param": "text"},
                },
                {
                    "kind": "optional",
                    "input": {"node_id": "12"},
                },
            ]
        },
        "output_injections": [
            {
                "target_node_id": "20",
                "target_output_index": 0,
                "source": {"kind": "node_output", "node_id": "9", "output_index": 0},
            }
        ],
    }

    rules_model, warnings = normalize_rules_model(raw_rules)

    assert warnings == []
    assert rules_model.version == 2
    assert rules_model.mask_cropping.mode == "crop"
    assert rules_model.aspect_ratio_processing.enabled is True
    assert rules_model.validation.inputs[0].input == "11:text"
    assert rules_model.validation.inputs[1].input == "12"
    assert rules_model._default_widgets_mode == "all"
    assert rules_model._pipeline_stage_order == ("aspect_ratio", "mask_cropping")
    assert rules_model._has_explicit_pipeline is True

    dumped_rules = dump_resolved_rules(rules_model)
    assert dumped_rules["output_injections"] == {
        "20": {
            "0": {
                "source": {
                    "kind": "node_output",
                    "node_id": "9",
                    "output_index": 0,
                }
            }
        }
    }


def test_load_rules_model_for_workflow_supports_v2_sidecars(tmp_path: Path):
    workflow_path = tmp_path / "example.json"
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "example.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 2,
                "pipeline": [
                    {
                        "kind": "aspect_ratio",
                        "enabled": True,
                        "resolutions": [720],
                    }
                ],
                "validation": {
                    "inputs": [
                        {
                            "kind": "required",
                            "input": {"node_id": "12"},
                        }
                    ]
                },
            }
        )
    )

    rules_model, warnings = load_rules_model_for_workflow(tmp_path, "example.json")

    assert warnings == []
    assert rules_model.version == 2
    assert rules_model.mask_cropping.mode == "full"
    assert rules_model.aspect_ratio_processing.enabled is True
    assert rules_model.validation.inputs[0].input == "12"
    assert rules_model._pipeline_stage_order == ("aspect_ratio",)


def test_migrate_authored_v1_to_v2_preserves_resolved_runtime_shape():
    authored_v1 = AuthoredWorkflowRulesV1.model_validate(
        {
            "version": 1,
            "nodes": {
                "2": {
                    "binary_derived_mask_of": "1",
                }
            },
            "validation": {
                "inputs": [
                    {
                        "kind": "required",
                        "input": "11:text",
                    },
                    {
                        "kind": "optional",
                        "input": "12",
                    },
                ]
            },
            "output_injections": {
                "20": {
                    "0": {
                        "source": {
                            "kind": "node_output",
                            "node_id": "9",
                            "output_index": 0,
                        }
                    }
                }
            },
        }
    )

    authored_v2 = migrate_authored_v1_to_v2(authored_v1)
    resolved_v1 = dump_resolved_rules(compile_authored_v1_to_resolved(authored_v1))
    resolved_v2 = dump_resolved_rules(compile_authored_v2_to_resolved(authored_v2))

    assert authored_v2.version == 2
    assert resolved_v2["version"] == 2
    assert {**resolved_v2, "version": 1} == resolved_v1


def test_enrich_rules_with_object_info_uses_v2_default_widgets_mode():
    workflow = {
        "1": {
            "class_type": "CustomScalar",
            "inputs": {},
            "_meta": {"title": "Strength"},
        }
    }
    object_info = {
        "CustomScalar": {
            "input": {
                "required": {
                    "value": [
                        "INT",
                        {
                            "default": 8,
                        },
                    ]
                }
            },
            "input_order": {
                "required": ["value"],
            },
        }
    }

    set_object_info_cache(object_info)
    try:
        rules_model, warnings = normalize_rules_model(
            {
                "version": 2,
                "default_widgets_mode": "all",
            }
        )

        assert warnings == []
        rules_model = enrich_rules_with_object_info(rules_model, workflow)

        dumped_rules = dump_resolved_rules(rules_model)
        assert dumped_rules["nodes"]["1"]["widgets"]["value"] == {
            "label": "value",
            "control_after_generate": False,
            "value_type": "int",
            "default": 8,
        }
    finally:
        set_object_info_cache(None)


def test_resolved_workflow_rules_schema_snapshot_matches_generated_file():
    schema_path = (
        Path(__file__).resolve().parent.parent
        / "services"
        / "workflow_rules"
        / "schema"
        / "resolved_workflow_rules.schema.json"
    )

    expected = json.loads(schema_path.read_text(encoding="utf-8"))
    actual = ResolvedWorkflowRules.model_json_schema()

    assert actual == expected


def test_derive_true_dimensions_from_short_edge():
    assert derive_true_dimensions_from_short_edge("16:9", 1080) == (1920, 1080)
    assert derive_true_dimensions_from_short_edge("9:16", 1080) == (1080, 1920)
    assert derive_true_dimensions_from_short_edge("1:1", 720) == (720, 720)


def test_find_best_strided_dimensions_prefers_min_relative_error():
    candidate = find_best_strided_dimensions(
        target_width=1080,
        target_height=608,
        stride=32,
        search_steps=2,
    )
    assert candidate is not None
    assert candidate["width"] % 32 == 0
    assert candidate["height"] % 32 == 0
    assert candidate["error"] >= 0


def test_apply_aspect_ratio_processing_clamps_to_supported_resolution():
    workflow = {
        "49": {
            "class_type": "WanVaceToVideo",
            "inputs": {
                "width": 720,
                "height": 720,
            },
        }
    }
    rules = {
        "aspect_ratio_processing": {
            "enabled": True,
            "stride": 32,
            "search_steps": 2,
            "resolutions": [480, 720],
            "target_nodes": [
                {
                    "node_id": "49",
                    "width_param": "width",
                    "height_param": "height",
                }
            ],
            "postprocess": {
                "enabled": True,
                "mode": "stretch_exact",
                "apply_to": "all_visual_outputs",
            },
        }
    }

    metadata, warnings = apply_aspect_ratio_processing(
        workflow,
        rules,
        "16:9",
        1080,
    )

    assert isinstance(metadata, dict)
    assert metadata["requested"]["resolution"] == 720
    assert metadata["strided"]["width"] % 32 == 0
    assert metadata["strided"]["height"] % 32 == 0
    assert workflow["49"]["inputs"]["width"] == metadata["strided"]["width"]
    assert workflow["49"]["inputs"]["height"] == metadata["strided"]["height"]
    assert any(
        warning["code"] == "aspect_ratio_processing_resolution_clamped"
        for warning in warnings
    )


def test_apply_aspect_ratio_processing_uses_provided_target_aspect_ratio():
    workflow = {
        "49": {
            "class_type": "WanVaceToVideo",
            "inputs": {
                "width": 720,
                "height": 720,
            },
        }
    }
    rules = {
        "aspect_ratio_processing": {
            "enabled": True,
            "stride": 32,
            "search_steps": 2,
            "target_nodes": [
                {
                    "node_id": "49",
                    "width_param": "width",
                    "height_param": "height",
                }
            ],
            "postprocess": {
                "enabled": True,
                "mode": "stretch_exact",
                "apply_to": "all_visual_outputs",
            },
        }
    }

    metadata, warnings = apply_aspect_ratio_processing(
        workflow,
        rules,
        "179:100",
        720,
    )

    assert warnings == []
    assert isinstance(metadata, dict)
    assert metadata["requested"]["aspect_ratio"] == "179:100"
    assert metadata["requested"]["width"] == 1289
    assert metadata["requested"]["height"] == 720
    assert workflow["49"]["inputs"]["width"] == metadata["strided"]["width"]
    assert workflow["49"]["inputs"]["height"] == metadata["strided"]["height"]


def test_apply_aspect_ratio_processing_applies_split_width_and_height_targets():
    workflow = {
        "292": {
            "class_type": "INTConstant",
            "inputs": {
                "value": 1280,
            },
        },
        "293": {
            "class_type": "INTConstant",
            "inputs": {
                "value": 720,
            },
        },
    }
    rules = {
        "aspect_ratio_processing": {
            "enabled": True,
            "stride": 32,
            "search_steps": 2,
            "target_nodes": [
                {
                    "width": {
                        "node_id": "292",
                        "param": "value",
                    },
                    "height": {
                        "node_id": "293",
                        "param": "value",
                    },
                }
            ],
            "postprocess": {
                "enabled": True,
                "mode": "stretch_exact",
                "apply_to": "all_visual_outputs",
            },
        }
    }

    metadata, warnings = apply_aspect_ratio_processing(
        workflow,
        rules,
        "16:9",
        1080,
    )

    assert warnings == []
    assert isinstance(metadata, dict)
    assert workflow["292"]["inputs"]["value"] == metadata["strided"]["width"]
    assert workflow["293"]["inputs"]["value"] == metadata["strided"]["height"]
    assert metadata["applied_nodes"] == [
        {
            "width": {
                "node_id": "292",
                "param": "value",
            },
            "height": {
                "node_id": "293",
                "param": "value",
            },
        }
    ]


def test_apply_aspect_ratio_processing_normalizes_resize_image_mask_node_targets():
    workflow = {
        "7": {
            "class_type": "ResizeImageMaskNode",
            "inputs": {
                "resize_type": "scale longer dimension",
                "resize_type.longer_size": 1536,
                "scale_method": "lanczos",
                "input": ["4", 0],
            },
        }
    }
    rules = {
        "aspect_ratio_processing": {
            "enabled": True,
            "stride": 32,
            "search_steps": 2,
            "target_nodes": [
                {
                    "node_id": "7",
                    "width_param": "resize_type.width",
                    "height_param": "resize_type.height",
                }
            ],
            "postprocess": {
                "enabled": True,
                "mode": "stretch_exact",
                "apply_to": "all_visual_outputs",
            },
        }
    }

    metadata, warnings = apply_aspect_ratio_processing(
        workflow,
        rules,
        "16:9",
        720,
    )

    assert warnings == []
    assert isinstance(metadata, dict)
    assert workflow["7"]["inputs"]["resize_type"] == "scale dimensions"
    assert workflow["7"]["inputs"]["resize_type.width"] == metadata["strided"]["width"]
    assert workflow["7"]["inputs"]["resize_type.height"] == metadata["strided"]["height"]
    assert workflow["7"]["inputs"]["resize_type.crop"] == "disabled"
    assert workflow["7"]["inputs"]["scale_method"] == "lanczos"
    assert "resize_type.longer_size" not in workflow["7"]["inputs"]


def test_apply_aspect_ratio_processing_skips_when_no_target_nodes_are_configured():
    workflow = {
        "49": {
            "class_type": "WanVaceToVideo",
            "inputs": {
                "width": 720,
                "height": 720,
            },
        }
    }
    rules = {
        "aspect_ratio_processing": {
            "enabled": True,
            "stride": 32,
            "search_steps": 2,
            "target_nodes": [],
            "postprocess": {
                "enabled": True,
                "mode": "stretch_exact",
                "apply_to": "all_visual_outputs",
            },
        }
    }

    metadata, warnings = apply_aspect_ratio_processing(
        workflow,
        rules,
        "16:9",
        720,
    )

    assert metadata is None
    assert warnings == []
    assert workflow["49"]["inputs"]["width"] == 720
    assert workflow["49"]["inputs"]["height"] == 720


def test_apply_rules_rewrites_output_links():
    workflow = {
        "1": {"class_type": "SourceA", "inputs": {}},
        "2": {"class_type": "ConsumerA", "inputs": {"input": ["1", 0]}},
        "3": {"class_type": "ConsumerB", "inputs": {"input": ["1", 0]}},
        "9": {"class_type": "SourceB", "inputs": {}},
    }
    rules = {
        "version": 1,
        "output_injections": {
            "1": {
                "0": {
                    "source": {
                        "kind": "node_output",
                        "node_id": "9",
                        "output_index": 0,
                    }
                }
            }
        },
    }

    rewritten, warnings = apply_rules_to_workflow(workflow, rules)
    assert warnings == []
    assert rewritten["2"]["inputs"]["input"] == ["9", 0]
    assert rewritten["3"]["inputs"]["input"] == ["9", 0]


def test_apply_rules_ignore_removes_node_after_rewrite():
    workflow = _base_prompt()
    rules = {
        "version": 1,
        "nodes": {"1": {"ignore": True}},
        "output_injections": {
            "1": {
                "0": {
                    "source": {
                        "kind": "node_output",
                        "node_id": "9",
                        "output_index": 0,
                    }
                }
            }
        },
    }

    rewritten, warnings = apply_rules_to_workflow(workflow, rules)
    assert warnings == []
    assert "1" not in rewritten
    assert rewritten["2"]["inputs"]["input"] == ["9", 0]


def test_apply_rules_conditionally_rewrites_and_prunes_missing_input_branches():
    workflow = {
        "1": {"class_type": "LoadImage", "inputs": {"image": "placeholder.png"}},
        "2": {"class_type": "Resize", "inputs": {"image": ["1", 0]}},
        "3": {"class_type": "PromptEnhancer", "inputs": {"image": ["2", 0]}},
        "4": {"class_type": "Consumer", "inputs": {"text": ["3", 0]}},
        "9": {"class_type": "RawPrompt", "inputs": {}},
    }
    rules = {
        "version": 2,
        "nodes": {
            "1": {"present": {"required": False}},
            "3": {
                "ignore_overrides": [
                    {
                        "when": {
                            "kind": "input_presence",
                            "inputs": ["1"],
                            "match": "all_missing",
                        },
                        "value": True,
                    }
                ]
            },
        },
        "output_injections": [
            {
                "target_node_id": "3",
                "target_output_index": 0,
                "source": {
                    "kind": "node_output",
                    "node_id": "9",
                    "output_index": 0,
                },
                "when": {
                    "kind": "input_presence",
                    "inputs": ["1"],
                    "match": "all_missing",
                },
            }
        ],
    }

    rewritten, warnings = apply_rules_to_workflow(workflow, rules, provided_input_ids=set())

    assert warnings == []
    assert rewritten["4"]["inputs"]["text"] == ["9", 0]
    assert "1" not in rewritten
    assert "2" not in rewritten
    assert "3" not in rewritten


def test_apply_rules_ignore_fallback_when_referenced():
    workflow = _base_prompt()
    rules = {
        "version": 1,
        "nodes": {"1": {"ignore": True}},
    }

    rewritten, warnings = apply_rules_to_workflow(workflow, rules)
    assert "1" in rewritten
    assert any(w["code"] == "ignored_node_still_referenced" for w in warnings)


def test_apply_rules_transitive_prune_preserves_shared_upstream():
    workflow = {
        "1": {"class_type": "Root", "inputs": {}},
        "2": {"class_type": "Mid", "inputs": {"input": ["1", 0]}},
        "3": {"class_type": "Ignored", "inputs": {"input": ["2", 0]}},
        "4": {"class_type": "SharedConsumer", "inputs": {"input": ["1", 0]}},
    }
    rules = {
        "version": 1,
        "nodes": {"3": {"ignore": True}},
    }

    rewritten, warnings = apply_rules_to_workflow(workflow, rules)
    assert warnings == []
    assert "3" not in rewritten
    assert "2" not in rewritten
    assert "1" in rewritten
    assert "4" in rewritten


def test_apply_rules_disconnects_missing_optional_inputs_and_prunes_nodes():
    workflow = {
        "62": {"class_type": "LoadImage", "inputs": {"image": "end.png"}},
        "67": {
            "class_type": "WanFirstLastFrameToVideo",
            "inputs": {
                "start_image": ["68", 0],
                "end_image": ["62", 0],
            },
        },
        "68": {"class_type": "LoadImage", "inputs": {"image": "start.png"}},
    }
    rules = {
        "version": 1,
        "nodes": {
            "62": {
                "present": {
                    "required": False,
                }
            }
        },
    }

    rewritten, warnings = apply_rules_to_workflow(
        workflow,
        rules,
        provided_input_ids={"68"},
    )

    assert warnings == []
    assert "62" not in rewritten
    assert rewritten["67"]["inputs"]["start_image"] == ["68", 0]
    assert "end_image" not in rewritten["67"]["inputs"]


def test_apply_rules_applies_widget_default_overrides_from_input_presence():
    workflow = {
        "267": {
            "class_type": "TemplateSubgraph",
            "inputs": {
                "value_1": False,
            },
        }
    }
    rules = {
        "version": 2,
        "nodes": {
            "267": {
                "widgets": {
                    "value_1": {
                        "default_overrides": [
                            {
                                "when": {
                                    "kind": "input_presence",
                                    "inputs": ["269"],
                                    "match": "all_missing",
                                },
                                "value": True,
                            },
                            {
                                "when": {
                                    "kind": "input_presence",
                                    "inputs": ["269"],
                                    "match": "all_present",
                                },
                                "value": False,
                            },
                        ]
                    }
                }
            }
        },
    }

    rewritten_missing, warnings_missing = apply_rules_to_workflow(
        workflow,
        rules,
        provided_input_ids=set(),
    )
    assert warnings_missing == []
    assert rewritten_missing["267"]["inputs"]["value_1"] is True

    rewritten_present, warnings_present = apply_rules_to_workflow(
        workflow,
        rules,
        provided_input_ids={"269"},
    )
    assert warnings_present == []
    assert rewritten_present["267"]["inputs"]["value_1"] is False


def test_find_unsatisfied_input_conditions_requires_at_least_one_input():
    rules = {
        "input_conditions": [
            {
                "kind": "at_least_one",
                "inputs": ["68", "62"],
                "message": "Provide at least one frame input.",
            }
        ]
    }

    assert find_unsatisfied_input_conditions(rules, set()) == [
        "Provide at least one frame input."
    ]
    assert find_unsatisfied_input_conditions(rules, {"68"}) == []


def test_evaluate_input_validation_supports_required_and_at_least_n():
    rules = {
        "validation": {
            "inputs": [
                {
                    "kind": "required",
                    "input": "3",
                    "message": "Prompt is required.",
                },
                {
                    "kind": "at_least_n",
                    "inputs": ["68", "62"],
                    "min": 1,
                    "message": "Provide at least one frame input.",
                },
                {
                    "kind": "optional",
                    "input": "99",
                },
            ]
        }
    }

    assert evaluate_input_validation(rules, set()) == [
        {
            "kind": "required",
            "input": "3",
            "message": "Prompt is required.",
        },
        {
            "kind": "at_least_n",
            "inputs": ["68", "62"],
            "min": 1,
            "provided": 0,
            "message": "Provide at least one frame input.",
        },
    ]
    assert evaluate_input_validation(rules, {"3", "68"}) == []


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload
        self.content = json.dumps(payload).encode("utf-8")
        self.headers = {"content-type": "application/json"}

    def json(self):
        return self._payload


class _FakeComfyClient:
    def __init__(self):
        self.prompt_payload = None
        self.shared_upload_attempts = 0
        self.memory_registration_payloads: list[dict[str, Any]] = []

    async def post(self, url: str, **kwargs):
        if url == "/upload/image":
            self.shared_upload_attempts += 1
            files = kwargs.get("files")
            upload_entry = None
            if isinstance(files, dict) and files:
                upload_entry = next(iter(files.values()))

            content_type = None
            if isinstance(upload_entry, tuple) and len(upload_entry) >= 3:
                maybe_content_type = upload_entry[2]
                if isinstance(maybe_content_type, str):
                    content_type = maybe_content_type

            if content_type and content_type.startswith("video/"):
                return _FakeResponse(200, {"name": "uploaded_video.mp4"})
            if content_type and content_type.startswith("audio/"):
                return _FakeResponse(200, {"name": "uploaded_audio.wav"})
            return _FakeResponse(200, {"name": "uploaded_image.png"})
        if url == "/api/vlo-memory/register":
            self.memory_registration_payloads.append(kwargs)
            data = kwargs.get("data") if isinstance(kwargs.get("data"), dict) else {}
            media_kind = data.get("kind", "media")
            return _FakeResponse(
                200,
                {"media_id": f"memory-{media_kind}-{len(self.memory_registration_payloads)}"},
            )
        if url == "/prompt":
            self.prompt_payload = kwargs.get("json")
            return _FakeResponse(200, {"prompt_id": "p1", "number": 1, "node_errors": {}})
        raise AssertionError(f"unexpected URL: {url}")


class _SharedUploadEndpointComfyClient:
    def __init__(self):
        self.prompt_payload = None
        self.image_upload_attempts = 0

    async def post(self, url: str, **kwargs):
        if url == "/upload/image":
            self.image_upload_attempts += 1
            return _FakeResponse(200, {"name": "uploaded_video.mp4"})
        if url == "/prompt":
            self.prompt_payload = kwargs.get("json")
            return _FakeResponse(200, {"prompt_id": "p1", "number": 1, "node_errors": {}})
        raise AssertionError(f"unexpected URL: {url}")


class _FakeRequest:
    def __init__(self, form_data: FormData):
        self._form_data = form_data

    async def form(self):
        return self._form_data


def _as_request(form_data: FormData) -> Request:
    return cast(Request, _FakeRequest(form_data))


def _as_binary_io(file_obj: SpooledTemporaryFile[bytes]) -> BinaryIO:
    return cast(BinaryIO, file_obj)


def _response_json(response: Any) -> Any:
    body = response.body
    if isinstance(body, memoryview):
        body = body.tobytes()
    return json.loads(body)


@pytest.fixture
def fake_comfy_client(monkeypatch):
    fake_comfy_client = _FakeComfyClient()

    async def _fake_get_http_client():
        return fake_comfy_client

    monkeypatch.setattr(comfyui, "get_http_client", _fake_get_http_client)
    return fake_comfy_client


@pytest.mark.anyio
async def test_generate_handles_video_upload_and_applies_rules(tmp_path: Path, monkeypatch, fake_comfy_client):

    workflow_id = "workflow_under_test.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_under_test.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {"145": {"ignore": True}},
                "output_injections": {
                    "144": {
                        "0": {
                            "source": {
                                "kind": "node_output",
                                "node_id": "300",
                                "output_index": 0,
                            }
                        }
                    }
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "145": {"class_type": "LoadVideo", "inputs": {"file": "default.mp4"}},
        "144": {"class_type": "GetVideoComponents", "inputs": {"video": ["145", 0]}},
        "300": {"class_type": "SyntheticFrames", "inputs": {}},
        "49": {"class_type": "WanVaceToVideo", "inputs": {"control_video": ["144", 0]}},
    }

    video_file = SpooledTemporaryFile()
    video_file.write(b"video-bytes")
    video_file.seek(0)

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    (
                        "video_145",
                        UploadFile(
                            file=_as_binary_io(video_file),
                            filename="clip.mp4",
                            headers=Headers({"content-type": "video/mp4"}),
                        ),
                    ),
                ]
            )
        )
    )

    assert response.status_code == 200
    payload = _response_json(response)
    assert any(w["code"] == "ignored_node_still_referenced" for w in payload["workflow_warnings"])
    assert fake_comfy_client.prompt_payload is not None
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["49"]["inputs"]["control_video"] == ["300", 0]
    assert prompt["145"]["inputs"]["file"] == "uploaded_video.mp4"


@pytest.mark.anyio
async def test_generate_handles_audio_upload(tmp_path: Path, monkeypatch, fake_comfy_client):
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "145": {"class_type": "LoadAudio", "inputs": {"audio": "default.wav"}},
        "200": {"class_type": "AudioConsumer", "inputs": {"audio": ["145", 0]}},
    }

    audio_file = SpooledTemporaryFile()
    audio_file.write(b"audio-bytes")
    audio_file.seek(0)

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    (
                        "audio_145",
                        UploadFile(
                            file=_as_binary_io(audio_file),
                            filename="clip.wav",
                            headers=Headers({"content-type": "audio/wav"}),
                        ),
                    ),
                ]
            )
        )
    )

    assert response.status_code == 200
    assert fake_comfy_client.prompt_payload is not None
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["145"]["inputs"]["audio"] == "uploaded_audio.wav"


@pytest.mark.anyio
async def test_generate_handles_image_upload(tmp_path: Path, monkeypatch, fake_comfy_client):
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "145": {"class_type": "LoadImage", "inputs": {"image": "default.png"}},
        "200": {"class_type": "ImageConsumer", "inputs": {"image": ["145", 0]}},
    }

    image_file = SpooledTemporaryFile()
    image_file.write(b"image-bytes")
    image_file.seek(0)

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    (
                        "image_145",
                        UploadFile(
                            file=_as_binary_io(image_file),
                            filename="clip.png",
                            headers=Headers({"content-type": "image/png"}),
                        ),
                    ),
                ]
            )
        )
    )

    assert response.status_code == 200
    assert fake_comfy_client.prompt_payload is not None
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["145"]["inputs"]["image"] == "uploaded_image.png"
    assert fake_comfy_client.shared_upload_attempts == 1
    assert fake_comfy_client.memory_registration_payloads == []


@pytest.mark.anyio
async def test_generate_routes_memory_video_nodes_to_memory_registration(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "145": {"class_type": "VLOMemoryLoadVideo", "inputs": {"file": "default.mp4"}},
        "200": {"class_type": "GetVideoComponents", "inputs": {"video": ["145", 0]}},
    }

    video_file = SpooledTemporaryFile()
    video_file.write(b"video-bytes")
    video_file.seek(0)

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    (
                        "video_145",
                        UploadFile(
                            file=_as_binary_io(video_file),
                            filename="clip.mp4",
                            headers=Headers({"content-type": "video/mp4"}),
                        ),
                    ),
                ]
            )
        )
    )

    assert response.status_code == 200
    assert fake_comfy_client.prompt_payload is not None
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["145"]["inputs"]["file"] == "memory-video-1"
    assert fake_comfy_client.shared_upload_attempts == 0
    assert len(fake_comfy_client.memory_registration_payloads) == 1


@pytest.mark.anyio
async def test_generate_applies_mask_cropping_by_default_for_derived_masks(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_mask_crop_default.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_mask_crop_default.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "2": {
                        "binary_derived_mask_of": "1",
                    }
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    analyzed_masks: list[tuple[bytes, float, float]] = []
    cropped_inputs: list[tuple[bytes, tuple[int, int, int, int]]] = []
    uploaded_videos: dict[str, bytes] = {}

    def _fake_analyze(mask_bytes: bytes, target_ar: float, dilation: float = 0.1):
        analyzed_masks.append((mask_bytes, target_ar, dilation))
        return (2, 4, 10, 12)

    def _fake_crop(video_bytes: bytes, crop: tuple[int, int, int, int]):
        cropped_inputs.append((video_bytes, crop))
        return video_bytes + b"|cropped"

    async def _fake_upload_video_bytes_to_comfy(client, video_bytes, filename, content_type):
        uploaded_videos[filename] = video_bytes
        return f"uploaded::{filename}", None

    monkeypatch.setattr(comfyui, "analyze_mask_video_bounds", _fake_analyze)
    monkeypatch.setattr(comfyui, "crop_video", _fake_crop)
    monkeypatch.setattr(comfyui, "get_video_dimensions", lambda _bytes: (1920, 1080))
    monkeypatch.setattr(
        comfyui,
        "_upload_video_bytes_to_comfy",
        _fake_upload_video_bytes_to_comfy,
    )

    source_file = SpooledTemporaryFile()
    source_file.write(b"source-video")
    source_file.seek(0)
    mask_file = SpooledTemporaryFile()
    mask_file.write(b"mask-video")
    mask_file.seek(0)

    workflow = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": "default-source.mp4"}},
        "2": {"class_type": "LoadVideo", "inputs": {"file": "default-mask.webm"}},
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    ("target_aspect_ratio", "16:9"),
                    ("mask_crop_dilation", "0.2"),
                    (
                        "video_1",
                        UploadFile(
                            file=_as_binary_io(source_file),
                            filename="source.mp4",
                            headers=Headers({"content-type": "video/mp4"}),
                        ),
                    ),
                    (
                        "video_2",
                        UploadFile(
                            file=_as_binary_io(mask_file),
                            filename="mask.webm",
                            headers=Headers({"content-type": "video/webm"}),
                        ),
                    ),
                ]
            )
        )
    )

    assert response.status_code == 200
    assert analyzed_masks == [(b"mask-video", 16 / 9, 0.2)]
    assert cropped_inputs == [
        (b"mask-video", (2, 4, 10, 12)),
        (b"source-video", (2, 4, 10, 12)),
    ]
    assert uploaded_videos == {
        "mask.webm": b"mask-video|cropped",
        "source.mp4": b"source-video|cropped",
    }
    payload = _response_json(response)
    assert payload["mask_crop_metadata"] == {
        "mode": "cropped",
        "crop_position": [2, 4],
        "crop_size": [8, 8],
        "container_size": [1920, 1080],
        "scale": 0.005136,
    }
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["1"]["inputs"]["file"] == "uploaded::source.mp4"
    assert prompt["2"]["inputs"]["file"] == "uploaded::mask.webm"


@pytest.mark.anyio
async def test_generate_skips_mask_cropping_when_sidecar_requests_full_mode(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_mask_crop_disabled.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_mask_crop_disabled.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "mask_cropping": {
                    "mode": "full",
                },
                "nodes": {
                    "2": {
                        "binary_derived_mask_of": "1",
                    }
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    analyzed_masks: list[tuple[bytes, float, float]] = []
    cropped_inputs: list[tuple[bytes, tuple[int, int, int, int]]] = []
    uploaded_videos: dict[str, bytes] = {}

    def _fake_analyze(mask_bytes: bytes, target_ar: float, dilation: float = 0.1):
        analyzed_masks.append((mask_bytes, target_ar, dilation))
        return (2, 4, 10, 12)

    def _fake_crop(video_bytes: bytes, crop: tuple[int, int, int, int]):
        cropped_inputs.append((video_bytes, crop))
        return video_bytes + b"|cropped"

    async def _fake_upload_video_bytes_to_comfy(client, video_bytes, filename, content_type):
        uploaded_videos[filename] = video_bytes
        return f"uploaded::{filename}", None

    monkeypatch.setattr(comfyui, "analyze_mask_video_bounds", _fake_analyze)
    monkeypatch.setattr(comfyui, "crop_video", _fake_crop)
    monkeypatch.setattr(comfyui, "get_video_dimensions", lambda _bytes: (1920, 1080))
    monkeypatch.setattr(
        comfyui,
        "_upload_video_bytes_to_comfy",
        _fake_upload_video_bytes_to_comfy,
    )

    source_file = SpooledTemporaryFile()
    source_file.write(b"source-video")
    source_file.seek(0)
    mask_file = SpooledTemporaryFile()
    mask_file.write(b"mask-video")
    mask_file.seek(0)

    workflow = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": "default-source.mp4"}},
        "2": {"class_type": "LoadVideo", "inputs": {"file": "default-mask.webm"}},
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    ("target_aspect_ratio", "16:9"),
                    ("mask_crop_dilation", "0.2"),
                    (
                        "video_1",
                        UploadFile(
                            file=_as_binary_io(source_file),
                            filename="source.mp4",
                            headers=Headers({"content-type": "video/mp4"}),
                        ),
                    ),
                    (
                        "video_2",
                        UploadFile(
                            file=_as_binary_io(mask_file),
                            filename="mask.webm",
                            headers=Headers({"content-type": "video/webm"}),
                        ),
                    ),
                ]
            )
        )
    )

    assert response.status_code == 200
    assert analyzed_masks == []
    assert cropped_inputs == []
    assert uploaded_videos == {
        "mask.webm": b"mask-video",
        "source.mp4": b"source-video",
    }
    payload = _response_json(response)
    assert payload["mask_crop_metadata"] == {"mode": "full"}
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["1"]["inputs"]["file"] == "uploaded::source.mp4"
    assert prompt["2"]["inputs"]["file"] == "uploaded::mask.webm"


@pytest.mark.anyio
async def test_generate_skips_mask_cropping_when_request_overrides_to_full(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_mask_crop_request_full.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_mask_crop_request_full.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "mask_cropping": {
                    "mode": "crop",
                },
                "nodes": {
                    "2": {
                        "binary_derived_mask_of": "1",
                    }
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    analyzed_masks: list[tuple[bytes, float, float]] = []
    cropped_inputs: list[tuple[bytes, tuple[int, int, int, int]]] = []
    uploaded_videos: dict[str, bytes] = {}

    def _fake_analyze(mask_bytes: bytes, target_ar: float, dilation: float = 0.1):
        analyzed_masks.append((mask_bytes, target_ar, dilation))
        return (2, 4, 10, 12)

    def _fake_crop(video_bytes: bytes, crop: tuple[int, int, int, int]):
        cropped_inputs.append((video_bytes, crop))
        return video_bytes + b"|cropped"

    async def _fake_upload_video_bytes_to_comfy(client, video_bytes, filename, content_type):
        uploaded_videos[filename] = video_bytes
        return f"uploaded::{filename}", None

    monkeypatch.setattr(comfyui, "analyze_mask_video_bounds", _fake_analyze)
    monkeypatch.setattr(comfyui, "crop_video", _fake_crop)
    monkeypatch.setattr(comfyui, "get_video_dimensions", lambda _bytes: (1920, 1080))
    monkeypatch.setattr(
        comfyui,
        "_upload_video_bytes_to_comfy",
        _fake_upload_video_bytes_to_comfy,
    )

    source_file = SpooledTemporaryFile()
    source_file.write(b"source-video")
    source_file.seek(0)
    mask_file = SpooledTemporaryFile()
    mask_file.write(b"mask-video")
    mask_file.seek(0)

    workflow = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": "default-source.mp4"}},
        "2": {"class_type": "LoadVideo", "inputs": {"file": "default-mask.webm"}},
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    ("target_aspect_ratio", "16:9"),
                    ("mask_crop_mode", "full"),
                    ("mask_crop_dilation", "0.2"),
                    (
                        "video_1",
                        UploadFile(
                            file=_as_binary_io(source_file),
                            filename="source.mp4",
                            headers=Headers({"content-type": "video/mp4"}),
                        ),
                    ),
                    (
                        "video_2",
                        UploadFile(
                            file=_as_binary_io(mask_file),
                            filename="mask.webm",
                            headers=Headers({"content-type": "video/webm"}),
                        ),
                    ),
                ]
            )
        )
    )

    assert response.status_code == 200
    assert analyzed_masks == []
    assert cropped_inputs == []
    assert uploaded_videos == {
        "mask.webm": b"mask-video",
        "source.mp4": b"source-video",
    }
    payload = _response_json(response)
    assert payload["mask_crop_metadata"] == {"mode": "full"}
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["1"]["inputs"]["file"] == "uploaded::source.mp4"
    assert prompt["2"]["inputs"]["file"] == "uploaded::mask.webm"


@pytest.mark.anyio
async def test_generate_applies_mask_cropping_when_request_overrides_to_crop(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_mask_crop_request_crop.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_mask_crop_request_crop.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "mask_cropping": {
                    "mode": "full",
                },
                "nodes": {
                    "2": {
                        "binary_derived_mask_of": "1",
                    }
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    analyzed_masks: list[tuple[bytes, float, float]] = []
    cropped_inputs: list[tuple[bytes, tuple[int, int, int, int]]] = []
    uploaded_videos: dict[str, bytes] = {}

    def _fake_analyze(mask_bytes: bytes, target_ar: float, dilation: float = 0.1):
        analyzed_masks.append((mask_bytes, target_ar, dilation))
        return (2, 4, 10, 12)

    def _fake_crop(video_bytes: bytes, crop: tuple[int, int, int, int]):
        cropped_inputs.append((video_bytes, crop))
        return video_bytes + b"|cropped"

    async def _fake_upload_video_bytes_to_comfy(client, video_bytes, filename, content_type):
        uploaded_videos[filename] = video_bytes
        return f"uploaded::{filename}", None

    monkeypatch.setattr(comfyui, "analyze_mask_video_bounds", _fake_analyze)
    monkeypatch.setattr(comfyui, "crop_video", _fake_crop)
    monkeypatch.setattr(comfyui, "get_video_dimensions", lambda _bytes: (1920, 1080))
    monkeypatch.setattr(
        comfyui,
        "_upload_video_bytes_to_comfy",
        _fake_upload_video_bytes_to_comfy,
    )

    source_file = SpooledTemporaryFile()
    source_file.write(b"source-video")
    source_file.seek(0)
    mask_file = SpooledTemporaryFile()
    mask_file.write(b"mask-video")
    mask_file.seek(0)

    workflow = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": "default-source.mp4"}},
        "2": {"class_type": "LoadVideo", "inputs": {"file": "default-mask.webm"}},
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    ("target_aspect_ratio", "16:9"),
                    ("mask_crop_mode", "crop"),
                    ("mask_crop_dilation", "0.2"),
                    (
                        "video_1",
                        UploadFile(
                            file=_as_binary_io(source_file),
                            filename="source.mp4",
                            headers=Headers({"content-type": "video/mp4"}),
                        ),
                    ),
                    (
                        "video_2",
                        UploadFile(
                            file=_as_binary_io(mask_file),
                            filename="mask.webm",
                            headers=Headers({"content-type": "video/webm"}),
                        ),
                    ),
                ]
            )
        )
    )

    assert response.status_code == 200
    assert analyzed_masks == [(b"mask-video", 16 / 9, 0.2)]
    assert cropped_inputs == [
        (b"mask-video", (2, 4, 10, 12)),
        (b"source-video", (2, 4, 10, 12)),
    ]
    assert uploaded_videos == {
        "mask.webm": b"mask-video|cropped",
        "source.mp4": b"source-video|cropped",
    }
    payload = _response_json(response)
    assert payload["mask_crop_metadata"] == {
        "mode": "cropped",
        "crop_position": [2, 4],
        "crop_size": [8, 8],
        "container_size": [1920, 1080],
        "scale": 0.005136,
    }
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["1"]["inputs"]["file"] == "uploaded::source.mp4"
    assert prompt["2"]["inputs"]["file"] == "uploaded::mask.webm"


@pytest.mark.anyio
async def test_generate_reports_full_mask_metadata_when_mask_crop_encoding_fails(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_mask_crop_failure.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_mask_crop_failure.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "2": {
                        "binary_derived_mask_of": "1",
                    }
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    cropped_inputs: list[tuple[bytes, tuple[int, int, int, int]]] = []
    uploaded_videos: dict[str, bytes] = {}

    def _fake_analyze(mask_bytes: bytes, target_ar: float, dilation: float = 0.1):
        return (2, 4, 10, 12)

    def _fake_crop(video_bytes: bytes, crop: tuple[int, int, int, int]):
        cropped_inputs.append((video_bytes, crop))
        if video_bytes == b"mask-video":
            raise RuntimeError("mask crop failed")
        return video_bytes + b"|cropped"

    async def _fake_upload_video_bytes_to_comfy(client, video_bytes, filename, content_type):
        uploaded_videos[filename] = video_bytes
        return f"uploaded::{filename}", None

    monkeypatch.setattr(comfyui, "analyze_mask_video_bounds", _fake_analyze)
    monkeypatch.setattr(comfyui, "crop_video", _fake_crop)
    monkeypatch.setattr(comfyui, "get_video_dimensions", lambda _bytes: (1920, 1080))
    monkeypatch.setattr(
        comfyui,
        "_upload_video_bytes_to_comfy",
        _fake_upload_video_bytes_to_comfy,
    )

    source_file = SpooledTemporaryFile()
    source_file.write(b"source-video")
    source_file.seek(0)
    mask_file = SpooledTemporaryFile()
    mask_file.write(b"mask-video")
    mask_file.seek(0)

    workflow = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": "default-source.mp4"}},
        "2": {"class_type": "LoadVideo", "inputs": {"file": "default-mask.webm"}},
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    ("target_aspect_ratio", "16:9"),
                    ("mask_crop_dilation", "0.2"),
                    (
                        "video_1",
                        UploadFile(
                            file=_as_binary_io(source_file),
                            filename="source.mp4",
                            headers=Headers({"content-type": "video/mp4"}),
                        ),
                    ),
                    (
                        "video_2",
                        UploadFile(
                            file=_as_binary_io(mask_file),
                            filename="mask.webm",
                            headers=Headers({"content-type": "video/webm"}),
                        ),
                    ),
                ]
            )
        )
    )

    assert response.status_code == 200
    assert cropped_inputs == [(b"mask-video", (2, 4, 10, 12))]
    assert uploaded_videos == {
        "mask.webm": b"mask-video",
        "source.mp4": b"source-video",
    }
    payload = _response_json(response)
    assert payload["mask_crop_metadata"] == {"mode": "full"}


@pytest.mark.anyio
async def test_generate_bypasses_missing_optional_inputs_in_prompt(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_optional_inputs.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_optional_inputs.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "name": "Wan2.2 I2V & FLF2V",
                "version": 1,
                "nodes": {
                    "68": {
                        "present": {
                            "required": False,
                        }
                    },
                    "62": {
                        "present": {
                            "required": False,
                        }
                    },
                },
                "input_conditions": [
                    {
                        "kind": "at_least_one",
                        "inputs": ["68", "62"],
                        "message": "Provide at least one frame input.",
                    }
                ],
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "68": {"class_type": "LoadImage", "inputs": {"image": "start.png"}},
        "62": {"class_type": "LoadImage", "inputs": {"image": "end.png"}},
        "67": {
            "class_type": "WanFirstLastFrameToVideo",
            "inputs": {
                "start_image": ["68", 0],
                "end_image": ["62", 0],
            },
        },
    }

    image_file = SpooledTemporaryFile()
    image_file.write(b"image-bytes")
    image_file.seek(0)

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    (
                        "image_68",
                        UploadFile(
                            file=_as_binary_io(image_file),
                            filename="start.png",
                            headers=Headers({"content-type": "image/png"}),
                        ),
                    ),
                ]
            )
        )
    )

    assert response.status_code == 200
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["68"]["inputs"]["image"] == "uploaded_image.png"
    assert "62" not in prompt
    assert prompt["67"]["inputs"]["start_image"] == ["68", 0]
    assert "end_image" not in prompt["67"]["inputs"]


@pytest.mark.anyio
async def test_generate_rejects_when_input_condition_is_unsatisfied(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    _ = fake_comfy_client

    workflow_id = "workflow_optional_inputs_invalid.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_optional_inputs_invalid.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "68": {
                        "present": {
                            "required": False,
                        }
                    },
                    "62": {
                        "present": {
                            "required": False,
                        }
                    },
                },
                "input_conditions": [
                    {
                        "kind": "at_least_one",
                        "inputs": ["68", "62"],
                        "message": "Provide at least one frame input.",
                    }
                ],
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "68": {"class_type": "LoadImage", "inputs": {"image": "start.png"}},
        "62": {"class_type": "LoadImage", "inputs": {"image": "end.png"}},
        "67": {
            "class_type": "WanFirstLastFrameToVideo",
            "inputs": {
                "start_image": ["68", 0],
                "end_image": ["62", 0],
            },
        },
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                ]
            )
        )
    )

    assert response.status_code == 400
    payload = _response_json(response)
    assert payload["error"]["code"] == "invalid_generation_request"
    assert payload["error"]["message"] == "Provide at least one frame input."
    assert payload["error"]["details"]["validation_failures"] == [
        {
            "kind": "at_least_n",
            "inputs": ["68", "62"],
            "min": 1,
            "provided": 0,
            "message": "Provide at least one frame input.",
        }
    ]
    assert fake_comfy_client.prompt_payload is None


@pytest.mark.anyio
async def test_generate_uses_provided_workflow_rules_to_prune_missing_optional_image(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "167": {"class_type": "LoadImage", "inputs": {"image": "egyptian_queen.png"}},
        "290": {"class_type": "PrimitiveBoolean", "inputs": {"value": False}},
        "999": {
            "class_type": "Consumer",
            "inputs": {
                "image": ["167", 0],
                "text_to_video": ["290", 0],
            },
        },
    }
    workflow_rules = {
        "nodes": {
            "167": {
                "ignore": False,
                "present": {
                    "label": "Source image",
                    "required": False,
                },
                "widgets": {},
            },
            "290": {
                "ignore": False,
                "widgets": {
                    "value": {
                        "label": "Text to Video",
                        "control_after_generate": False,
                        "hidden": True,
                        "value_type": "boolean",
                        "default_overrides": [
                            {
                                "when": {
                                    "kind": "input_presence",
                                    "inputs": ["167"],
                                    "match": "all_missing",
                                },
                                "value": True,
                            }
                        ],
                    }
                },
            },
        },
        "validation": {
            "inputs": [
                {
                    "kind": "optional",
                    "input": "167",
                }
            ]
        },
        "derived_widgets": [],
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "full"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_rules", json.dumps(workflow_rules)),
                ]
            )
        )
    )

    assert response.status_code == 200
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert "167" not in prompt
    assert prompt["290"]["inputs"]["value"] is True
    assert "image" not in prompt["999"]["inputs"]
    assert prompt["999"]["inputs"]["text_to_video"] == ["290", 0]


@pytest.mark.anyio
async def test_generate_rejects_when_explicit_validation_rule_fails(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    _ = fake_comfy_client

    workflow_id = "workflow_validation_required.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_validation_required.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "validation": {
                    "inputs": [
                        {
                            "kind": "required",
                            "input": "3",
                            "message": "Prompt is required.",
                        }
                    ]
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": ""}},
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                ]
            )
        )
    )

    assert response.status_code == 400
    payload = _response_json(response)
    assert payload["error"]["message"] == "Prompt is required."
    assert payload["error"]["details"]["validation_failures"] == [
        {
            "kind": "required",
            "input": "3",
            "message": "Prompt is required.",
        }
    ]
    assert fake_comfy_client.prompt_payload is None


@pytest.mark.anyio
async def test_generate_rejects_invalid_widget_override_values(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    _ = fake_comfy_client

    workflow_id = "workflow_invalid_widget.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_invalid_widget.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "145": {
                        "widgets": {
                            "steps": {
                                "value_type": "int",
                                "min": 1,
                                "max": 30,
                            }
                        }
                    }
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "145": {"class_type": "KSampler", "inputs": {"steps": 20}},
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    ("widget_145_steps", "999"),
                ]
            )
        )
    )

    assert response.status_code == 400
    payload = _response_json(response)
    assert payload["error"]["message"] == "Value must be at most 30."
    assert payload["error"]["details"]["validation_failures"] == [
        {
            "kind": "widget",
            "node_id": "145",
            "param": "steps",
            "message": "Value must be at most 30.",
        }
    ]
    assert fake_comfy_client.prompt_payload is None


@pytest.mark.anyio
async def test_generate_allows_widget_override_without_rule_when_workflow_has_param(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_missing_widget_rule.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "145": {"class_type": "LoraLoader", "inputs": {"strength_model": 1.0}},
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    ("widget_145_strength_model", "0.5"),
                ]
            )
        )
    )

    assert response.status_code == 200
    payload = _response_json(response)
    assert payload["applied_widget_values"]["145:strength_model"] == "0.5"
    assert any(
        warning["code"] == "widget_override_missing_rule"
        for warning in payload["workflow_warnings"]
    )
    assert fake_comfy_client.prompt_payload is not None
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["145"]["inputs"]["strength_model"] == 0.5


@pytest.mark.anyio
async def test_generate_accepts_boolean_widget_with_custom_stored_values(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_boolean_widget_mapping.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_boolean_widget_mapping.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 2,
                "nodes": {
                    "349": {
                        "widgets": {
                            "sampling_mode": {
                                "label": "Enable prompt enhancer",
                                "value_type": "boolean",
                                "default": False,
                                "true_value": "on",
                                "false_value": "off",
                            }
                        }
                    }
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "349": {
            "class_type": "TextGenerateLTX2Prompt",
            "inputs": {
                "sampling_mode": "off",
            },
        },
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    ("widget_349_sampling_mode", "on"),
                ]
            )
        )
    )

    assert response.status_code == 200
    payload = _response_json(response)
    assert payload["applied_widget_values"]["349:sampling_mode"] == "on"
    assert fake_comfy_client.prompt_payload is not None
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["349"]["inputs"]["sampling_mode"] == "on"


@pytest.mark.anyio
async def test_generate_ignores_widget_randomize_without_rule(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_missing_randomize_rule.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "145": {"class_type": "LoraLoader", "inputs": {"strength_model": 1.0}},
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    ("widget_mode_145_strength_model", "randomize"),
                ]
            )
        )
    )

    assert response.status_code == 200
    payload = _response_json(response)
    assert any(
        warning["code"] == "widget_randomize_missing_rule"
        for warning in payload["workflow_warnings"]
    )
    assert fake_comfy_client.prompt_payload is not None
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["145"]["inputs"]["strength_model"] == 1.0


@pytest.mark.anyio
async def test_generate_randomize_mode_produces_fresh_seed_per_request(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_randomized_seed.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_randomized_seed.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "145": {
                        "widgets": {
                            "seed": {
                                "value_type": "int",
                                "min": 1,
                                "max": 999999,
                                "control_after_generate": True,
                            }
                        }
                    }
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    seeded_values = iter([111111, 222222])
    monkeypatch.setattr(random, "randint", lambda low, high: next(seeded_values))

    workflow = {
        "145": {"class_type": "KSampler", "inputs": {"seed": 123456, "steps": 20}},
    }

    def make_request() -> Request:
        return _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    ("widget_mode_145_seed", "randomize"),
                ]
            )
        )

    first_response = await comfyui.generate(make_request())
    assert first_response.status_code == 200
    first_payload = _response_json(first_response)
    first_prompt = fake_comfy_client.prompt_payload["prompt"]

    second_response = await comfyui.generate(make_request())
    assert second_response.status_code == 200
    second_payload = _response_json(second_response)
    second_prompt = fake_comfy_client.prompt_payload["prompt"]

    assert first_payload["applied_widget_values"]["145:seed"] == "111111"
    assert second_payload["applied_widget_values"]["145:seed"] == "222222"
    assert first_prompt["145"]["inputs"]["seed"] == 111111
    assert second_prompt["145"]["inputs"]["seed"] == 222222


@pytest.mark.anyio
async def test_generate_expands_dual_sampler_denoise_derived_widget(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_dual_sampler_denoise.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_dual_sampler_denoise.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "145": {
                        "widgets": {
                            "steps": {
                                "value_type": "int",
                                "min": 1,
                                "max": 10,
                                "hidden": True,
                            },
                            "start_step": {
                                "value_type": "int",
                                "min": 0,
                                "max": 9,
                                "hidden": True,
                            },
                            "split_step": {
                                "value_type": "int",
                                "min": 0,
                                "max": 10,
                                "hidden": True,
                            },
                        }
                    },
                    "146": {
                        "widgets": {
                            "start_at_step": {
                                "value_type": "int",
                                "min": 0,
                                "max": 10,
                                "hidden": True,
                            }
                        }
                    },
                },
                "derived_widgets": [
                    {
                        "id": "denoise",
                        "kind": "dual_sampler_denoise",
                        "total_steps": {"node_id": "145", "param": "steps"},
                        "start_step": {"node_id": "145", "param": "start_step"},
                        "base_split_step": {
                            "node_id": "145",
                            "param": "split_step",
                        },
                        "split_step_targets": [
                            {"node_id": "145", "param": "split_step"},
                            {"node_id": "146", "param": "start_at_step"},
                        ],
                    }
                ],
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "145": {
            "class_type": "SamplerA",
            "inputs": {
                "steps": 10,
                "start_step": 2,
                "split_step": 4,
            },
        },
        "146": {
            "class_type": "SamplerB",
            "inputs": {
                "start_at_step": 4,
            },
        },
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    ("derived_widget_denoise", "0.4"),
                ]
            )
        )
    )

    assert response.status_code == 200
    payload = _response_json(response)
    assert payload["applied_widget_values"]["derived:denoise:__value"] == "0.4"
    assert payload["applied_widget_values"]["145:start_step"] == "6"
    assert payload["applied_widget_values"]["145:split_step"] == "6"
    assert payload["applied_widget_values"]["146:start_at_step"] == "6"

    assert fake_comfy_client.prompt_payload is not None
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["145"]["inputs"]["start_step"] == 6
    assert prompt["145"]["inputs"]["split_step"] == 6
    assert prompt["146"]["inputs"]["start_at_step"] == 6


@pytest.mark.anyio
async def test_generate_video_upload_uses_shared_upload_endpoint(tmp_path: Path, monkeypatch):
    workflow_id = "workflow_video_upload_shared_endpoint.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    fake_client = _SharedUploadEndpointComfyClient()

    async def _fake_get_http_client():
        return fake_client

    monkeypatch.setattr(comfyui, "get_http_client", _fake_get_http_client)

    workflow = {
        "145": {"class_type": "LoadVideo", "inputs": {"file": "default.mp4"}},
        "144": {"class_type": "GetVideoComponents", "inputs": {"video": ["145", 0]}},
        "49": {"class_type": "WanVaceToVideo", "inputs": {"control_video": ["144", 0]}},
    }

    video_file = SpooledTemporaryFile()
    video_file.write(b"video-bytes")
    video_file.seek(0)

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    (
                        "video_145",
                        UploadFile(
                            file=_as_binary_io(video_file),
                            filename="clip.mp4",
                            headers=Headers({"content-type": "video/mp4"}),
                        ),
                    ),
                ]
            )
        )
    )

    assert response.status_code == 200
    assert fake_client.image_upload_attempts == 1
    assert fake_client.prompt_payload is not None
    prompt = fake_client.prompt_payload["prompt"]
    assert prompt["145"]["inputs"]["file"] == "uploaded_video.mp4"


@pytest.mark.anyio
async def test_generate_applies_aspect_ratio_processing_and_returns_metadata(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_ar_processing.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_ar_processing.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "aspect_ratio_processing": {
                    "enabled": True,
                    "stride": 32,
                    "search_steps": 2,
                    "target_nodes": [
                        {
                            "node_id": "49",
                            "width_param": "width",
                            "height_param": "height",
                        }
                    ],
                    "postprocess": {
                        "enabled": True,
                        "mode": "stretch_exact",
                        "apply_to": "all_visual_outputs",
                    },
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "49": {
            "class_type": "WanVaceToVideo",
            "inputs": {
                "width": 720,
                "height": 720,
            },
        }
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    ("target_aspect_ratio", "16:9"),
                    ("target_resolution", "1080"),
                ]
            )
        )
    )

    assert response.status_code == 200
    payload = _response_json(response)
    metadata = payload.get("aspect_ratio_processing")
    assert isinstance(metadata, dict)
    assert metadata["requested"]["aspect_ratio"] == "16:9"
    assert metadata["requested"]["resolution"] == 1080
    assert metadata["strided"]["width"] % 32 == 0
    assert metadata["strided"]["height"] % 32 == 0
    assert metadata["postprocess"]["mode"] == "stretch_exact"
    assert metadata["postprocess"]["apply_to"] == "all_visual_outputs"

    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["49"]["inputs"]["width"] == metadata["strided"]["width"]
    assert prompt["49"]["inputs"]["height"] == metadata["strided"]["height"]


@pytest.mark.anyio
async def test_generate_uses_provided_target_aspect_ratio(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_ar_processing_normalized.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_ar_processing_normalized.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "aspect_ratio_processing": {
                    "enabled": True,
                    "stride": 32,
                    "search_steps": 2,
                    "target_nodes": [
                        {
                            "node_id": "49",
                            "width_param": "width",
                            "height_param": "height",
                        }
                    ],
                    "postprocess": {
                        "enabled": True,
                        "mode": "stretch_exact",
                        "apply_to": "all_visual_outputs",
                    },
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "49": {
            "class_type": "WanVaceToVideo",
            "inputs": {
                "width": 720,
                "height": 720,
            },
        }
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    ("target_aspect_ratio", "179:100"),
                    ("target_resolution", "720"),
                ]
            )
        )
    )

    assert response.status_code == 200
    payload = _response_json(response)
    metadata = payload.get("aspect_ratio_processing")
    assert isinstance(metadata, dict)
    assert metadata["requested"]["aspect_ratio"] == "179:100"
    assert metadata["requested"]["width"] == 1289
    assert metadata["requested"]["height"] == 720


@pytest.mark.anyio
async def test_generate_skips_aspect_ratio_processing_when_target_missing(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_ar_missing_target.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_ar_missing_target.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "aspect_ratio_processing": {
                    "enabled": True,
                    "stride": 32,
                    "search_steps": 2,
                    "target_nodes": [
                        {
                            "node_id": "49",
                            "width_param": "width",
                            "height_param": "height",
                        }
                    ],
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "49": {
            "class_type": "WanVaceToVideo",
            "inputs": {
                "width": 720,
                "height": 720,
            },
        }
    }

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                ]
            )
        )
    )

    assert response.status_code == 200
    payload = _response_json(response)
    assert payload.get("aspect_ratio_processing") is None
    assert any(
        warning["code"] == "aspect_ratio_processing_missing_target_aspect_ratio"
        for warning in payload.get("workflow_warnings", [])
    )
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["49"]["inputs"]["width"] == 720
    assert prompt["49"]["inputs"]["height"] == 720


def test_enrich_sidecar_widget_not_in_discovery_resolves_type_from_object_info():
    """Sidecar-declared widgets that discovery would skip (e.g. non-CAG params)
    should still have their value_type, min, max, and default resolved from
    object_info."""
    workflow = {
        "nodes": [
            {
                "id": 67,
                "type": "WanFirstLastFrameToVideo",
                "title": "WanFirstLastFrameToVideo",
                "widgets_values": [832, 480, 81, 1],
            }
        ]
    }
    rules: dict[str, Any] = {
        "version": 1,
        "nodes": {
            "67": {
                "widgets": {
                    "length": {},
                }
            }
        },
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "WanFirstLastFrameToVideo": {
            "input": {
                "required": {
                    "positive": ["CONDITIONING"],
                    "negative": ["CONDITIONING"],
                    "vae": ["VAE"],
                    "width": ["INT", {"default": 832, "min": 16, "max": 16384, "step": 16}],
                    "height": ["INT", {"default": 480, "min": 16, "max": 16384, "step": 16}],
                    "length": ["INT", {"default": 81, "min": 1, "max": 16384, "step": 4}],
                    "batch_size": ["INT", {"default": 1, "min": 1, "max": 4096}],
                },
                "optional": {},
            },
            "input_order": {
                "required": [
                    "positive", "negative", "vae",
                    "width", "height", "length", "batch_size",
                ],
                "optional": [],
            },
        }
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    length = rules["nodes"]["67"]["widgets"]["length"]
    assert length["value_type"] == "int"
    assert length["min"] == 1
    assert length["max"] == 16384
    assert length["default"] == 81


def test_enrich_sidecar_widget_overrides_take_precedence_over_object_info():
    """When the sidecar explicitly sets min/max/default, those should not be
    overwritten by object_info values."""
    workflow = {
        "nodes": [
            {
                "id": 10,
                "type": "ExampleNode",
                "title": "ExampleNode",
                "widgets_values": [50],
            }
        ]
    }
    rules: dict[str, Any] = {
        "version": 1,
        "nodes": {
            "10": {
                "widgets": {
                    "count": {"min": 10, "max": 200, "default": 50},
                }
            }
        },
        "output_injections": {},
        "slots": {},
        "mask_cropping": {"mode": "crop"},
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
    }
    object_info = {
        "ExampleNode": {
            "input": {
                "required": {
                    "count": ["INT", {"default": 1, "min": 0, "max": 9999}],
                },
                "optional": {},
            },
            "input_order": {
                "required": ["count"],
                "optional": [],
            },
        }
    }

    set_object_info_cache(object_info)
    try:
        enrich_rules_with_object_info(rules, workflow)
    finally:
        set_object_info_cache(None)

    count = rules["nodes"]["10"]["widgets"]["count"]
    assert count["value_type"] == "int"
    assert count["min"] == 10
    assert count["max"] == 200
    assert count["default"] == 50
