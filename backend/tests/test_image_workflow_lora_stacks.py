from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.workflow_rules import load_rules_model_for_workflow


ASSETS_DIR = Path(__file__).parents[1] / "assets" / ".config"
WORKFLOW_DIRS = (
    ASSETS_DIR / "default_workflows",
    ASSETS_DIR / "high_vram_workflows",
)
WORKFLOW_CHAINS = (
    ("vlo_krea2_turbo", "30:", (10, 15, 55, 56, 57, 3), "KSampler"),
    ("vlo_klein_multi", "", (135, 167, 168, 169, 170, 144), "CFGGuider"),
    (
        "vlo_qwen_image_2_1_edit", "459:", (451, 482, 483, 484, 485, 469),
        "QwenImage21Cache",
    ),
)
PROFILE_WEIGHT_REPLACEMENTS = {
    "vlo_krea2_turbo": (
        ("krea2_turbo_bf16.safetensors", "krea2_turbo_int8_convrot.safetensors"),
        ("qwen3vl_4b_bf16.safetensors", "qwen3vl_4b_fp8_scaled.safetensors"),
    ),
    "vlo_klein_multi": (
        (
            "Comfy-Org/vae-text-encorder-for-flux-klein-9b/resolve/main/split_files/text_encoders",
            "Comfy-Org/flux2-klein-9B/resolve/main/split_files/text_encoders",
        ),
        ("qwen_3_8b.safetensors", "qwen_3_8b_fp8mixed.safetensors"),
    ),
    "vlo_qwen_image_2_1_edit": (
        ("qwen_image_2.1_bf16.safetensors", "qwen_image_2.1_int8_convrot.safetensors"),
        ("qwen3vl_8b_bf16.safetensors", "qwen3vl_8b_int8_convrot.safetensors"),
    ),
}


@pytest.mark.parametrize("name", PROFILE_WEIGHT_REPLACEMENTS)
def test_image_lora_stack_profiles_agree_apart_from_weights(name):
    default = (WORKFLOW_DIRS[0] / f"{name}.json").read_text(encoding="utf-8")
    high_vram = (WORKFLOW_DIRS[1] / f"{name}.json").read_text(encoding="utf-8")
    original_high_vram = json.loads(high_vram)
    for high_weight, default_weight in PROFILE_WEIGHT_REPLACEMENTS[name]:
        assert high_weight in high_vram
        assert default_weight in default
        high_vram = high_vram.replace(high_weight, default_weight)
    normalized = json.loads(high_vram)
    if name == "vlo_qwen_image_2_1_edit":
        # Qwen's shared notes list both precisions in either profile; only
        # executable weight selections need normalization in this workflow.
        for index, node in enumerate(original_high_vram["nodes"]):
            if node["type"] == "MarkdownNote":
                normalized["nodes"][index] = node
    assert normalized == json.loads(default)
    assert json.loads((WORKFLOW_DIRS[0] / f"{name}.rules.json").read_text()) == (
        json.loads((WORKFLOW_DIRS[1] / f"{name}.rules.json").read_text())
    )


@pytest.mark.parametrize("directory", WORKFLOW_DIRS, ids=("default", "high_vram"))
@pytest.mark.parametrize("name,prefix,chain,target_type", WORKFLOW_CHAINS)
def test_image_lora_stack_preserves_model_path(directory, name, prefix, chain, target_type):
    workflow_name = f"{name}.json"
    workflow = json.loads((directory / workflow_name).read_text(encoding="utf-8"))
    rules, warnings = load_rules_model_for_workflow(directory, workflow_name)
    assert warnings == []
    [stack] = rules.lora_stacks
    assert stack.nodes == [f"{prefix}{node_id}" for node_id in chain[1:-1]]
    assert stack.section_id == "lora_loaders"
    assert stack.group_title == "LoRA"
    [section] = [section for section in rules.sections if section.id == stack.section_id]
    assert section.default_open is True

    if prefix:
        [graph] = workflow["definitions"]["subgraphs"]
        instance = next(node for node in workflow["nodes"] if node["type"] == graph["id"])
        assert prefix == f"{instance['id']}:"
        links = {
            link["id"]: [
                link["id"], link["origin_id"], link["origin_slot"],
                link["target_id"], link["target_slot"], link["type"],
            ]
            for link in graph["links"]
        }
        last_node_id = graph["state"]["lastNodeId"]
        last_link_id = graph["state"]["lastLinkId"]
    else:
        graph = workflow
        links = {link[0]: link for link in graph["links"]}
        last_node_id = graph["last_node_id"]
        last_link_id = graph["last_link_id"]
    nodes = {node["id"]: node for node in graph["nodes"]}
    assert nodes[chain[0]]["type"] == "UNETLoader"
    assert nodes[chain[-1]]["type"] == target_type
    assert {
        node["id"] for node in graph["nodes"]
        if node["type"] == "LoraLoaderModelOnly"
    } == set(chain[1:-1])
    for index, node_id in enumerate(chain[1:-1]):
        loader = nodes[node_id]
        # Unselected slots stay optional even if no LoRAs are installed.
        assert loader["mode"] == 4
        assert loader["inputs"][0]["type"] == "MODEL"
        assert loader["outputs"][0]["type"] == "MODEL"
        assert "models" not in loader["properties"]
        if name == "vlo_krea2_turbo":
            assert loader["widgets_values"] == ["krea2_darkbrush.safetensors", 0.8]
            if index == 0:
                # Preserve the first slot's promoted controls, but each new
                # slot must have its own editable model and strength.
                assert links[58] == [58, -10, 6, 15, 1, "COMBO"]
                assert links[59] == [59, -10, 7, 15, 2, "FLOAT"]
                continue
        else:
            assert loader["widgets_values"] == ["None", 1]
        assert all(port["link"] is None for port in loader["inputs"][1:])
        assert loader["widgets_values_named"] == {
            "lora_name": loader["widgets_values"][0],
            "strength_model": loader["widgets_values"][1],
        }

    # Socket metadata and serialized links must agree so ComfyUI can bypass
    # empty slots without disconnecting the guider, sampler, or cache patch.
    for source_id, target_id in zip(chain, chain[1:]):
        link_id = nodes[target_id]["inputs"][0]["link"]
        assert links[link_id] == [link_id, source_id, 0, target_id, 0, "MODEL"]
        assert nodes[source_id]["outputs"][0]["links"] == [link_id]
    if name == "vlo_qwen_image_2_1_edit":
        assert nodes[458]["inputs"][0]["link"] == 689
        assert links[689] == [689, 469, 0, 458, 0, "MODEL"]
    assert len(nodes) == len(graph["nodes"])
    assert len(links) == len(graph["links"])
    assert last_node_id >= max(nodes)
    assert last_link_id >= max(links)
