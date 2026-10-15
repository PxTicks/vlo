"""The MiniMax H3 inpaint workflows grow the mask by one latent cell, switchably.

A tight segmentation mask leaves object edges, motion blur and shadows outside
it, and the model regrows the object from them. MiniMax H3 also inpaints per
16 px latent cell, so a cell that only partly holds the mask can be kept and
reproduce what was under it. One latent cell of growth (16 px for the H3 video
VAE) covers both, and the panel can switch it off.
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
    "vlo_minimax_h3_inpaint": (103, 16, 9, [(20, "mask")]),
    "vlo_minimax_h3_inpaint_flf2va": (103, 16, 9, [(20, "mask")]),
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

    # Bypass passes the MASK input straight to the MASK output, which is what
    # makes the panel toggle a clean off switch.
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


@pytest.mark.parametrize("stem", sorted(GROW_CASES))
def test_mask_grow_is_an_advanced_toggle_that_bypasses_the_node(stem: str) -> None:
    grow_id = GROW_CASES[stem][0]
    rules = _load_json(WORKFLOW_DIRS[0] / f"{stem}.rules.json")
    ResolvedWorkflowRules.model_validate(rules)
    assert _load_json(WORKFLOW_DIRS[1] / f"{stem}.rules.json") == rules

    control = rules["frontend_controls"]["mask_grow_enabled"]
    assert control["value_type"] == "boolean"
    assert control["default"] is True
    assert control["section_id"] == "advanced_settings"
    assert any(section["id"] == "advanced_settings" for section in rules["sections"])

    grow_rewrites = [
        rewrite
        for rewrite in rules["rewrites"]
        if rewrite["when"].get("ref", {}).get("control_id") == "mask_grow_enabled"
    ]
    assert grow_rewrites == [
        {
            "when": {
                "kind": "compare",
                "ref": {"kind": "frontend_control", "control_id": "mask_grow_enabled"},
                "operator": "eq",
                "value": False,
            },
            "bypass": [str(grow_id)],
        }
    ]
