import asyncio
import json

import pytest

from routers import comfyui
from services.workflow_rules.object_info import set_object_info_cache


class DummyRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


class DummyUploadFile:
    def __init__(self, filename: str, payload: bytes):
        self.filename = filename
        self._payload = payload

    async def read(self):
        return self._payload


def test_repeatable_media_form_keys_preserve_node_param_and_index():
    assert comfyui._parse_repeatable_node_input_form_key(
        "141_images__repeat_2"
    ) == ("141", "images", 2)
    assert comfyui._parse_repeatable_node_input_form_key("141_images") == (
        "141",
        "images",
        None,
    )


def test_save_workflow_content_persists_to_backend_workflows_dir(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)
    monkeypatch.setattr(
        comfyui,
        "OBJECT_INFO_PATH",
        tmp_path / ".config" / "object_info.json",
    )

    payload = {
        "workflow": {"nodes": [{"id": 1}], "extra": {"source": "test"}},
        "object_info": {"LoadImage": {"input": {}}},
    }
    result = asyncio.run(
        comfyui.save_workflow_content(
            "wf.json", DummyRequest(payload)
        )
    )

    assert result == {
        "workflow_id": "wf.json",
        "saved": True,
        "object_info_saved": True,
    }
    assert json.loads((tmp_path / "wf.json").read_text(encoding="utf-8")) == {
        "nodes": [{"id": 1}],
        "extra": {"source": "test"},
    }
    assert json.loads(
        (tmp_path / ".config" / "object_info.json").read_text(encoding="utf-8")
    ) == {"LoadImage": {"input": {}}}


def test_upload_workflow_files_persists_workflows_and_rules_sidecars(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)

    result = asyncio.run(
        comfyui.upload_workflow_files(
            [
                DummyUploadFile(
                    filename="dragged-workflow.json",
                    payload=b'{"nodes":[{"id":1}]}',
                ),
                DummyUploadFile(
                    filename="dragged-workflow.rules.json",
                    payload=b'{"name":"Dragged Workflow"}',
                ),
            ]
        )
    )

    assert result == {
        "uploaded": [
            {
                "filename": "dragged-workflow.json",
                "kind": "workflow",
                "workflow_id": "dragged-workflow.json",
            },
            {
                "filename": "dragged-workflow.rules.json",
                "kind": "rules",
                "workflow_id": "dragged-workflow.json",
            },
        ]
    }
    assert json.loads(
        (tmp_path / "dragged-workflow.json").read_text(encoding="utf-8")
    ) == {"nodes": [{"id": 1}]}
    assert json.loads(
        (tmp_path / "dragged-workflow.rules.json").read_text(encoding="utf-8")
    ) == {"name": "Dragged Workflow"}


