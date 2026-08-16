from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from services.workflow_rules.schema import ResolvedWorkflowRules


ASSETS_DIR = Path(__file__).parents[1] / "assets" / ".config"
WORKFLOW_NAME = "vlo_minimax_h3_i2v.json"
RULES_NAME = "vlo_minimax_h3_i2v.rules.json"
WORKFLOW_DIRS = (
    ASSETS_DIR / "default_workflows",
    ASSETS_DIR / "high_vram_workflows",
)


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_minimax_h3_image_to_video_workflow_is_packaged_in_both_modes():
    default_workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    high_vram_workflow = _load_json(WORKFLOW_DIRS[1] / WORKFLOW_NAME)
    default_rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    high_vram_rules = _load_json(WORKFLOW_DIRS[1] / RULES_NAME)

    assert high_vram_workflow == default_workflow
    assert high_vram_rules == default_rules
    ResolvedWorkflowRules.model_validate(default_rules)


def test_minimax_h3_image_to_video_workflow_is_flat_and_vlo_native():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    node_types = [node["type"] for node in workflow["nodes"]]

    # Rules address executable node ids, so the upstream template's subgraph
    # wrapper is flattened rather than kept.
    assert "definitions" not in workflow
    assert node_types.count("MiniMaxH3ImageToVideo") == 1
    assert node_types.count("vloMemoryLoadImage") == 2
    assert not {
        "LoadImage",
        "ComfyMathExpression",
        "PrimitiveFloat",
        "ImageScaleToTotalPixels",
        "GetImageSize",
    }.intersection(node_types)


def test_minimax_h3_image_to_video_keyframes_are_optional_connections():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    nodes = {node["id"]: node for node in workflow["nodes"]}

    generator = nodes[136]
    inputs = {input_spec["name"]: input_spec for input_spec in generator["inputs"]}
    # shape 7 marks the slot optional, so a bypassed keyframe branch still
    # produces a valid prompt (t2va).
    assert inputs["first_frame"]["shape"] == 7
    assert inputs["last_frame"]["shape"] == 7

    links = {link[0]: tuple(link[1:5]) for link in workflow["links"]}
    # start frame -> resize -> first_frame, end frame -> resize -> last_frame
    assert links[inputs["first_frame"]["link"]][:2] == (143, 0)
    assert links[inputs["last_frame"]["link"]][:2] == (144, 0)
    assert links[nodes[143]["inputs"][0]["link"]][:2] == (141, 0)
    assert links[nodes[144]["inputs"][0]["link"]][:2] == (142, 0)

    # Both keyframes stretch to the generation canvas, so neither is cropped.
    for resize_id in (143, 144):
        assert nodes[resize_id]["widgets_values"][0] == "scale dimensions"
        assert nodes[resize_id]["widgets_values"][3] == "disabled"

    # The labelled Width/Height primitives drive the generator and both resizes.
    assert nodes[145]["title"] == "Width"
    assert nodes[146]["title"] == "Height"
    assert {links[link_id] for link_id in nodes[145]["outputs"][0]["links"]} == {
        (145, 0, 136, 4),
        (145, 0, 143, 1),
        (145, 0, 144, 1),
    }
    assert {links[link_id] for link_id in nodes[146]["outputs"][0]["links"]} == {
        (146, 0, 136, 5),
        (146, 0, 143, 2),
        (146, 0, 144, 2),
    }


def test_minimax_h3_image_to_video_rules_require_neither_frame():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)

    assert rules["validation"]["inputs"] == [
        {"kind": "optional", "input": "141"},
        {"kind": "optional", "input": "142"},
    ]
    assert rules["nodes"]["141"]["present"] == {
        "label": "Start frame",
        "group_id": "frames",
        "group_title": "Frames",
        "group_order": 0,
        "required": False,
        "input_type": "image",
        "param": "image",
        "class_type": "vloMemoryLoadImage",
    }
    assert rules["nodes"]["142"]["present"]["label"] == "End frame"
    assert rules["nodes"]["142"]["present"]["required"] is False

    # A missing frame bypasses its loader together with its resize node, so the
    # generator's optional slot is left unconnected instead of dangling.
    assert rules["rewrites"] == [
        {
            "when": {
                "kind": "input_presence",
                "inputs": [loader_id],
                "match": "all_missing",
            },
            "bypass": [loader_id, resize_id],
        }
        for loader_id, resize_id in (("141", "143"), ("142", "144"))
    ]


def test_minimax_h3_image_to_video_rules_expose_length_and_aspect_ratio():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)

    length_widget = rules["nodes"]["136"]["widgets"]["length"]
    # H3 requires 17k+5 frames, so 22 frames is the closest valid point to 1s
    # and 600 frames is exactly 25s at 24fps.
    assert length_widget["min"] == 22
    assert length_widget["max"] == 600
    assert length_widget["step"] == 17
    assert (length_widget["max"] - length_widget["min"]) % length_widget["step"] == 0
    assert length_widget["display_unit"]["scale"] == 1 / 24

    stage = rules["pipeline"][0]
    assert stage["kind"] == "aspect_ratio"
    assert stage["config"]["stride"] == 32
    assert stage["targets"] == [
        {
            "width": {"node_id": "145", "param": "value"},
            "height": {"node_id": "146", "param": "value"},
        }
    ]
    expected_resolutions = [240, 480, 540, 720]
    assert stage["config"]["resolutions"] == expected_resolutions
    assert stage["controls"][0]["options"] == expected_resolutions
    # The aspect-ratio targets are the widgets the panel hides, not edits.
    assert rules["nodes"]["145"]["widgets"]["value"]["hidden"] is True
    assert rules["nodes"]["146"]["widgets"]["value"]["hidden"] is True
