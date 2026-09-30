from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from minimax_h3_profiles import assert_profiles_agree_apart_from_weights
from services.workflow_rules import load_rules_model_for_workflow
from services.workflow_rules.schema import ResolvedWorkflowRules, get_pipeline_stage


ASSETS_DIR = Path(__file__).parents[1] / "assets" / ".config"
WORKFLOW_NAME = "vlo_minimax_h3_ttm.json"
RULES_NAME = "vlo_minimax_h3_ttm.rules.json"
WORKFLOW_DIRS = (
    ASSETS_DIR / "default_workflows",
    ASSETS_DIR / "high_vram_workflows",
)


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _workflow() -> dict[str, Any]:
    return _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)


def _nodes_by_type(workflow: dict[str, Any], node_type: str) -> list[dict[str, Any]]:
    return [node for node in workflow["nodes"] if node["type"] == node_type]


def _only(workflow: dict[str, Any], node_type: str) -> dict[str, Any]:
    matches = _nodes_by_type(workflow, node_type)
    assert len(matches) == 1, f"expected one {node_type}, found {len(matches)}"
    return matches[0]


def _postprocess_target_node_ids() -> set[int]:
    """Node ids the aspect-ratio stage drives with the delivered dimensions."""
    rules, warnings = load_rules_model_for_workflow(WORKFLOW_DIRS[0], WORKFLOW_NAME)
    assert warnings == []
    stage = get_pipeline_stage(rules, "aspect_ratio")
    assert stage is not None
    return {
        int(target.width.node_id) for target in stage.config.postprocess.targets
    }


def test_ttm_workflow_is_packaged_in_both_modes():
    default_rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    high_vram_rules = _load_json(WORKFLOW_DIRS[1] / RULES_NAME)

    # The high-VRAM profile swaps in the pruned bf16 weights; the graph itself
    # and the rules are shared.
    assert_profiles_agree_apart_from_weights(WORKFLOW_NAME)
    assert high_vram_rules == default_rules
    ResolvedWorkflowRules.model_validate(default_rules)


def test_ttm_workflow_is_listed_in_the_menu():
    menu = _load_json(ASSETS_DIR / "workflow_menu.json")
    placements = {
        placement["workflow_id"]: placement for placement in menu["leaf_placements"]
    }
    assert placements[WORKFLOW_NAME]["parent_id"] == "video.control"


def test_ttm_rules_load_without_warnings():
    for directory in WORKFLOW_DIRS:
        rules, warnings = load_rules_model_for_workflow(directory, WORKFLOW_NAME)
        assert warnings == []
        assert rules.version == 3


def test_ttm_pairs_the_reference_video_with_its_mask():
    rules, _ = load_rules_model_for_workflow(WORKFLOW_DIRS[0], WORKFLOW_NAME)
    stage = get_pipeline_stage(rules, "mask_processing")

    assert stage is not None
    assert [(t.source.node_id, t.mask.node_id) for t in stage.targets] == [("1", "2")]
    target = stage.targets[0]
    # The reference is the whole composited selection; the mask is only the tracks
    # the user picked, which is what marks the moving subject.
    assert target.source_selection == "full_selection"
    assert target.mask_selection == "input_selection"


def test_mask_is_inverted_into_time_to_move_polarity():
    """vloTimeToMove holds the white region against the reference, so the moving object
    has to arrive white. vlo renders the object's backdrop transparent, which lands as
    white in the exported MP4 and leaves the object black -- hence the InvertMask."""
    workflow = _workflow()
    by_id = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: link for link in workflow["links"]}

    ttm = _only(workflow, "vloTimeToMove")
    mask_input = next(i for i in ttm["inputs"] if i["name"] == "mask")

    chain = []
    link_id = mask_input["link"]
    while link_id is not None:
        origin = by_id[links[link_id][1]]
        chain.append(origin["type"])
        upstream = [i for i in origin["inputs"] if i["link"] is not None]
        link_id = upstream[0]["link"] if upstream else None

    assert chain == [
        "GrowMask",
        "InvertMask",
        "ThresholdMask",
        "ImageToMask",
        "GetImageRangeFromBatch",
        "ResizeImageMaskNode",
        "GetVideoComponents",
        "vloMemoryLoadVideo",
    ]
    # GrowMask runs after the invert, so it dilates the held object rather than
    # eroding it -- that is what covers the paste seam around the dragged subject.
    grow, invert = _only(workflow, "GrowMask"), _only(workflow, "InvertMask")
    assert grow["widgets_values_named"]["expand"] > 0
    assert links[next(i for i in grow["inputs"] if i["name"] == "mask")["link"]][1] == invert["id"]


