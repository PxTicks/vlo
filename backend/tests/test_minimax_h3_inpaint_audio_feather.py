"""The audio-mask feather spliced into both MiniMax H3 inpaint workflows.

The two graphs carry the same inpaint chain, so the feather is wired
identically in each and every case below runs against both.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest


ASSETS_DIR = Path(__file__).parents[1] / "assets" / ".config"
WORKFLOW_DIR = ASSETS_DIR / "default_workflows"
WORKFLOW_NAMES = ("vlo_minimax_h3_inpaint.json", "vlo_minimax_h3_inpaint_flf2va.json")

SWITCH_ID = 29
FEATHER_ID = 97
SAMPLER_ID = 39
AUDIO_MASK_ID = 68

pytestmark = pytest.mark.parametrize("workflow_name", WORKFLOW_NAMES)


def _workflow(workflow_name: str) -> tuple[dict[str, Any], dict[int, dict[str, Any]]]:
    workflow = json.loads(
        (WORKFLOW_DIR / workflow_name).read_text(encoding="utf-8")
    )
    return workflow, {node["id"]: node for node in workflow["nodes"]}


def _link(workflow: dict[str, Any], link_id: int) -> list[Any]:
    return next(link for link in workflow["links"] if link[0] == link_id)


def test_audio_mask_feather_sits_between_the_composite_and_the_sampler(workflow_name):
    """The feather has to read the composite's output, not feed it.

    `vloLatentCompositeMasked` blanks the destination wherever the mask is set.
    A binary mask never reads that blanked latent, but a feathered one does,
    weighted by 1 - mask. Feathering upstream of the composite would therefore
    have the ramp steps blend toward silence instead of the original audio,
    which is a worse artefact than the seam the feather exists to remove.
    """
    workflow, nodes = _workflow(workflow_name)
    feather = nodes[FEATHER_ID]
    assert feather["type"] == "vloFeatherAudioLatentMask"

    audio_latent = feather["inputs"][0]
    assert audio_latent["name"] == "audio_latent"
    assert _link(workflow, audio_latent["link"])[1:5] == [SWITCH_ID, 0, FEATHER_ID, 0]
    assert nodes[SWITCH_ID]["type"] == "ComfySwitchNode"

    # The video-mask feather sits between this one and the sampler; it only
    # rewrites the video stream's mask, so the audio mask reaches the sampler
    # as feathered here.
    (output_link,) = feather["outputs"][0]["links"]
    downstream = nodes[_link(workflow, output_link)[3]]
    assert downstream["type"] == "vloFeatherVideoLatentMask"
    (downstream_link,) = downstream["outputs"][0]["links"]
    assert _link(workflow, downstream_link)[3] == SAMPLER_ID
    assert nodes[SAMPLER_ID]["type"] == "SamplerCustomAdvanced"
    assert nodes[SWITCH_ID]["order"] < feather["order"] < nodes[SAMPLER_ID]["order"]


def test_audio_mask_feather_defaults_to_an_outer_ramp(workflow_name):
    """Outer is the only mode that is correct without `original_audio_latent`.

    Inner and centered put the ramp inside the region the composite cleared, so
    they need the pre-composite latent connected as well. The packaged graph
    leaves that socket empty, so the mode has to stay outer.
    """
    _, nodes = _workflow(workflow_name)
    feather = nodes[FEATHER_ID]
    named = feather["widgets_values_named"]

    assert named["mode"] == "outer"
    original = next(
        input_spec
        for input_spec in feather["inputs"]
        if input_spec["name"] == "original_audio_latent"
    )
    assert original["link"] is None

    assert named["curve"] == "cosine"
    assert named["lead_ramp"] == named["tail_ramp"] == 0.15
    assert named["lead_hold"] == named["tail_hold"] == 0.1
    assert named["floor"] == 0


def test_audio_mask_feather_widget_values_match_their_names(workflow_name):
    """`widgets_values` is positional, so drift between the two breaks the node."""
    _, nodes = _workflow(workflow_name)
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
        "layout_override",
        "audio_latent_rate",
    ]


def test_audio_mask_feather_resolves_its_latent_rate_from_the_audio_vae(workflow_name):
    """Ramp seconds become latent steps, which needs the VAE's latent rate.

    Metadata from `vloSetAudioLatentBinaryMasks` carries that rate through the
    composite today, but wiring the VAE keeps the node correct on its own.
    """
    workflow, nodes = _workflow(workflow_name)
    audio_vae = next(
        input_spec
        for input_spec in nodes[FEATHER_ID]["inputs"]
        if input_spec["name"] == "audio_vae"
    )
    assert audio_vae["link"] is not None

    getter = nodes[_link(workflow, audio_vae["link"])[1]]
    assert getter["type"] == "GetNode"
    assert getter["widgets_values"] == ["AUDIO_VAE"]
    assert nodes[AUDIO_MASK_ID]["type"] == "vloSetAudioLatentBinaryMasks"