def test_list_workflows_applies_menu_groups_and_preserves_shadowing(
    tmp_path, monkeypatch
):
    workflows_dir = tmp_path / "workflows"
    default_workflows_dir = tmp_path / "default_workflows"
    workflow_menu_path = tmp_path / "workflow_menu.json"
    workflows_dir.mkdir()
    default_workflows_dir.mkdir()

    (workflows_dir / "shared.json").write_text("{}", encoding="utf-8")
    (default_workflows_dir / "shared.json").write_text("{}", encoding="utf-8")
    (default_workflows_dir / "core.json").write_text("{}", encoding="utf-8")
    (default_workflows_dir / "zzz.json").write_text("{}", encoding="utf-8")
    workflow_menu_path.write_text(
        json.dumps(
            {
                "version": 1,
                "groups": [
                    {
                        "id": "default",
                        "name": "Default",
                        "order": 0,
                        "workflow_ids": ["shared.json"],
                    },
                    {
                        "id": "core",
                        "name": "Core",
                        "order": 1,
                        "workflow_ids": ["core.json"],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", workflows_dir)
    monkeypatch.setattr(comfyui, "DEFAULT_WORKFLOWS_DIR", default_workflows_dir)
    monkeypatch.setattr(
        comfyui,
        "get_packaged_workflows_dir",
        lambda: default_workflows_dir,
    )
    monkeypatch.setattr(comfyui, "WORKFLOW_MENU_CONFIG_PATH", workflow_menu_path)

    workflows = asyncio.run(comfyui.list_workflows())

    assert workflows == [
        {
            "id": "shared.json",
            "name": "shared",
            "group_id": "default",
            "group_name": "Default",
            "group_order": 0,
        },
        {
            "id": "core.json",
            "name": "core",
            "group_id": "core",
            "group_name": "Core",
            "group_order": 1,
        },
        {
            "id": "zzz.json",
            "name": "zzz",
        },
    ]


def test_workflow_menu_v2_merges_custom_legacy_groups(tmp_path, monkeypatch):
    packaged_path = tmp_path / "packaged.json"
    custom_path = tmp_path / "custom.json"
    packaged_path.write_text(
        json.dumps(
            {
                "version": 2,
                "nodes": [
                    {
                        "id": "image",
                        "kind": "category",
                        "label": "Image",
                        "parent_id": None,
                        "order": 0,
                    },
                    {
                        "id": "image.generate",
                        "kind": "folder",
                        "label": "Generate",
                        "parent_id": "image",
                        "order": 0,
                    },
                ],
                "leaf_placements": [
                    {
                        "workflow_id": "flux.json",
                        "parent_id": "image.generate",
                        "order": 0,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    custom_path.write_text(
        json.dumps(
            {
                "version": 1,
                "groups": [
                    {
                        "id": "custom",
                        "name": "Custom",
                        "workflow_ids": ["custom.json"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(comfyui, "WORKFLOW_MENU_CONFIG_PATH", packaged_path)
    monkeypatch.setattr(comfyui, "CUSTOM_WORKFLOW_MENU_PATH", custom_path)

    assert asyncio.run(comfyui.get_workflow_menu()) == {
        "version": 1,
        "id": "generation.workflows",
        "nodes": [
            {
                "id": "image",
                "kind": "category",
                "label": "Image",
                "parentId": None,
                "order": 0,
            },
            {
                "id": "image.generate",
                "kind": "folder",
                "label": "Generate",
                "parentId": "image",
                "order": 0,
            },
            {
                "id": "custom",
                "kind": "folder",
                "label": "Custom",
                "parentId": None,
                "order": 0,
            },
        ],
        "leafPlacements": [
            {"leafId": "flux.json", "parentId": "image.generate", "order": 0},
            {"leafId": "custom.json", "parentId": "custom", "order": 0},
        ],
    }


def test_packaged_workflow_menu_has_exact_image_video_structure():
    tree = comfyui._parse_workflow_menu_tree(comfyui.WORKFLOW_MENU_CONFIG_PATH)

    assert [(node["id"], node["kind"], node["label"]) for node in tree["nodes"]] == [
        ("image", "category", "Image"),
        ("image.generate", "folder", "Generate"),
        ("image.enhance", "folder", "Enhance"),
        ("video", "category", "Video"),
        ("video.generate", "folder", "Generate"),
        ("video.edit", "folder", "Edit"),
        ("video.control", "folder", "Control"),
        ("video.enhance", "folder", "Enhance"),
    ]
    assert {
        placement["leafId"]: placement["parentId"]
        for placement in tree["leafPlacements"]
    } == {
        "vlo_klein_multi.json": "image.generate",
        "vlo_SeedVR2_image.json": "image.enhance",
        "vlo_ltx2_3.json": "video.generate",
        "vlo_wan2_2.json": "video.generate",
        "vlo_VACE_inpaint.json": "video.edit",
        "vlo_ltx2_3_inpaint.json": "video.edit",
        "vlo_ltx2_3_ic_edit.json": "video.edit",
        "vlo_wan_ttm.json": "video.control",
        "vlo_wan_animate.json": "video.control",
        "vlo_SeedVR2_video.json": "video.enhance",
        "vlo_gimm_vfi.json": "video.enhance",
    }


def test_resolve_workflow_rules_uses_graph_data_for_randomized_control_after_generate():
    payload = {
        "workflow_id": "wf.json",
        "workflow": {
            "4814": {
                "class_type": "RandomNoise",
                "inputs": {
                    "noise_seed": 42,
                },
            }
        },
        "graph_data": {
            "nodes": [
                {
                    "id": 4814,
                    "type": "RandomNoise",
                    "title": "RandomNoise",
                    "inputs": [],
                    "widgets_values": [42, "randomize"],
                }
            ]
        },
    }
    object_info = {
        "RandomNoise": {
            "input": {
                "required": {
                    "noise_seed": [
                        "INT",
                        {
                            "min": 0,
                            "max": 99,
                            "control_after_generate": True,
                        },
                    ]
                }
            },
            "input_order": {
                "required": ["noise_seed"],
            },
        }
    }

    set_object_info_cache(object_info)
    try:
        result = asyncio.run(
            comfyui.resolve_workflow_rules(
                DummyRequest(payload)
            )
        )
    finally:
        set_object_info_cache(None)

    widget = result["rules"]["nodes"]["4814"]["widgets"]["noise_seed"]
    assert widget["control_after_generate"] is True
    assert widget["default_randomize"] is True
    assert widget["value_type"] == "int"


def test_resolve_workflow_rules_supports_inline_workflow_without_id():
    payload = {
        "workflow": {
            "701": {
                "class_type": "SeedVR2VideoUpscaler",
                "inputs": {},
            }
        },
    }
    object_info = {
        "SeedVR2VideoUpscaler": {
            "input": {
                "required": {
                    "seed": [
                        "INT",
                        {
                            "default": 42,
                            "min": 0,
                            "max": 4294967295,
                        },
                    ],
                }
            },
            "input_order": {
                "required": ["seed"],
            },
        }
    }

    set_object_info_cache(object_info)
    try:
        result = asyncio.run(
            comfyui.resolve_workflow_rules(
                DummyRequest(payload)
            )
        )
    finally:
        set_object_info_cache(None)

    assert result["workflow_id"] == ""
    assert result["has_sidecar"] is False
    assert result["warnings"] == []
    assert result["rules"]["nodes"]["701"]["widgets"]["seed"]["default"] == 42


def test_resolve_workflow_rules_always_surfaces_seed_without_node_policy():
    payload = {
        "workflow_id": "wf.json",
        "workflow": {
            "701": {
                "class_type": "SeedVR2VideoUpscaler",
                "inputs": {},
            }
        },
    }
    object_info = {
        "SeedVR2VideoUpscaler": {
            "input": {
                "required": {
                    "image": ["IMAGE"],
                    "dit": ["SEEDVR2_DIT"],
                    "vae": ["SEEDVR2_VAE"],
                    "seed": [
                        "INT",
                        {
                            "default": 42,
                            "min": 0,
                            "max": 4294967295,
                        },
                    ],
                    "resolution": [
                        "INT",
                        {
                            "default": 1080,
                            "min": 16,
                            "max": 16384,
                        },
                    ],
                }
            },
            "input_order": {
                "required": ["image", "dit", "vae", "seed", "resolution"],
            },
        }
    }

    set_object_info_cache(object_info)
    try:
        result = asyncio.run(
            comfyui.resolve_workflow_rules(
                DummyRequest(payload)
            )
        )
    finally:
        set_object_info_cache(None)

    widgets = result["rules"]["nodes"]["701"]["widgets"]
    assert set(widgets) == {"seed"}
    assert widgets["seed"]["default"] == 42
    assert widgets["seed"]["value_type"] == "int"
    assert widgets["seed"]["control_after_generate"] is True


def test_resolve_workflow_rules_prefers_graph_widget_values_over_object_info_defaults():
    payload = {
        "workflow_id": "vlo_VACE_inpaint.json",
        "workflow": {
            "115": {
                "class_type": "KSamplerAdvanced",
                "inputs": {},
            }
        },
        "graph_data": {
            "nodes": [
                {
                    "id": 115,
                    "type": "KSamplerAdvanced",
                    "title": "KSamplerAdvanced",
                    "inputs": [],
                    "widgets_values": [
                        "enable",
                        6332,
                        "randomize",
                        6,
                        1,
                        "uni_pc",
                        "simple",
                        0,
                        10000,
                        "disable",
                    ],
                }
            ]
        },
    }
    object_info = {
        "KSamplerAdvanced": {
            "input": {
                "required": {
                    "model": ["MODEL"],
                    "add_noise": [["enable", "disable"], {}],
                    "noise_seed": [
                        "INT",
                        {
                            "default": 0,
                            "min": 0,
                            "max": 18446744073709551615,
                            "control_after_generate": True,
                        },
                    ],
                    "steps": [
                        "INT",
                        {
                            "default": 20,
                            "min": 1,
                            "max": 10000,
                        },
                    ],
                    "cfg": [
                        "FLOAT",
                        {
                            "default": 8.0,
                            "min": 0.0,
                            "max": 100.0,
                        },
                    ],
                    "sampler_name": [["uni_pc", "euler"], {}],
                    "scheduler": [["simple", "karras"], {}],
                    "positive": ["CONDITIONING"],
                    "negative": ["CONDITIONING"],
                    "latent_image": ["LATENT"],
                    "start_at_step": [
                        "INT",
                        {
                            "default": 0,
                            "min": 0,
                            "max": 10000,
                        },
                    ],
                    "end_at_step": [
                        "INT",
                        {
                            "default": 10000,
                            "min": 0,
                            "max": 10000,
                        },
                    ],
                    "return_with_leftover_noise": [["disable", "enable"], {}],
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
                ],
            },
        }
    }

    set_object_info_cache(object_info)
    try:
        result = asyncio.run(
            comfyui.resolve_workflow_rules(
                DummyRequest(payload)
            )
        )
    finally:
        set_object_info_cache(None)

    node_115 = result["rules"]["nodes"]["115"]
    assert node_115["widgets"]["noise_seed"]["default"] == 6332
    assert node_115["widgets"]["cfg"]["default"] == 1
    assert node_115["widgets"]["steps"]["default"] == 6
    assert node_115["widgets"]["start_at_step"]["default"] == 0
    assert result["rules"]["derived_widgets"][0]["id"] == "single_sampler_denoise"
    assert result["rules"]["derived_widgets"][0]["kind"] == "single_sampler_denoise"
    assert result["rules"]["derived_widgets"][0]["total_steps"] == {
        "node_id": "115",
        "param": "steps",
    }
    assert result["rules"]["derived_widgets"][0]["start_step"] == {
        "node_id": "115",
        "param": "start_at_step",
    }


def test_resolve_workflow_rules_uses_hardcoded_fallback_when_object_info_missing():
    """When object_info has no entry for a class, the hardcoded fallback
    surfaces seed/randomize widgets from graph widgets_values."""
    payload = {
        "workflow_id": "wf.json",
        "workflow": {
            "134": {
                "class_type": "RandomNoise",
                "inputs": {},
            }
        },
        "graph_data": {
            "nodes": [
                {
                    "id": 134,
                    "type": "RandomNoise",
                    "widgets_values": [524621350995903, "randomize"],
                }
            ]
        },
    }

    # object_info empty — the class isn't registered
    set_object_info_cache({})
    try:
        result = asyncio.run(
            comfyui.resolve_workflow_rules(DummyRequest(payload))
        )
    finally:
        set_object_info_cache(None)

    widgets = result["rules"]["nodes"]["134"]["widgets"]
    assert "noise_seed" in widgets
    assert widgets["noise_seed"]["default"] == 524621350995903
    assert widgets["noise_seed"]["control_after_generate"] is True
    assert widgets["noise_seed"]["default_randomize"] is True


def test_resolve_workflow_rules_fallback_skips_fixed_primitive_int():
    """PrimitiveInt with mode=fixed should NOT surface via fallback (only
    randomize mode and named seeds get surfaced)."""
    payload = {
        "workflow_id": "wf.json",
        "workflow": {
            "163": {"class_type": "PrimitiveInt", "inputs": {}},
            "165": {"class_type": "PrimitiveInt", "inputs": {}},
        },
        "graph_data": {
            "nodes": [
                {
                    "id": 163,
                    "type": "PrimitiveInt",
                    "widgets_values": [1280, "fixed"],
                },
                {
                    "id": 165,
                    "type": "PrimitiveInt",
                    "widgets_values": [720, "randomize"],
                },
            ]
        },
    }

    set_object_info_cache({})
    try:
        result = asyncio.run(
            comfyui.resolve_workflow_rules(DummyRequest(payload))
        )
    finally:
        set_object_info_cache(None)

    node_163 = result["rules"]["nodes"].get("163") or {}
    node_165 = result["rules"]["nodes"]["165"]
    assert not node_163.get("widgets")
    assert node_165["widgets"]["value"]["default"] == 720
    assert node_165["widgets"]["value"]["default_randomize"] is True


def test_parse_workflow_inputs_includes_vhs_load_video_ffmpeg_static_fallback(
    monkeypatch,
):
    monkeypatch.setattr(comfyui, "build_input_node_map", lambda: {})

    inputs = comfyui._parse_workflow_inputs(
        {
            "644": {
                "class_type": "VHS_LoadVideoFFmpeg",
                "inputs": {
                    "video": "source.mp4",
                },
                "_meta": {
                    "title": "Source video",
                },
            }
        }
    )

    assert inputs == [
        {
            "id": "644:video",
            "nodeId": "644",
            "classType": "VHS_LoadVideoFFmpeg",
            "inputType": "video",
            "param": "video",
            "label": "Source video",
            "description": None,
            "currentValue": "source.mp4",
        }
    ]
