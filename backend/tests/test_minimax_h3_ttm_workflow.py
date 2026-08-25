from __future__ import annotations

import json
from pathlib import Path
from typing import Any

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


def test_ttm_workflow_is_packaged_in_both_modes():
    default_workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    high_vram_workflow = _load_json(WORKFLOW_DIRS[1] / WORKFLOW_NAME)
    default_rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    high_vram_rules = _load_json(WORKFLOW_DIRS[1] / RULES_NAME)

    # MiniMax H3 ships the same int8/nvfp4 weights in both VRAM modes.
    assert high_vram_workflow == default_workflow
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

    # The same canvas feeds the resize nodes and the latent the sampler starts from.
    width = origin_of(h3, "width")
    height = origin_of(h3, "height")
    for resize in _nodes_by_type(workflow, "ResizeImageMaskNode"):
        assert origin_of(resize, "resize_type.width") == width
        assert origin_of(resize, "resize_type.height") == height

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
    combine = _only(workflow, "VHS_VideoCombine")
    audio_input = next(i for i in combine["inputs"] if i["name"] == "audio")

    assert audio_input["link"] is not None
    assert links[audio_input["link"]][1] == _only(workflow, "VAEDecodeAudio")["id"]
    assert combine["widgets_values"]["frame_rate"] == 24


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
