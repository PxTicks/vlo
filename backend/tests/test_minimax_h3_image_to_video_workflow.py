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


def _input_index(node: dict[str, Any], name: str) -> int:
    """Slot index of a node input by name.

    Addressed by name rather than position: refreshing a node from an upstream
    template can add inputs ahead of the ones under test, which shifts every
    later index without changing any wiring.
    """
    for index, spec in enumerate(node["inputs"]):
        if spec["name"] == name:
            return index
    raise AssertionError(f"node {node['id']} has no input named {name!r}")


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
    assert links[nodes[143]["inputs"][_input_index(nodes[143], "input")]["link"]][:2] == (
        141,
        0,
    )
    assert links[nodes[144]["inputs"][_input_index(nodes[144], "input")]["link"]][:2] == (
        142,
        0,
    )

    # Both keyframes stretch to the generation canvas, so neither is cropped.
    for resize_id in (143, 144):
        assert nodes[resize_id]["widgets_values"][0] == "scale dimensions"
        assert nodes[resize_id]["widgets_values"][3] == "disabled"

    # The labelled Width/Height primitives drive the generator and both resizes.
    assert nodes[145]["title"] == "Width"
    assert nodes[146]["title"] == "Height"
    assert {links[link_id] for link_id in nodes[145]["outputs"][0]["links"]} == {
        (145, 0, 136, _input_index(nodes[136], "width")),
        (145, 0, 143, _input_index(nodes[143], "resize_type.width")),
        (145, 0, 144, _input_index(nodes[144], "resize_type.width")),
    }
    assert {links[link_id] for link_id in nodes[146]["outputs"][0]["links"]} == {
        (146, 0, 136, _input_index(nodes[136], "height")),
        (146, 0, 143, _input_index(nodes[143], "resize_type.height")),
        (146, 0, 144, _input_index(nodes[144], "resize_type.height")),
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
    # Membership, not equality: the advanced-settings toggles add their own
    # rewrites and are asserted separately.
    for loader_id, resize_id in (("141", "143"), ("142", "144")):
        assert {
            "when": {
                "kind": "input_presence",
                "inputs": [loader_id],
                "match": "all_missing",
            },
            "bypass": [loader_id, resize_id],
        } in rules["rewrites"]


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
    # The panel interpolates the range into 240/360/480/600/720 rungs and
    # keeps a custom override open, so no whitelist is enumerated.
    assert stage["config"]["resolution_ladder"] == {
        "min": 240,
        "max": 720,
        "steps": 5,
    }
    assert "resolutions" not in stage["config"]
    assert "options" not in stage["controls"][0]
    # The aspect-ratio targets are the widgets the panel hides, not edits.
    assert rules["nodes"]["145"]["widgets"]["value"]["hidden"] is True
    assert rules["nodes"]["146"]["widgets"]["value"]["hidden"] is True


def test_minimax_h3_image_to_video_exposes_sampler_steps_in_settings():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)

    steps = rules["nodes"]["124"]["widgets"]["steps"]
    # No section_id, so the panel files it under its built-in Settings section
    # next to the other Video Generation controls.
    assert "section_id" not in steps
    assert steps["group_id"] == "video_generation"
    assert steps["default"] == 20
    assert steps["min"] >= 1
    assert steps["max"] >= steps["default"]

    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    scheduler = next(node for node in workflow["nodes"] if node["id"] == 124)
    assert scheduler["type"] == "BasicScheduler"
    # The exposed default must match what the shipped graph already runs.
    assert scheduler["widgets_values_named"]["steps"] == steps["default"]


