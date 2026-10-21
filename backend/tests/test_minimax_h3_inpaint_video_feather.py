"""The video-mask feather spliced into every MiniMax H3 inpaint workflow.

The graphs carry the same inpaint chain, so the feather is wired identically
in each, right after the audio-mask feather and straight into the sampler.
It ships bypassed: a panel toggle turns it on.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from services.workflow_rules.schema import ResolvedWorkflowRules


ASSETS_DIR = Path(__file__).parents[1] / "assets" / ".config"
WORKFLOW_PATHS = tuple(
    ASSETS_DIR / variant / f"vlo_minimax_h3_{name}.json"
    for variant in ("default_workflows", "high_vram_workflows")
    for name in ("inpaint", "inpaint_flf2va", "fun_controlnet_union")
)

FEATHER_ID = 117
AUDIO_FEATHER_ID = 97
SAMPLER_ID = 39
SWITCH_ID = 29
TOGGLE_ID = "video_feather_enabled"

pytestmark = pytest.mark.parametrize(
    "workflow_path",
    WORKFLOW_PATHS,
    ids=[f"{path.parent.name}/{path.stem}" for path in WORKFLOW_PATHS],
)


def _workflow(workflow_path: Path) -> tuple[dict[str, Any], dict[int, dict[str, Any]]]:
    workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
    return workflow, {node["id"]: node for node in workflow["nodes"]}


def _rules(workflow_path: Path) -> dict[str, Any]:
    rules_path = workflow_path.with_name(f"{workflow_path.stem}.rules.json")
    return json.loads(rules_path.read_text(encoding="utf-8"))


def _link(workflow: dict[str, Any], link_id: int) -> list[Any]:
    return next(link for link in workflow["links"] if link[0] == link_id)


def _input(node: dict[str, Any], name: str) -> dict[str, Any]:
    return next(input_spec for input_spec in node["inputs"] if input_spec["name"] == name)


def test_video_mask_feather_feeds_the_sampler_after_the_composite(workflow_path):
    """The feather has to read the composite's output, not feed it.

    `vloLatentCompositeMasked` binarises the mask at 0.5 and blanks the latent
    wherever it is set. Feathering upstream would clear half the ramp and let
    the rest blend toward a blank latent instead of the footage.
    """
    workflow, nodes = _workflow(workflow_path)
    feather = nodes[FEATHER_ID]
    assert feather["type"] == "vloFeatherVideoLatentMask"

    latent = _input(feather, "latent")
    assert _link(workflow, latent["link"])[1:5] == [AUDIO_FEATHER_ID, 0, FEATHER_ID, 0]
    assert nodes[AUDIO_FEATHER_ID]["type"] == "vloFeatherAudioLatentMask"

    latent_image = _input(nodes[SAMPLER_ID], "latent_image")
    assert _link(workflow, latent_image["link"])[1:5] == [
        FEATHER_ID,
        0,
        SAMPLER_ID,
        nodes[SAMPLER_ID]["inputs"].index(latent_image),
    ]
    assert nodes[SAMPLER_ID]["type"] == "SamplerCustomAdvanced"
    assert (
        nodes[SWITCH_ID]["order"]
        < nodes[AUDIO_FEATHER_ID]["order"]
        < feather["order"]
        < nodes[SAMPLER_ID]["order"]
    )


def test_video_mask_feather_links_agree_with_the_link_table(workflow_path):
    """Node sockets and the link table are two views of one edge; both must agree."""
    workflow, nodes = _workflow(workflow_path)

    assert workflow["last_node_id"] >= FEATHER_ID
    for link in workflow["links"]:
        link_id, source, source_slot, target, target_slot, _ = link
        if FEATHER_ID not in (source, target):
            continue
        assert link_id <= workflow["last_link_id"]
        assert link_id in (nodes[source]["outputs"][source_slot]["links"] or [])
        assert nodes[target]["inputs"][target_slot]["link"] == link_id


def test_video_mask_feather_defaults_to_an_outer_ramp(workflow_path):
    """Outer is the only mode that is correct without `original_latent`.

    Inner and centered put the ramp inside the region the composite cleared, so
    they need the pre-composite latent connected as well. The packaged graph
    leaves that socket empty, as the audio feather does, so the mode stays outer
    and the panel does not expose it.
    """
    _, nodes = _workflow(workflow_path)
    feather = nodes[FEATHER_ID]
    named = feather["widgets_values_named"]

    assert named["mode"] == "outer"
    assert _input(feather, "original_latent")["link"] is None
    assert named["curve"] == "cosine"
    assert named["lead_ramp"] == named["tail_ramp"] == 2
    assert named["lead_hold"] == named["tail_hold"] == 0
    assert named["floor"] == 0

    exposed = _rules(workflow_path)["nodes"][str(FEATHER_ID)]["widgets"]
    assert "mode" not in exposed


def test_video_mask_feather_widget_values_match_their_names(workflow_path):
    """`widgets_values` is positional, so drift between the two breaks the node."""
    _, nodes = _workflow(workflow_path)
    feather = nodes[FEATHER_ID]

    assert list(feather["widgets_values_named"].values()) == feather["widgets_values"]
    assert list(feather["widgets_values_named"]) == [
        "mode",
        "lead_ramp",
        "tail_ramp",
        "lead_hold",
        "tail_hold",
        "curve",
        "floor",
    ]


def test_video_mask_feather_is_off_until_the_panel_toggle_turns_it_on(workflow_path):
    """The feather changes footage outside the mask, so it is opt-in.

    The rewrite bypasses unless the toggle is explicitly true, so a submission
    that carries no value for it leaves the feather off too.
    """
    rules = _rules(workflow_path)
    ResolvedWorkflowRules.model_validate(rules)

    assert rules["frontend_controls"][TOGGLE_ID]["default"] is False
    (rewrite,) = [
        rewrite
        for rewrite in rules["rewrites"]
        if rewrite["when"].get("ref", {}).get("control_id") == TOGGLE_ID
    ]
    assert rewrite["when"]["operator"] == "neq"
    assert rewrite["when"]["value"] is True
    assert rewrite["bypass"] == [str(FEATHER_ID)]


def test_video_mask_feather_is_bypassed_with_the_rest_of_the_mask_chain(workflow_path):
    """With no inpaint source there is no video noise mask, and the node refuses
    a latent without one. Any rewrite that drops the audio feather's mask chain
    must drop this node too.
    """
    for rewrite in _rules(workflow_path).get("rewrites", []):
        bypass = rewrite.get("bypass", [])
        if str(AUDIO_FEATHER_ID) in bypass:
            assert str(FEATHER_ID) in bypass, rewrite
