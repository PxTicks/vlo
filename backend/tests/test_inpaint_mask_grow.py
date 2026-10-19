"""The MiniMax H3 inpaint workflows carry an adjustable pixel grow on the mask.

A tight segmentation mask leaves object edges, motion blur and shadows outside
it, and the model regrows the object from them, so the panel exposes the grow
in pixels. It ships at 0, which vloGrowMask passes straight through: the latent
mask's max-pooling and token snap already regenerate every cell the mask
touches, so growth is only for margins beyond that.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from services.workflow_rules.schema import ResolvedWorkflowRules


ASSETS_DIR = Path(__file__).parents[1] / "assets" / ".config"
WORKFLOW_DIRS = (
    ASSETS_DIR / "default_workflows",
    ASSETS_DIR / "high_vram_workflows",
)

# stem -> (grow node id, expand px, mask producer id, [(consumer id, input name)])
GROW_CASES = {
    "vlo_minimax_h3_inpaint": (103, 0, 9, [(20, "mask")]),
    "vlo_minimax_h3_inpaint_flf2va": (103, 0, 9, [(20, "mask")]),
}


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("workflow_dir", WORKFLOW_DIRS, ids=["default", "high_vram"])
@pytest.mark.parametrize("stem", sorted(GROW_CASES))
def test_mask_grow_sits_between_the_resized_mask_and_its_consumers(
    stem: str, workflow_dir: Path
) -> None:
    grow_id, expand, producer_id, consumers = GROW_CASES[stem]
    workflow = _load_json(workflow_dir / f"{stem}.json")
    nodes = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: tuple(link[1:6]) for link in workflow["links"]}

    grow = nodes[grow_id]
    assert grow["type"] == "vloGrowMask"
    assert grow["mode"] == 0
    assert grow["widgets_values"] == [expand]
    assert workflow["last_node_id"] >= grow_id

    assert [i["type"] for i in grow["inputs"] if "widget" not in i] == ["MASK"]
    assert [o["type"] for o in grow["outputs"]] == ["MASK"]

    # The producer is the mask at encode resolution, and it feeds only the grow.
    in_link = grow["inputs"][0]["link"]
    assert links[in_link] == (producer_id, 0, grow_id, 0, "MASK")
    producer_out = next(o for o in nodes[producer_id]["outputs"] if o["type"] == "MASK")
    assert producer_out["links"] == [in_link]

    grown_targets = sorted(links[link_id][2:4] for link_id in grow["outputs"][0]["links"])
    expected_targets = sorted(
        (consumer_id, [i["name"] for i in nodes[consumer_id]["inputs"]].index(name))
        for consumer_id, name in consumers
    )
    assert grown_targets == expected_targets


@pytest.mark.parametrize("workflow_dir", WORKFLOW_DIRS, ids=["default", "high_vram"])
@pytest.mark.parametrize("stem", sorted(GROW_CASES))
def test_latent_mask_is_conservative_and_snapped_to_h3_tokens(
    stem: str, workflow_dir: Path
) -> None:
    # Bilinear samples only the centre of each 16 px cell, so a cell the mask
    # partly covers can be kept. H3 also labels each 2x2-cell token as kept or
    # generated as a whole, so a token whose cells disagree has half its
    # prediction overwritten every step. Max-pooling and a 2-cell snap rule
    # out both.
    workflow = _load_json(workflow_dir / f"{stem}.json")
    latent_masks = [n for n in workflow["nodes"] if n["type"] == "vloMaskToLatentMask"]

    assert len(latent_masks) == 1
    node = latent_masks[0]
    assert [i["name"] for i in node["inputs"] if "widget" in i] == [
        "pooling_method",
        "resize_mode",
        "snap_grid",
    ]
    assert node["widgets_values"] == ["max", "max", 2]


@pytest.mark.parametrize("stem", sorted(GROW_CASES))
def test_mask_grow_is_an_advanced_pixel_widget_that_ships_off(stem: str) -> None:
    grow_id, expand = GROW_CASES[stem][:2]
    rules = _load_json(WORKFLOW_DIRS[0] / f"{stem}.rules.json")
    ResolvedWorkflowRules.model_validate(rules)
    assert _load_json(WORKFLOW_DIRS[1] / f"{stem}.rules.json") == rules

    widget = rules["nodes"][str(grow_id)]["widgets"]["expand"]
    assert widget["value_type"] == "int"
    assert widget["unit"] == "px"
    assert widget["min"] == 0
    assert widget["default"] == expand
    assert widget["section_id"] == "advanced_settings"
    assert any(section["id"] == "advanced_settings" for section in rules["sections"])

    # 0 is the off state, so nothing may bypass the node behind the widget's back.
    assert "mask_grow_enabled" not in rules.get("frontend_controls", {})
    assert not any(str(grow_id) in rewrite.get("bypass", []) for rewrite in rules["rewrites"])