def test_minimax_h3_image_to_video_lora_loader_defaults_to_none():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)

    lora = rules["nodes"]["150"]["widgets"]["lora_name"]
    assert lora["discover_when_bypassed"] is True
    assert lora["default_node_bypass"] is True
    # The installed LoRA files are runtime data, so the sidecar must not pin an
    # option list; autodiscovery lends the enum and the None (bypass) choice.
    assert "options" not in lora
    assert lora["section_id"] == "lora_loaders"

    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    loader = next(node for node in workflow["nodes"] if node["id"] == 150)
    assert loader["type"] == "LoraLoaderModelOnly"
    # The loader ships bypassed, and that is load-bearing rather than cosmetic:
    # ComfyUI's missing-model scan skips mode 2 and 4 nodes, so this is what
    # stops the placeholder LoRA below from raising the download dialog for
    # every user who does not happen to have that file. `discover_when_bypassed`
    # is what lets the panel present the loader anyway, and picking a model
    # activates the node for that submission only.
    assert loader["mode"] == 4
    # Re-saving the graph with the loader switched on would silently restore the
    # dialog, so the placeholder name is pinned here as the thing to look at if
    # that ever regresses.
    assert loader["widgets_values_named"]["lora_name"].endswith(".safetensors")


def test_minimax_h3_image_to_video_advanced_settings_toggle_model_patches():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)

    sections = {section["id"]: section for section in rules["sections"]}
    assert sections["advanced_settings"]["title"] == "Advanced Settings"
    # Advanced controls stay collapsed, and must sort after the LoRA section
    # rather than colliding with it.
    assert sections["advanced_settings"]["default_open"] is False
    assert sections["advanced_settings"]["order"] > sections["lora_loaders"]["order"]

    # Spectrum is the only togglable patch. The attention node is always
    # applied and is configured by its dropdown alone, so it has no on/off
    # control and nothing ever bypasses node 151.
    controls = rules["frontend_controls"]
    assert set(controls) == {"spectrum_enabled"}
    assert controls["spectrum_enabled"]["value_type"] == "boolean"
    # Spectrum is active in the shipped graph, so on is the default.
    assert controls["spectrum_enabled"]["default"] is True
    assert controls["spectrum_enabled"]["section_id"] == "advanced_settings"
    assert {
        "when": {
            "kind": "compare",
            "ref": {"kind": "frontend_control", "control_id": "spectrum_enabled"},
            "operator": "eq",
            "value": False,
        },
        "bypass": ["148"],
    } in rules["rewrites"]
    assert not any("151" in rule.get("bypass", []) for rule in rules["rewrites"])

    attention = rules["nodes"]["151"]["widgets"]["attention"]
    assert attention["section_id"] == "advanced_settings"
    # object_info owns the backend list.
    assert "options" not in attention
    # Deliberately ungated. A `when` on a frontend_control reads plausible here,
    # but the panel resolves widget visibility without any frontend-control
    # state (resolveWidgetInputs is called with no frontendStateWidgetValues),
    # so such a condition never matches and the selector would be invisible for
    # good. Rewrites are a different path and *do* get that state, which is why
    # the toggles above work. Leaving the selector shown while the override is
    # off is harmless: node 151 is bypassed, so its widget value is ignored.
    assert "when" not in attention


def test_minimax_h3_image_to_video_model_chain_passes_through_bypasses():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    nodes = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: tuple(link[1:5]) for link in workflow["links"]}

    assert nodes[150]["type"] == "LoraLoaderModelOnly"
    assert nodes[151]["type"] == "ModelAttentionBackend"
    assert nodes[148]["type"] == "SpectrumApplyMiniMaxH3"

    # UNETLoader -> LoRA -> attention -> spectrum, then on to guider/scheduler.
    for source_id, target_id in ((127, 150), (150, 151), (151, 148)):
        assert any(
            link[0] == source_id and link[2] == target_id for link in links.values()
        ), f"no link {source_id} -> {target_id}"
    assert {links[link_id][2] for link_id in nodes[148]["outputs"][0]["links"]} == {
        124,
        126,
    }

    # Every optional patch is MODEL in / MODEL out, which is what lets ComfyUI
    # pass the model straight through when the panel bypasses one of them.
    for node_id in (150, 151, 148):
        node = nodes[node_id]
        assert node["inputs"][_input_index(node, "model")]["type"] == "MODEL"
        assert node["outputs"][0]["type"] == "MODEL"
