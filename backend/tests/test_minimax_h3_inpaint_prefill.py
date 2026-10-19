"""The MiniMax H3 inpaint workflows fill the masked area before encoding.

At full denoise the model never sees what lies under the generated mask, but
the VAE encoder does, and a hard edge there (the black around an outpaint)
leaks into the kept latents beside it as a seam. vloFillMaskedArea replaces
those pixels with a smooth extension first. Below full denoise the masked
content is the init, so the fill must step aside, and it reads the mask after
the video-retake switch so a fully kept video is never altered.
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
STEMS = ("vlo_minimax_h3_inpaint", "vlo_minimax_h3_inpaint_flf2va")

FILL_ID = 104
TRIM_ID = 74  # "Trim source to grid": the source frames at encode resolution
ENCODE_ID = 55
VIDEO_RETAKE_SWITCH_ID = 28
SCHEDULER_ID = "37"


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _source_of(workflow: dict[str, Any], link_id: int) -> tuple[int, int]:
    link = next(link for link in workflow["links"] if link[0] == link_id)
    return link[1], link[2]


@pytest.mark.parametrize("workflow_dir", WORKFLOW_DIRS, ids=["default", "high_vram"])
@pytest.mark.parametrize("stem", STEMS)
def test_fill_sits_between_the_trimmed_source_and_the_encoder(
    stem: str, workflow_dir: Path
) -> None:
    workflow = _load_json(workflow_dir / f"{stem}.json")
    nodes = {node["id"]: node for node in workflow["nodes"]}

    fill = nodes[FILL_ID]
    assert fill["type"] == "vloFillMaskedArea"
    assert fill["mode"] == 0
    assert fill["widgets_values"] == [0.125]
    assert workflow["last_node_id"] >= FILL_ID

    inputs = {i["name"]: i for i in fill["inputs"]}
    assert _source_of(workflow, inputs["image"]["link"]) == (TRIM_ID, 0)
    assert _source_of(workflow, inputs["mask"]["link"]) == (VIDEO_RETAKE_SWITCH_ID, 0)

    pixels = next(i for i in nodes[ENCODE_ID]["inputs"] if i["name"] == "pixels")
    assert _source_of(workflow, pixels["link"]) == (FILL_ID, 0)
    assert nodes[TRIM_ID]["outputs"][0]["links"] == [inputs["image"]["link"]]

    # Bypass passes IMAGE straight through, which is how the switches turn it off.
    assert [i["type"] for i in fill["inputs"] if "widget" not in i] == ["IMAGE", "MASK"]
    assert [o["type"] for o in fill["outputs"]] == ["IMAGE"]


@pytest.mark.parametrize("stem", STEMS)
def test_fill_is_bypassed_below_full_denoise(stem: str) -> None:
    rules = _load_json(WORKFLOW_DIRS[0] / f"{stem}.rules.json")
    ResolvedWorkflowRules.model_validate(rules)
    assert _load_json(WORKFLOW_DIRS[1] / f"{stem}.rules.json") == rules

    switch = next(
        s for s in rules["effect_switches"] if s["id"] == "fill_masked_area_only_on_full_denoise"
    )
    assert switch["cases"] == [
        {
            "when": {
                "kind": "compare",
                "ref": {"kind": "workflow_param", "node_id": SCHEDULER_ID, "param": "denoise"},
                "operator": "lt",
                "value": 1,
            },
            "bypass": [str(FILL_ID)],
        }
    ]


@pytest.mark.parametrize("stem", STEMS)
def test_fill_has_an_advanced_toggle_that_defaults_on(stem: str) -> None:
    rules = _load_json(WORKFLOW_DIRS[0] / f"{stem}.rules.json")

    control = rules["frontend_controls"]["prefill_enabled"]
    assert control["value_type"] == "boolean"
    assert control["default"] is True
    assert control["section_id"] == "advanced_settings"

    toggles = [
        rewrite
        for rewrite in rules["rewrites"]
        if rewrite["when"].get("ref", {}).get("control_id") == "prefill_enabled"
    ]
    assert toggles == [
        {
            "when": {
                "kind": "compare",
                "ref": {"kind": "frontend_control", "control_id": "prefill_enabled"},
                "operator": "eq",
                "value": False,
            },
            "bypass": [str(FILL_ID)],
        }
    ]