def test_reference_latents_and_sampled_latent_share_a_frame_count():
    """vloTimeToMove rejects a reference that does not match the sampled video latent,
    so the encoded reference and MiniMaxH3ImageToVideo must read one snapped count."""
    workflow = _workflow()
    by_id = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: link for link in workflow["links"]}

    snap = _only(workflow, "ComfyMathExpression")
    # MiniMax H3's video VAE maps 17k + 5 source frames onto 5k + 2 latent frames.
    assert snap["widgets_values_named"]["expression"] == "max(5, a - ((a - 5) % 17))"

    def origin_of(node, input_name):
        spec = next(i for i in node["inputs"] if i["name"] == input_name)
        return links[spec["link"]][1]

    h3 = _only(workflow, "MiniMaxH3ImageToVideo")
    trims = _nodes_by_type(workflow, "GetImageRangeFromBatch")
    assert len(trims) == 2  # reference and mask, trimmed together
    for consumer, param in [(h3, "length")] + [(t, "num_frames") for t in trims]:
        assert origin_of(consumer, param) == snap["id"]

    # The same canvas feeds the *input* resize nodes and the latent the sampler
    # starts from.
    width = origin_of(h3, "width")
    height = origin_of(h3, "height")
    input_resizes = _nodes_by_type(workflow, "ResizeImageMaskNode")
    assert input_resizes, "expected at least one input resize node"
    for resize in input_resizes:
        assert origin_of(resize, "resize_type.width") == width
        assert origin_of(resize, "resize_type.height") == height

    # The output save restores the requested size after generation. It takes its
    # dimensions from the aspect-ratio stage at dispatch, so its width/height
    # must stay unlinked widgets for the backend to write into.
    for node_id in _postprocess_target_node_ids():
        node = by_id[node_id]
        assert node["type"] == "vloSaveVideo"
        for param in ("width", "height"):
            spec = next(i for i in node["inputs"] if i["name"] == param)
            assert spec["link"] is None, f"{param} must not be wired to the canvas"

    encode = _only(workflow, "VAEEncode")
    assert origin_of(_only(workflow, "vloTimeToMove"), "reference_latents") == encode["id"]
    # The reference is encoded with the video VAE the sampled latent was built from.
    assert origin_of(encode, "vae") == origin_of(h3, "vae")


def test_ttm_patches_the_model_the_guider_samples_with():
    workflow = _workflow()
    links = {link[0]: link for link in workflow["links"]}
    ttm = _only(workflow, "vloTimeToMove")
    guider = _only(workflow, "BasicGuider")

    model_input = next(i for i in guider["inputs"] if i["name"] == "model")
    assert links[model_input["link"]][1] == ttm["id"]

    # The sampled latent is MiniMax's packed audio+video latent, not a bare video one.
    sampler = _only(workflow, "SamplerCustomAdvanced")
    latent_input = next(i for i in sampler["inputs"] if i["name"] == "latent_image")
    assert links[latent_input["link"]][1] == _only(workflow, "MiniMaxH3ImageToVideo")["id"]


def test_audio_is_decoded_and_muxed():
    """TTM never holds the audio stream, so H3 still generates a soundtrack."""
    workflow = _workflow()
    links = {link[0]: link for link in workflow["links"]}
    save = _only(workflow, "vloSaveVideo")
    audio_input = next(i for i in save["inputs"] if i["name"] == "audio")

    assert audio_input["link"] is not None
    assert links[audio_input["link"]][1] == _only(workflow, "VAEDecodeAudio")["id"]
    assert save["widgets_values_named"]["fps"] == 24


def test_ttm_window_is_exposed_and_the_canvas_is_not():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    workflow = _workflow()
    ttm_id = str(_only(workflow, "vloTimeToMove")["id"])

    window = rules["nodes"][ttm_id]["widgets"]
    assert set(window) == {"start_step", "end_step"}
    assert not any(spec.get("hidden") for spec in window.values())

    # width/height/length are driven by links, so they must not be editable.
    h3_id = str(_only(workflow, "MiniMaxH3ImageToVideo")["id"])
    for param in ("width", "height", "length"):
        assert rules["nodes"][h3_id]["widgets"][param]["hidden"] is True


