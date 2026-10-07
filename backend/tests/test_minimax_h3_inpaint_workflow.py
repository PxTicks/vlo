from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from minimax_h3_profiles import assert_profiles_agree_apart_from_weights
from services.workflow_rules.schema import ResolvedWorkflowRules


ASSETS_DIR = Path(__file__).parents[1] / "assets" / ".config"
WORKFLOW_NAME = "vlo_minimax_h3_inpaint.json"
RULES_NAME = "vlo_minimax_h3_inpaint.rules.json"
WORKFLOW_DIRS = (
    ASSETS_DIR / "default_workflows",
    ASSETS_DIR / "high_vram_workflows",
)


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_minimax_h3_inpaint_workflow_is_packaged_in_both_modes():
    default_rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    high_vram_rules = _load_json(WORKFLOW_DIRS[1] / RULES_NAME)

    # The high-VRAM profile swaps in the pruned bf16 weights; the graph itself
    # and the rules are shared.
    assert_profiles_agree_apart_from_weights(WORKFLOW_NAME)
    assert high_vram_rules == default_rules
    ResolvedWorkflowRules.model_validate(default_rules)


def test_minimax_h3_inpaint_delivers_per_video_audio_flags_to_the_adapter():
    """The `audio` item option on the video batch has to reach the adapter.

    The rules expose a per-video audio tickbox, which the backend turns into
    the loader's comma-separated `include_audio` flag list. That list only
    becomes an `<Audio N>` reference if the loader's BOOLEAN output is actually
    wired to the adapter's `use_embedded_video_audio`; unwired, the toggle is
    rendered, injected, and silently discarded.
    """
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    nodes = {node["id"]: node for node in workflow["nodes"]}

    assert rules["nodes"]["84"]["present"]["repeatable"]["item_options"] == ["audio"]

    loader = nodes[84]
    adapter = nodes[81]
    assert loader["type"] == "vloMemoryLoadVideoBatch"
    assert adapter["type"] == "vloMiniMaxH3ReferenceToVideoBatch"
    assert [output["name"] for output in loader["outputs"]] == ["videos", "use audio"]

    flag_input = next(
        input_spec
        for input_spec in adapter["inputs"]
        if input_spec["name"] == "use_embedded_video_audio"
    )
    link_id = flag_input["link"]
    assert link_id is not None
    assert loader["outputs"][1]["links"] == [link_id]
    assert [
        tuple(link[1:5]) for link in workflow["links"] if link[0] == link_id
    ] == [(84, 1, 81, adapter["inputs"].index(flag_input))]


def test_minimax_h3_inpaint_leaves_soundtrack_overrides_unconnected():
    """`ref_video_audios` replaces a reference video's soundtrack wholesale.

    vlo prepares audio edits in its own editor, so the native override socket
    is deliberately unused here, exactly as in the reference-to-video workflow.
    """
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    adapter = {node["id"]: node for node in workflow["nodes"]}[81]

    overrides = next(
        input_spec
        for input_spec in adapter["inputs"]
        if input_spec["name"] == "ref_video_audios"
    )
    assert overrides["link"] is None


def test_minimax_h3_inpaint_lora_loader_ships_bypassed_between_unet_and_attention():
    rules = _load_json(WORKFLOW_DIRS[0] / RULES_NAME)
    workflow = _load_json(WORKFLOW_DIRS[0] / WORKFLOW_NAME)
    nodes = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: tuple(link[1:5]) for link in workflow["links"]}

    # Same contract as the i2v/r2v loaders: the panel discovers the bypassed
    # node, and bypassing it keeps ComfyUI's missing-model scan from flagging
    # the placeholder LoRA for users who do not have that file.
    lora = rules["nodes"]["99"]["widgets"]["lora_name"]
    assert lora["discover_when_bypassed"] is True
    assert lora["default_node_bypass"] is True
    assert "options" not in lora
    assert lora["section_id"] == "lora_loaders"

    sections = {section["id"]: section for section in rules["sections"]}
    assert sections["advanced_settings"]["order"] > sections["lora_loaders"]["order"]

    loader = nodes[99]
    assert loader["type"] == "LoraLoaderModelOnly"
    assert loader["mode"] == 4

    # UNETLoader -> LoRA stack -> attention; bypassing passes MODEL through.
    assert links[loader["inputs"][0]["link"]][:2] == (44, 0)
    for source_id, target_id in zip((99, 100, 101, 102), (100, 101, 102, 47)):
        assert [
            links[link_id][2]
            for link_id in nodes[source_id]["outputs"][0]["links"]
        ] == [target_id]
