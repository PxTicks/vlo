"""The packaged MiniMax H3 image-edit workflow.

H3 is a video model, and an edited still from it is a five-frame I2VA
generation cut back to one picture: the source image frames the scene, the
prompt describes the change, and one latent frame of the sampled clip becomes
the picture. These checks pin the shape that makes that true — one required
source input, the length fixed at the shortest legal clip, no audio half, and
the decode sliced to a single picture.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from minimax_h3_profiles import assert_profiles_agree_apart_from_weights
from services.workflow_rules.schema import ResolvedWorkflowRules


ASSETS_DIR = Path(__file__).parents[1] / "assets" / ".config"
WORKFLOW_NAME = "vlo_minimax_h3_edit.json"
RULES_NAME = "vlo_minimax_h3_edit.rules.json"
WORKFLOW_DIRS = (
    ASSETS_DIR / "default_workflows",
    ASSETS_DIR / "high_vram_workflows",
)

SOURCE_NODE = 141
RESIZE_NODE = 143
GENERATOR_NODE = 136
DECODE_NODE = 122
STILL_NODE = 156
SLICE_NODE = 157
PREVIEW_NODE = 158
WIDTH_NODE = 145
HEIGHT_NODE = 146

# Latent frame 0 is the keyframe the source image is encoded into; frame 1 is
# the edit.
RESULT_FRAME = 1


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _input_index(node: dict[str, Any], name: str) -> int:
    for index, spec in enumerate(node["inputs"]):
        if spec["name"] == name:
            return index
    raise AssertionError(f"node {node['id']} has no input named {name!r}")


def test_minimax_h3_edit_workflow_is_packaged_in_both_modes():
    default_rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    high_vram_rules = _load_json(WORKFLOW_DIRS[1] / RULES_NAME)

    # The high-VRAM profile swaps in the pruned bf16 weights; the graph itself
    # and the rules are shared.
    assert_profiles_agree_apart_from_weights(WORKFLOW_NAME)
    assert high_vram_rules == default_rules
    ResolvedWorkflowRules.model_validate(default_rules)


def test_minimax_h3_edit_workflow_is_flat_and_vlo_native():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    node_types = [node["type"] for node in workflow["nodes"]]

    # Rules address executable node ids, so the upstream template's subgraph
    # wrapper is flattened rather than kept.
    assert "definitions" not in workflow
    assert node_types.count("MiniMaxH3ImageToVideo") == 1
    assert node_types.count("vloMemoryLoadImage") == 1
    assert not {
        "LoadImage",
        "ComfyMathExpression",
        "PrimitiveFloat",
        "ImageScaleToTotalPixels",
        "GetImageSize",
    }.intersection(node_types)


def test_minimax_h3_edit_workflow_drops_the_audio_half_and_the_video_save():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    node_types = [node["type"] for node in workflow["nodes"]]

    # A picture keeps no sound, so the audio VAE, its decode and the video save
    # node are gone rather than bypassed.
    assert "VAEDecodeAudio" not in node_types
    assert node_types.count("VAELoader") == 1
    assert "vloSaveVideo" not in node_types
    assert "PreviewImage" in node_types


def test_minimax_h3_edit_workflow_wires_one_required_source_into_first_frame():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    nodes = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: tuple(link[1:5]) for link in workflow["links"]}

    generator = nodes[GENERATOR_NODE]
    inputs = {spec["name"]: spec for spec in generator["inputs"]}
    # `first_frame` is the I2VA keyframe and stays optional at the node level;
    # vlo's own validation is what requires it of the user.
    assert inputs["first_frame"]["shape"] == 7
    assert inputs["last_frame"]["link"] is None

    resize = nodes[RESIZE_NODE]
    assert links[inputs["first_frame"]["link"]][:2] == (RESIZE_NODE, 0)
    assert links[resize["inputs"][_input_index(resize, "input")]["link"]][:2] == (
        SOURCE_NODE,
        0,
    )
    assert nodes[SOURCE_NODE]["title"] == "Source Image"
    assert nodes[SOURCE_NODE]["widgets_values"][0] == ""

    # The source is stretched to the generation canvas, never cropped here.
    assert resize["widgets_values"][0] == "scale dimensions"
    assert resize["widgets_values"][3] == "disabled"

    # The labelled Width/Height primitives drive the generator and the resize.
    assert nodes[WIDTH_NODE]["title"] == "Width"
    assert nodes[HEIGHT_NODE]["title"] == "Height"
    assert {links[link_id] for link_id in nodes[WIDTH_NODE]["outputs"][0]["links"]} == {
        (WIDTH_NODE, 0, GENERATOR_NODE, _input_index(generator, "width")),
        (WIDTH_NODE, 0, RESIZE_NODE, _input_index(resize, "resize_type.width")),
    }
    assert {links[link_id] for link_id in nodes[HEIGHT_NODE]["outputs"][0]["links"]} == {
        (HEIGHT_NODE, 0, GENERATOR_NODE, _input_index(generator, "height")),
        (HEIGHT_NODE, 0, RESIZE_NODE, _input_index(resize, "resize_type.height")),
    }


def test_minimax_h3_edit_workflow_samples_the_shortest_clip():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    nodes = {node["id"]: node for node in workflow["nodes"]}

    generator = nodes[GENERATOR_NODE]
    # 5 frames is the shortest count on H3's 17k+5 grid, and the cheapest pass
    # the model can be asked for.
    assert generator["widgets_values"][3] == 5
    assert generator["widgets_values_named"]["length"] == 5


def test_minimax_h3_edit_workflow_keeps_one_latent_frame_of_the_edit():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    nodes = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: tuple(link[1:5]) for link in workflow["links"]}

    # Five pixel frames pack into two latent frames, and the edit is the second.
    still = nodes[STILL_NODE]
    assert still["type"] == "MiniMaxH3StillLatent"
    assert links[still["inputs"][_input_index(still, "samples")]["link"]][:2] == (125, 0)
    assert still["widgets_values"] == [RESULT_FRAME]

    # The still wraps that one token as the shortest clip the H3 VAE decodes —
    # a single token on its own produces tile seams and patch noise — and the
    # decode's first pixel frame is that token exactly.
    decode = nodes[DECODE_NODE]
    assert links[decode["inputs"][_input_index(decode, "samples")]["link"]][:2] == (
        STILL_NODE,
        0,
    )
    slice_node = nodes[SLICE_NODE]
    assert slice_node["type"] == "ImageFromBatch"
    assert links[slice_node["inputs"][_input_index(slice_node, "image")]["link"]][:2] == (
        DECODE_NODE,
        0,
    )
    assert slice_node["widgets_values"] == [0, 1]

    preview = nodes[PREVIEW_NODE]
    assert preview["type"] == "PreviewImage"
    assert links[preview["inputs"][_input_index(preview, "images")]["link"]][:2] == (
        SLICE_NODE,
        0,
    )


def test_minimax_h3_edit_rules_require_a_source_image_and_a_prompt():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)

    assert rules["validation"]["inputs"] == [
        {
            "kind": "required",
            "input": str(SOURCE_NODE),
            "message": "A source image is required.",
        },
        {
            "kind": "required",
            "input": f"{GENERATOR_NODE}:prompt",
            "message": "A prompt is required.",
        },
    ]
    assert rules["nodes"][str(SOURCE_NODE)]["present"]["required"] is True
    assert rules["nodes"][str(SOURCE_NODE)]["present"]["label"] == "Source image"

    # The only rewrite is the accelerator switch; nothing bypasses the source
    # branch, which is what makes the input required in the graph too.
    assert [rule["bypass"] for rule in rules["rewrites"]] == [["148"]]


def test_minimax_h3_edit_rules_frame_the_canvas_on_the_source_image():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    [stage] = rules["pipeline"]
    assert stage["kind"] == "aspect_ratio"
    assert stage["config"]["anchor_input"] == str(SOURCE_NODE)
    # The picture is delivered at the requested size by the browser, so no
    # in-graph output resize is declared.
    assert stage["config"]["postprocess"]["enabled"] is False
    assert stage["targets"] == [
        {
            "width": {"node_id": str(WIDTH_NODE), "param": "value"},
            "height": {"node_id": str(HEIGHT_NODE), "param": "value"},
        }
    ]


def test_minimax_h3_edit_rules_expose_the_result_frame_and_hide_the_rest():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    widgets = rules["nodes"]

    frame = widgets[str(STILL_NODE)]["widgets"]["index"]
    assert frame["label"] == "Result frame"
    # Fixed, not a control: latent 0 is the source, so only the frame the model
    # generates is ever kept.
    assert frame["hidden"] is True
    assert "min" not in frame and "control" not in frame
    for hidden in ("batch_index", "length"):
        assert widgets[str(SLICE_NODE)]["widgets"][hidden]["hidden"] is True
    assert widgets[str(GENERATOR_NODE)]["widgets"]["length"]["hidden"] is True

    section_orders = {section["id"]: section["order"] for section in rules["sections"]}
    assert section_orders["image_generation"] < section_orders["lora_loaders"]
    assert section_orders["lora_loaders"] < section_orders["advanced_settings"]


def test_minimax_h3_edit_rules_only_reference_nodes_in_the_graph():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    node_ids = {str(node["id"]) for node in workflow["nodes"]}

    referenced = set(rules["nodes"])
    for stack in rules["lora_stacks"]:
        referenced.update(stack["nodes"])
    for stage in rules["pipeline"]:
        for target in stage.get("targets", []):
            referenced.add(target["width"]["node_id"])
            referenced.add(target["height"]["node_id"])

    # A sidecar that names a node id the graph does not have silently does
    # nothing, so every reference has to resolve.
    assert referenced <= node_ids, sorted(referenced - node_ids)
