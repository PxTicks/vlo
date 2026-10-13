"""The packaged MiniMax H3 reference-side image edit.

The sibling of ``vlo_minimax_h3_edit``: the source picture is attached as a
reference rather than as the first frame, so the model draws a new five-frame
clip from it and one latent frame of that clip becomes the picture. The source
is required, and further images may be listed alongside it; the workflow takes
no audio at all. These checks pin that reference wiring, the required audio VAE
the VLO batch adapter asks for, and the still slice both edits share.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from minimax_h3_profiles import assert_profiles_agree_apart_from_weights
from services.workflow_rules.schema import ResolvedWorkflowRules


ASSETS_DIR = Path(__file__).parents[1] / "assets" / ".config"
WORKFLOW_NAME = "vlo_minimax_h3_edit_ref.json"
RULES_NAME = "vlo_minimax_h3_edit_ref.rules.json"
WORKFLOW_DIRS = (
    ASSETS_DIR / "default_workflows",
    ASSETS_DIR / "high_vram_workflows",
)

SOURCE_NODE = 141
ADAPTER_NODE = 136
DECODE_NODE = 122
STILL_NODE = 156
SLICE_NODE = 157
PREVIEW_NODE = 158
SPECTRUM_NODE = 146

# Nothing is pinned on either side of the clip, so latent frame 0 is the
# generated picture itself — and the one frame the decode is exact for.
RESULT_FRAME = 0


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _input_index(node: dict[str, Any], name: str) -> int:
    for index, spec in enumerate(node["inputs"]):
        if spec["name"] == name:
            return index
    raise AssertionError(f"node {node['id']} has no input named {name!r}")


def test_minimax_h3_edit_ref_workflow_is_packaged_in_both_modes():
    default_rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    high_vram_rules = _load_json(WORKFLOW_DIRS[1] / RULES_NAME)

    assert_profiles_agree_apart_from_weights(WORKFLOW_NAME)
    assert high_vram_rules == default_rules
    ResolvedWorkflowRules.model_validate(default_rules)


def test_minimax_h3_edit_ref_workflow_attaches_image_references_only():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    nodes = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: tuple(link[1:5]) for link in workflow["links"]}
    node_types = [node["type"] for node in workflow["nodes"]]

    # The VLO adapter is the reference node here: it expands ordered lists into
    # ComfyUI's autogrowing native node, which is the shape vlo authors.
    assert node_types.count("vloMiniMaxH3ReferenceToVideoBatch") == 1
    assert node_types.count("vloMemoryLoadImageBatch") == 1
    # A still edit takes pictures, not video or sound.
    assert not {
        "vloMemoryLoadVideoBatch",
        "vloMemoryLoadAudioBatch",
        "LoadImage",
        "LoadVideo",
        "LoadAudio",
    }.intersection(node_types)

    adapter = nodes[ADAPTER_NODE]
    assert nodes[SOURCE_NODE]["title"] == "Source Image"
    # One link, on the image slot: the source is `<Picture 1>` because it is the
    # first image in that list.
    assert links[adapter["inputs"][_input_index(adapter, "ref_images")]["link"]][:2] == (
        SOURCE_NODE,
        0,
    )
    for slot in ("ref_videos", "ref_video_audios", "ref_audios"):
        assert adapter["inputs"][_input_index(adapter, slot)]["link"] is None
    # Nothing feeds the per-video audio flag, so the adapter's widget keeps its
    # `false` and no reference soundtrack is ever encoded.
    assert adapter["inputs"][_input_index(adapter, "use_embedded_video_audio")][
        "link"
    ] is None
    assert adapter["widgets_values_named"]["use_embedded_video_audio"] is False


def test_minimax_h3_edit_ref_workflow_satisfies_the_adapters_required_vae():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    nodes = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: tuple(link[1:5]) for link in workflow["links"]}
    node_types = [node["type"] for node in workflow["nodes"]]

    # The adapter declares `audio_vae` required even with no audio references,
    # so the file is loaded and linked; nothing decodes sound.
    assert node_types.count("VAELoader") == 2
    assert "VAEDecodeAudio" not in node_types
    assert "vloSaveVideo" not in node_types
    adapter = nodes[ADAPTER_NODE]
    for slot in ("vae", "audio_vae"):
        origin = links[adapter["inputs"][_input_index(adapter, slot)]["link"]][0]
        assert nodes[origin]["type"] == "VAELoader"

    vae_names = sorted(
        node["widgets_values"][0]
        for node in workflow["nodes"]
        if node["type"] == "VAELoader"
    )
    assert vae_names == [
        "minimax_h3_audio_vae_fp32.safetensors",
        "minimax_h3_video_vae_int8_convrot.safetensors",
    ]


def test_minimax_h3_edit_ref_workflow_samples_the_shortest_clip():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    nodes = {node["id"]: node for node in workflow["nodes"]}
    adapter = nodes[ADAPTER_NODE]

    # 5 frames is the shortest count on H3's 17k+5 grid, and the cheapest pass
    # the model can be asked for.
    assert adapter["widgets_values"][3] == 5
    assert adapter["widgets_values_named"]["length"] == 5
    assert "subject_definitions:" in adapter["widgets_values"][0]
    assert "<Picture 1>" in adapter["widgets_values"][0]


def test_minimax_h3_edit_ref_workflow_keeps_the_generated_frame():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    nodes = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: tuple(link[1:5]) for link in workflow["links"]}

    still = nodes[STILL_NODE]
    assert still["type"] == "MiniMaxH3StillLatent"
    assert links[still["inputs"][_input_index(still, "samples")]["link"]][:2] == (125, 0)
    assert still["widgets_values"] == [RESULT_FRAME]

    decode = nodes[DECODE_NODE]
    assert links[decode["inputs"][_input_index(decode, "samples")]["link"]][:2] == (
        STILL_NODE,
        0,
    )
    slice_node = nodes[SLICE_NODE]
    assert slice_node["type"] == "ImageFromBatch"
    assert slice_node["widgets_values"] == [0, 1]
    assert links[slice_node["inputs"][_input_index(slice_node, "image")]["link"]][:2] == (
        DECODE_NODE,
        0,
    )

    preview = nodes[PREVIEW_NODE]
    assert preview["type"] == "PreviewImage"
    assert links[preview["inputs"][_input_index(preview, "images")]["link"]][:2] == (
        SLICE_NODE,
        0,
    )


def test_minimax_h3_edit_ref_rules_require_one_source_image_and_a_prompt():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)

    assert rules["validation"]["inputs"] == [
        {
            "kind": "required",
            "input": str(SOURCE_NODE),
            "message": "A source image is required.",
        },
        {
            "kind": "required",
            "input": f"{ADAPTER_NODE}:prompt",
            "message": "A prompt is required.",
        },
    ]
    # The source is the first image in an ordinary reference batch, so it can
    # carry further images as `<Picture 2>`, and nothing may drop it.
    assert rules["nodes"][str(SOURCE_NODE)]["present"] == {
        "label": "Source image",
        "input_type": "image",
        "param": "images",
        "class_type": "vloMemoryLoadImageBatch",
        "section_id": "inputs",
        "repeatable": {"max": 9},
        "required": True,
    }
    # The prompt is presented as text so it picks up prompt carryover and the
    # extension generation API.
    assert rules["nodes"][str(ADAPTER_NODE)]["present"] == {
        "label": "Prompt",
        "input_type": "text",
        "param": "prompt",
    }
    # The adapter's wholesale audio flag is fed by the video loader's per-video
    # flags, and this workflow has neither, so it is never a panel widget.
    assert "use_embedded_video_audio" not in rules["nodes"][str(ADAPTER_NODE)]["widgets"]


def test_minimax_h3_edit_ref_rules_take_no_video_or_audio_reference():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)

    presented = {
        node_id: node["present"]
        for node_id, node in rules["nodes"].items()
        if "present" in node
    }
    # An image source and the prompt are the whole input surface.
    assert set(presented) == {str(SOURCE_NODE), str(ADAPTER_NODE)}
    assert presented[str(SOURCE_NODE)]["input_type"] == "image"
    assert presented[str(ADAPTER_NODE)]["input_type"] == "text"
    assert not [
        node_id
        for node_id, present in presented.items()
        if present.get("input_type") in {"video", "audio"}
    ]

def test_minimax_h3_edit_ref_rules_fix_the_kept_frame():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    widgets = rules["nodes"]

    frame = widgets[str(STILL_NODE)]["widgets"]["index"]
    assert frame["label"] == "Result frame"
    # Fixed, not a control: latent 0 is the picture, and nothing else is kept.
    assert frame["hidden"] is True
    assert "min" not in frame and "control" not in frame
    for hidden in ("batch_index", "length"):
        assert widgets[str(SLICE_NODE)]["widgets"][hidden]["hidden"] is True
    assert widgets[str(ADAPTER_NODE)]["widgets"]["length"]["hidden"] is True


def test_minimax_h3_edit_ref_rules_expose_the_reference_size_control():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)

    reference_size = rules["nodes"][str(ADAPTER_NODE)]["widgets"]["ref_image_size"]
    assert reference_size["label"] == "Reference image size"
    assert reference_size["options"] == ["match", "max"]
    assert reference_size["default"] == "match"
    assert reference_size["section_id"] == "references"

    assert [section["id"] for section in rules["sections"]] == [
        "image_generation",
        "lora_loaders",
        "references",
        "advanced_settings",
    ]
    assert [section["order"] for section in rules["sections"]] == [2, 3, 4, 5]


def test_minimax_h3_edit_ref_rules_frame_the_canvas_on_the_source_image():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    [stage] = rules["pipeline"]
    assert stage["kind"] == "aspect_ratio"
    assert stage["config"]["anchor_input"] == str(SOURCE_NODE)
    assert stage["config"]["postprocess"]["enabled"] is False
    assert stage["targets"] == [
        {
            "width": {"node_id": str(ADAPTER_NODE), "param": "width"},
            "height": {"node_id": str(ADAPTER_NODE), "param": "height"},
        }
    ]


def test_minimax_h3_edit_ref_rules_only_bypass_the_spectrum_patch():
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    node_types = {str(node["id"]): node["type"] for node in workflow["nodes"]}

    # The source is required, so no rule may drop it: an empty image list has to
    # fail validation rather than quietly become a text-to-video run.
    assert all(str(SOURCE_NODE) not in rule["bypass"] for rule in rules["rewrites"])
    assert {
        node_id for rule in rules["rewrites"] for node_id in rule["bypass"]
    } == {str(SPECTRUM_NODE)}

    # This workflow numbers Spectrum 146, not the 148 of the first-frame edit.
    [spectrum_rewrite] = rules["rewrites"]
    assert spectrum_rewrite["when"]["ref"]["control_id"] == "spectrum_enabled"
    assert node_types[str(SPECTRUM_NODE)] == "SpectrumApplyMiniMaxH3"


def test_minimax_h3_edit_ref_rules_only_reference_nodes_in_the_graph():
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

    assert referenced <= node_ids, sorted(referenced - node_ids)
