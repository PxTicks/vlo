from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from services.workflow_rules.schema import ResolvedWorkflowRules


ASSETS_DIR = Path(__file__).parents[1] / "assets" / ".config"
WORKFLOW_NAME = "vlo_minimax_h3_r2v.json"
RULES_NAME = "vlo_minimax_h3_r2v.rules.json"
WORKFLOW_DIRS = (
    ASSETS_DIR / "default_workflows",
    ASSETS_DIR / "high_vram_workflows",
)


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_minimax_h3_reference_workflow_is_packaged_in_both_modes():
    default_workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    high_vram_workflow = _load_json(WORKFLOW_DIRS[1] / WORKFLOW_NAME)
    default_rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    high_vram_rules = _load_json(WORKFLOW_DIRS[1] / RULES_NAME)

    assert high_vram_workflow == default_workflow
    assert high_vram_rules == default_rules
    ResolvedWorkflowRules.model_validate(default_rules)


def test_minimax_h3_reference_workflow_uses_vlo_batch_inputs():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    nodes = {node["id"]: node for node in workflow["nodes"]}
    node_types = [node["type"] for node in workflow["nodes"]]

    assert node_types.count("vloMiniMaxH3ReferenceToVideoBatch") == 1
    assert node_types.count("vloMemoryLoadImageBatch") == 1
    assert node_types.count("vloMemoryLoadVideoBatch") == 1
    assert node_types.count("vloMemoryLoadAudioBatch") == 1
    assert not {
        "LoadImage",
        "LoadAudio",
        "LoadVideo",
        "ResolutionSelector",
        "PrimitiveFloat",
        "PrimitiveStringMultiline",
        "ComfyMathExpression",
    }.intersection(node_types)

    wrapper = nodes[136]
    # Only the link slots are pinned. Recent ComfyUI frontends also serialize
    # widget-backed inputs into `inputs`, so asserting the whole array would
    # break on a re-save that changed nothing about the wiring.
    slot_inputs = [
        input_spec
        for input_spec in wrapper["inputs"]
        if "widget" not in input_spec
    ]
    assert [input_spec["name"] for input_spec in slot_inputs] == [
        "clip",
        "vae",
        "audio_vae",
        "ref_images",
        "ref_videos",
        "ref_video_audios",
        "ref_audios",
    ]
    slots_by_name = {spec["name"]: spec for spec in slot_inputs}
    assert slots_by_name["ref_video_audios"]["link"] is None
    assert wrapper["widgets_values_named"]["use_embedded_video_audio"] is False

    media_links = {
        tuple(link[1:5])
        for link in workflow["links"]
        if link[0] in {283, 284, 285}
    }
    assert media_links == {
        (141, 0, 136, 3),
        (142, 0, 136, 4),
        (143, 0, 136, 6),
    }


def test_minimax_h3_reference_rules_expose_vlo_controls():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)

    # The prompt is presented as a text input (not a string widget) so it picks
    # up prompt carryover between workflows and the extension generation API.
    # It stays in the built-in prompts section: a custom section would wrap the
    # prompt panel in a second panel of the same name.
    assert rules["nodes"]["136"]["present"] == {
        "label": "Prompt",
        "input_type": "text",
        "param": "prompt",
    }
    assert "prompt" not in rules["nodes"]["136"]["widgets"]
    # Declaration order is also the panel order here; the built-in Inputs and
    # Prompts panels sort ahead of all four on their own metadata.
    assert [section["id"] for section in rules["sections"]] == [
        "video_generation",
        "lora_loaders",
        "references",
        "advanced_settings",
    ]
    assert [section["order"] for section in rules["sections"]] == [2, 3, 4, 5]
    length_widget = rules["nodes"]["136"]["widgets"]["length"]
    # H3 requires 17k+5 frames, so 22 frames is the closest valid point to 1s.
    assert length_widget["min"] == 22
    assert length_widget["max"] == 600
    assert length_widget["step"] == 17
    assert length_widget["display_unit"]["scale"] == 1 / 24
    assert rules["nodes"]["141"]["present"] == {
        "label": "Image inputs",
        "input_type": "image",
        "param": "images",
        "class_type": "vloMemoryLoadImageBatch",
        "section_id": "inputs",
        "repeatable": {"max": 9},
        "required": False,
    }
    assert rules["nodes"]["142"]["present"]["class_type"] == (
        "vloMemoryLoadVideoBatch"
    )
    assert rules["nodes"]["142"]["present"]["repeatable"] == {"max": 3}
    assert rules["nodes"]["143"]["present"]["class_type"] == (
        "vloMemoryLoadAudioBatch"
    )
    assert rules["nodes"]["143"]["present"]["repeatable"] == {"max": 3}
    assert rules["nodes"]["136"]["widgets"]["use_embedded_video_audio"][
        "default"
    ] is False
    assert rules["validation"]["inputs"][0]["inputs"] == ["141", "142", "143"]
    assert rules["rewrites"][:3] == [
        {
            "when": {
                "kind": "input_presence",
                "inputs": [node_id],
                "match": "all_missing",
            },
            "bypass": [node_id],
        }
        for node_id in ("141", "142", "143")
    ]
    expected_resolutions = [
        240,
        480,
        540,
        720,
    ]
    assert rules["pipeline"][0]["config"]["resolutions"] == expected_resolutions
    assert rules["pipeline"][0]["controls"][0]["options"] == (
        expected_resolutions
    )
    assert rules["pipeline"][0]["targets"] == [
        {
            "width": {"node_id": "136", "param": "width"},
            "height": {"node_id": "136", "param": "height"},
        }
    ]


