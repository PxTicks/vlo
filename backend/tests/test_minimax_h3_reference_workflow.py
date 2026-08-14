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
    assert [input_spec["name"] for input_spec in wrapper["inputs"]] == [
        "clip",
        "vae",
        "audio_vae",
        "ref_images",
        "ref_videos",
        "ref_video_audios",
        "ref_audios",
    ]
    assert wrapper["inputs"][5]["link"] is None
    assert wrapper["widgets_values"][-1] is False

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

    assert rules["nodes"]["136"]["present"] == {"enabled": False}
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
    assert rules["rewrites"] == [
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