def test_ttm_window_is_bounded_by_the_steps_the_sampler_runs():
    """The window sliders cannot outrun the step count the user picked.

    A constant ceiling here was wrong in both directions: it hid the steps a
    raised count makes available, and it offered steps a lowered count no
    longer runs, which vloTimeToMove rejects outright.
    """
    workflow = _workflow()
    ttm_id = str(_only(workflow, "vloTimeToMove")["id"])
    scheduler_id = str(_only(workflow, "BasicScheduler")["id"])

    for directory in WORKFLOW_DIRS:
        rules = _load_json(directory / RULES_NAME)
        window = rules["nodes"][ttm_id]["widgets"]
        steps_ref = {
            "kind": "workflow_param",
            "node_id": scheduler_id,
            "param": "steps",
        }

        # start_step is seeded at a step the sampler still has to run, so it
        # stops one short of the count; end_step is exclusive and may reach it.
        assert window["start_step"]["max_from"] == {"ref": steps_ref, "offset": -1}
        assert window["end_step"]["max_from"] == {"ref": steps_ref, "offset": 0}

        steps = rules["nodes"][scheduler_id]["widgets"]["steps"]
        for param in ("start_step", "end_step"):
            assert window[param]["max"] == steps["max"], (
                f"{param}'s fallback ceiling must match the Steps slider's"
            )
            # Step 0 seeds at sigma 1.0, where the reference washes out and TTM
            # does nothing, so the panel does not offer it.
            assert window[param]["min"] == 1


def test_ttm_window_renders_as_one_range():
    """Lock-in and release are one window, so they share one ordered slider.

    As two sliders they could cross without any sign that crossing means
    something (vloTimeToMove reads an end at or before the start as "seed the
    reference, never hold it"), so the pair names that state instead.
    """
    workflow = _workflow()
    ttm_id = str(_only(workflow, "vloTimeToMove")["id"])

    for directory in WORKFLOW_DIRS:
        rules, warnings = load_rules_model_for_workflow(directory, WORKFLOW_NAME)
        assert warnings == []
        window = rules.nodes[ttm_id].widgets
        pairing = window["start_step"].range

        assert pairing is not None
        assert (pairing.end.node_id, pairing.end.param) == (ttm_id, "end_step")
        # An empty hold is a real setting, so the ends may meet.
        assert pairing.min_distance == 0
        assert pairing.collapsed_label
        assert window["end_step"].range is None


def test_ttm_keyframes_are_optional_uploads_not_the_reference_video():
    """Start and end frames come from their own optional loaders.

    The reference is a rough cut-and-paste, so its first frame is not a clean
    anchor; the keyframes are separate images the user may supply or omit.
    """
    workflow = _workflow()
    by_id = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: link for link in workflow["links"]}
    assert not _nodes_by_type(workflow, "VHS_SelectImages")

    h3 = _only(workflow, "MiniMaxH3ImageToVideo")
    inputs = {spec["name"]: spec for spec in h3["inputs"]}
    width_src = links[inputs["width"]["link"]][1]
    height_src = links[inputs["height"]["link"]][1]

    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    optional_inputs = {
        spec["input"]
        for spec in rules["validation"]["inputs"]
        if spec["kind"] == "optional"
    }

    for slot, label in (("first_frame", "Start frame"), ("last_frame", "End frame")):
        # shape 7 marks the slot optional, so a bypassed branch still yields a
        # valid prompt.
        assert inputs[slot]["shape"] == 7
        resize = by_id[links[inputs[slot]["link"]][1]]
        assert resize["type"] == "ResizeImageMaskNode"
        resize_inputs = {spec["name"]: spec for spec in resize["inputs"]}
        loader = by_id[links[resize_inputs["input"]["link"]][1]]
        assert loader["type"] == "vloMemoryLoadImage"
        # Fitted exactly like the reference, so the keyframe lines up with it.
        assert resize["widgets_values_named"]["resize_type.crop"] == "center"
        assert links[resize_inputs["resize_type.width"]["link"]][1] == width_src
        assert links[resize_inputs["resize_type.height"]["link"]][1] == height_src

        loader_id, resize_id = str(loader["id"]), str(resize["id"])
        present = rules["nodes"][loader_id]["present"]
        assert present["label"] == label
        assert present["required"] is False
        assert loader_id in optional_inputs
        # A missing frame bypasses its loader and resize together, leaving the
        # generator's optional slot unconnected.
        assert {
            "when": {
                "kind": "input_presence",
                "inputs": [loader_id],
                "match": "all_missing",
            },
            "bypass": [loader_id, resize_id],
        } in rules["rewrites"]