def test_minimax_h3_reference_model_patch_controls():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    node_types = {str(node["id"]): node["type"] for node in workflow["nodes"]}

    attention = rules["nodes"]["145"]["widgets"]["attention"]
    assert node_types["145"] == "ModelAttentionBackend"
    assert attention["section_id"] == "advanced_settings"
    assert attention["group_id"] == "model_patches"

    # Spectrum is a frontend-only toggle rather than a widget rule: the node's
    # own `enabled` input stays as the graph ships it, and the panel switch
    # bypasses the whole node instead.
    spectrum = rules["frontend_controls"]["spectrum_enabled"]
    assert spectrum["value_type"] == "boolean"
    assert spectrum["default"] is True
    assert spectrum["group_id"] == "model_patches"

    spectrum_rewrite = rules["rewrites"][3]
    assert spectrum_rewrite["when"]["ref"]["control_id"] == "spectrum_enabled"
    assert spectrum_rewrite["when"]["value"] is False
    # This workflow numbers Spectrum 146 and the LoRA loader 148, while the i2v
    # workflow numbers Spectrum 148. Pinning the resolved type is what keeps a
    # copied rule from bypassing the wrong node.
    assert spectrum_rewrite["bypass"] == ["146"]
    assert node_types["146"] == "SpectrumApplyMiniMaxH3"


def test_minimax_h3_reference_lora_loader_ships_bypassed():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)

    lora = rules["nodes"]["148"]["widgets"]["lora_name"]
    assert lora["discover_when_bypassed"] is True
    assert lora["default_node_bypass"] is True
    assert "options" not in lora
    assert lora["section_id"] == "lora_loaders"

    loader = next(node for node in workflow["nodes"] if node["id"] == 148)
    assert loader["type"] == "LoraLoaderModelOnly"
    # Ships bypassed on purpose: ComfyUI's missing-model scan skips mode 2 and 4
    # nodes, which is what stops the placeholder LoRA raising the download
    # dialog for users who do not have that file.
    assert loader["mode"] == 4


def test_shipped_rules_never_bypass_a_node_the_panel_can_activate():
    """A node cannot be both rule-bypassed and panel-activated.

    The submission rejects that combination outright, so an overlap here would
    be a generation that fails at dispatch rather than a preference applied
    quietly. Node ids are not stable across workflows, which is exactly how a
    copied rewrite ends up pointing at the wrong node.
    """
    for rules_path in sorted(ASSETS_DIR.glob("*/*.rules.json")):
        rules = _load_json(rules_path)
        activatable = {
            node_id
            for node_id, node in (rules.get("nodes") or {}).items()
            for widget in (node.get("widgets") or {}).values()
            if widget.get("discover_when_bypassed")
        }
        if not activatable:
            continue

        bypassed: set[str] = set()
        for rewrite in rules.get("rewrites") or []:
            bypassed.update(rewrite.get("bypass") or [])
        for switch in rules.get("effect_switches") or []:
            for case in switch.get("cases") or []:
                bypassed.update(case.get("bypass") or [])

        assert not (activatable & bypassed), rules_path
