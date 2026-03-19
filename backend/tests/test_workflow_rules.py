import json
import os
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
    apply_rules_to_workflow,
    collect_mask_crop_pairs,
    evaluate_input_validation,
    enrich_rules_with_object_info,
    find_unsatisfied_input_conditions,
    load_rules_for_workflow,
)
from services.workflow_rules.object_info import set_object_info_cache  # noqa: E402


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


def test_enrich_rules_with_object_info_defaults_ksampler_to_all_widgets():
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
    assert list(widgets.keys()) == [
        "seed",
        "steps",
        "cfg",
        "sampler_name",
        "scheduler",
        "denoise",
    ]
    assert widgets["seed"]["control_after_generate"] is True
    assert widgets["steps"]["value_type"] == "int"
    assert widgets["cfg"]["value_type"] == "float"
    assert widgets["sampler_name"]["options"] == ["euler", "heun"]
    assert widgets["scheduler"]["options"] == ["normal", "karras"]
    assert widgets["denoise"]["min"] == 0
    assert widgets["denoise"]["max"] == 1


def test_enrich_rules_with_object_info_defaults_ksampler_advanced_to_all_widgets():
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
    assert list(widgets.keys()) == [
        "add_noise",
        "noise_seed",
        "steps",
        "cfg",
        "sampler_name",
        "scheduler",
        "start_at_step",
        "end_at_step",
        "return_with_leftover_noise",
    ]
    assert widgets["add_noise"]["value_type"] == "enum"
    assert widgets["noise_seed"]["control_after_generate"] is True
    assert widgets["start_at_step"]["min"] == 0
    assert widgets["return_with_leftover_noise"]["options"] == [
        "enable",
        "disable",
    ]


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


def test_apply_rules_manual_slot_payload_rewrites_links():
    workflow = {
        "144": {"class_type": "GetVideoComponents", "inputs": {"video": ["145", 0]}},
        "145": {"class_type": "LoadVideo", "inputs": {"file": "default.mp4"}},
        "49": {"class_type": "WanVaceToVideo", "inputs": {"control_video": ["144", 0]}},
    }
    rules = {
        "version": 1,
        "output_injections": {
            "144": {
                "0": {
                    "source": {"kind": "manual_slot", "slot_id": "control_frames"}
                }
            }
        },
    }

    rewritten, warnings = apply_rules_to_workflow(
        workflow,
        rules,
        manual_slot_values={"control_frames": ["frame_000.png", "frame_001.png"]},
    )
    assert warnings == []
    assert rewritten["49"]["inputs"]["control_video"] == ["frame_000.png", "frame_001.png"]


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

    async def post(self, url: str, **kwargs):
        if url == "/upload/image":
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
async def test_generate_returns_rule_warnings(tmp_path: Path, monkeypatch, fake_comfy_client):
    _ = fake_comfy_client

    workflow_id = "workflow_warning_test.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_warning_test.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "output_injections": {
                    "144": {
                        "0": {
                            "source": {"kind": "manual_slot", "slot_id": "control_frames"}
                        }
                    }
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "144": {"class_type": "GetVideoComponents", "inputs": {"video": ["145", 0]}},
        "145": {"class_type": "LoadVideo", "inputs": {"file": "default.mp4"}},
        "49": {"class_type": "WanVaceToVideo", "inputs": {"control_video": ["144", 0]}},
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
    assert any(w["code"] == "manual_slot_missing_payload" for w in payload["workflow_warnings"])


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
async def test_generate_ignores_manual_frame_batch_slot_uploads(tmp_path: Path, monkeypatch, fake_comfy_client):
    workflow_id = "workflow_manual_frame_slot.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_manual_frame_slot.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "output_injections": {
                    "144": {
                        "0": {
                            "source": {"kind": "manual_slot", "slot_id": "control_frames"}
                        }
                    }
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "144": {"class_type": "GetVideoComponents", "inputs": {"video": ["145", 0]}},
        "145": {"class_type": "LoadVideo", "inputs": {"file": "default.mp4"}},
        "49": {"class_type": "WanVaceToVideo", "inputs": {"control_video": ["144", 0]}},
    }

    frame_a = SpooledTemporaryFile()
    frame_a.write(b"frame-a")
    frame_a.seek(0)
    frame_b = SpooledTemporaryFile()
    frame_b.write(b"frame-b")
    frame_b.seek(0)

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    (
                        "slot_frame_control_frames",
                        UploadFile(
                            file=_as_binary_io(frame_a),
                            filename="frame-a.png",
                            headers=Headers({"content-type": "image/png"}),
                        ),
                    ),
                    (
                        "slot_frame_control_frames",
                        UploadFile(
                            file=_as_binary_io(frame_b),
                            filename="frame-b.png",
                            headers=Headers({"content-type": "image/png"}),
                        ),
                    ),
                ]
            )
        )
    )
    assert response.status_code == 200
    payload = _response_json(response)
    assert any(w["code"] == "manual_slot_missing_payload" for w in payload["workflow_warnings"])
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["49"]["inputs"]["control_video"] == ["144", 0]


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
async def test_generate_slot_audio_upload_uses_shared_upload_endpoint(
    tmp_path: Path,
    monkeypatch,
    fake_comfy_client,
):
    workflow_id = "workflow_audio_slot_upload_shared_endpoint.json"
    workflow_path = tmp_path / workflow_id
    workflow_path.write_text("{}")
    sidecar_path = tmp_path / "workflow_audio_slot_upload_shared_endpoint.rules.json"
    sidecar_path.write_text(
        json.dumps(
            {
                "version": 1,
                "output_injections": {
                    "200": {
                        "0": {
                            "source": {"kind": "manual_slot", "slot_id": "voice_audio"}
                        }
                    }
                },
            }
        )
    )
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    workflow = {
        "200": {"class_type": "AudioSource", "inputs": {}},
        "201": {"class_type": "AudioConsumer", "inputs": {"audio": ["200", 0]}},
    }

    audio_file = SpooledTemporaryFile()
    audio_file.write(b"audio-bytes")
    audio_file.seek(0)

    response = await comfyui.generate(
        _as_request(
            FormData(
                [
                    ("workflow", json.dumps(workflow)),
                    ("workflow_id", workflow_id),
                    (
                        "slot_audio_voice_audio",
                        UploadFile(
                            file=_as_binary_io(audio_file),
                            filename="voice.wav",
                            headers=Headers({"content-type": "audio/wav"}),
                        ),
                    ),
                ]
            )
        )
    )

    assert response.status_code == 200
    prompt = fake_comfy_client.prompt_payload["prompt"]
    assert prompt["201"]["inputs"]["audio"] == "uploaded_audio.wav"


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
