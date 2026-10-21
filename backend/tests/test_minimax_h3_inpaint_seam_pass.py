"""The MiniMax H3 inpaint workflows end with a seam pass.

Pass 1 generates the masked area beside clean kept tokens, so its layout at
the mask edge is committed with one-sided context. The seam pass regenerates a
band across that edge with both sides finished. The band is measured from the
latent mask pass 1 actually used (node 66, pooled and snapped to 2x2 tokens),
in 16 px latent cells, and a turbo LoRA draws it in a few steps. The LoRA goes
through vloMiniMaxH3LoraLoader, which refits its adaln updates onto the pruned
checkpoint instead of dropping them.

The kept-side band repaints original content, so the rules declare a
generation mask grow that covers it once the patch is on the timeline.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from services.workflow_rules.schema import ResolvedWorkflowRules


ASSETS_DIR = Path(__file__).parents[1] / "assets" / ".config"
WORKFLOW_DIRS = (
    ASSETS_DIR / "default_workflows",
    ASSETS_DIR / "high_vram_workflows",
)
STEMS = ("vlo_minimax_h3_inpaint", "vlo_minimax_h3_inpaint_flf2va")

FIRST_PASS_SAMPLER_ID = 39
FIRST_PASS_GUIDER_ID = 38
LATENT_MASK_ID = 66
KEPT_BAND_ID = 105
GENERATED_BAND_ID = 107
BAND_ID = 108
SEAM_SCHEDULER_ID = 112
SEAM_GUIDER_ID = 113
SEAM_SAMPLER_ID = 114
SEAM_SWITCH_ID = 115
SEAM_LORA_ID = 116
ATTENTION_ID = 47
TURBO_LORA = "minimax_h3_turbo_v4_step600_ema.safetensors"
TURBO_URL = (
    "https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/resolve/main/"
    "minimax_h3_turbo_v4_step600_ema.safetensors"
)


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _cases() -> list[tuple[Path, str]]:
    return [(directory, stem) for directory in WORKFLOW_DIRS for stem in STEMS]


def _source(workflow: dict[str, Any], node: dict[str, Any], name: str) -> tuple[int, int]:
    links = {link[0]: link for link in workflow["links"]}
    link_id = next(inp["link"] for inp in node["inputs"] if inp["name"] == name)
    assert link_id is not None, f"{node['id']}.{name} is unwired"
    link = links[link_id]
    return link[1], link[2]


@pytest.fixture(params=_cases(), ids=lambda case: f"{case[0].name}/{case[1]}")
def packaged(request) -> tuple[dict[str, Any], dict[str, Any]]:
    directory, stem = request.param
    return (
        _load_json(directory / f"{stem}.json"),
        _load_json(directory / f"{stem}.rules.json"),
    )


def test_decoders_read_the_seam_switch(packaged):
    workflow, _ = packaged
    nodes = {node["id"]: node for node in workflow["nodes"]}

    switch = nodes[SEAM_SWITCH_ID]
    assert switch["type"] == "LazySwitchKJ"
    # Ships off: pass 1 alone unless the panel turns the seam pass on.
    assert switch["widgets_values"] == [False]
    assert _source(workflow, switch, "on_false") == (FIRST_PASS_SAMPLER_ID, 0)
    assert _source(workflow, switch, "on_true") == (SEAM_SAMPLER_ID, 0)
    for decoder_type in ("VAEDecode", "VAEDecodeAudio"):
        decoder = next(node for node in workflow["nodes"] if node["type"] == decoder_type)
        assert _source(workflow, decoder, "samples") == (SEAM_SWITCH_ID, 0)


def test_band_is_measured_from_the_snapped_latent_mask(packaged):
    workflow, _ = packaged
    nodes = {node["id"]: node for node in workflow["nodes"]}

    assert _source(workflow, nodes[KEPT_BAND_ID], "mask") == (LATENT_MASK_ID, 0)
    inverted = _source(workflow, nodes[GENERATED_BAND_ID], "mask")[0]
    assert nodes[inverted]["type"] == "InvertMask"
    assert _source(workflow, nodes[inverted], "mask") == (LATENT_MASK_ID, 0)
    assert nodes[LATENT_MASK_ID]["widgets_values"] == ["max", "max", 2]

    # One cell (16 px) into the kept area, four (64 px) into the generated one.
    assert nodes[KEPT_BAND_ID]["widgets_values"] == [1]
    assert nodes[GENERATED_BAND_ID]["widgets_values"] == [4]
    assert nodes[BAND_ID]["widgets_values"][-1] == "multiply"


def test_seam_pass_conditions_like_the_first_pass(packaged):
    workflow, _ = packaged
    nodes = {node["id"]: node for node in workflow["nodes"]}

    assert _source(workflow, nodes[SEAM_GUIDER_ID], "conditioning") == _source(
        workflow, nodes[FIRST_PASS_GUIDER_ID], "conditioning"
    )
    assert _source(workflow, nodes[SEAM_GUIDER_ID], "model") == (SEAM_LORA_ID, 0)
    assert _source(workflow, nodes[SEAM_SCHEDULER_ID], "model") == (SEAM_LORA_ID, 0)
    assert nodes[SEAM_SCHEDULER_ID]["widgets_values"] == ["simple", 4, 1.0]


def test_seam_lora_loads_the_turbo_lora_through_the_h3_loader(packaged):
    workflow, _ = packaged
    lora = {node["id"]: node for node in workflow["nodes"]}[SEAM_LORA_ID]

    assert lora["type"] == "vloMiniMaxH3LoraLoader"
    assert lora["mode"] == 0
    assert _source(workflow, lora, "model") == (ATTENTION_ID, 0)
    assert lora["widgets_values"] == [TURBO_LORA, 1, "auto"]
    assert lora["widgets_values_named"] == {
        "lora_name": TURBO_LORA,
        "strength_model": 1,
        "base": "auto",
    }
    # The download list is read from node properties, so the seam LoRA ships
    # its own entry rather than relying on a bypassed stack loader's.
    assert lora["properties"]["models"] == [
        {"name": TURBO_LORA, "url": TURBO_URL, "directory": "loras"}
    ]


def test_generation_mask_grow_reads_exposed_seam_widgets(packaged):
    _, rules = packaged
    model = ResolvedWorkflowRules.model_validate(rules)

    assert model.generation_mask is not None
    (grow_case,) = model.generation_mask.grow
    assert grow_case.when.ref.node_id == str(SEAM_SWITCH_ID)
    refs = {(term.ref.node_id, term.ref.param): term.scale for term in grow_case.terms if term.ref}
    assert refs == {("103", "expand"): 1.0, (str(KEPT_BAND_ID), "expand"): 16.0}
    assert [term.value for term in grow_case.terms if term.ref is None] == [32.0]
    for node_id, param in refs:
        assert param in rules["nodes"][node_id]["widgets"]
    assert rules["nodes"][str(SEAM_SWITCH_ID)]["widgets"]["switch"]["default"] is False


@pytest.mark.parametrize(
    "term",
    [{}, {"value": 4, "ref": {"kind": "workflow_param", "node_id": "1", "param": "x"}}],
    ids=["neither", "both"],
)
def test_generation_mask_grow_terms_take_one_source(term):
    rules = {
        "version": 3,
        "generation_mask": {"grow": [{"when": {"kind": "always"}, "terms": [term]}]},
    }
    with pytest.raises(ValidationError):
        ResolvedWorkflowRules.model_validate(rules)
