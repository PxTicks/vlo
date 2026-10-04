from __future__ import annotations

import pytest

from minimax_h3_profiles import (
    WORKFLOW_DIRS,
    assert_profiles_agree_apart_from_weights,
    load_json,
)
from services.workflow_rules import load_rules_model_for_workflow


WORKFLOW_CHAINS = (
    ("i2v", (127, 150, 153, 154, 155, 151)),
    ("r2v", (127, 148, 150, 151, 152, 145)),
    ("inpaint", (44, 99, 100, 101, 102, 47)),
    ("inpaint_flf2va", (44, 99, 100, 101, 102, 47)),
    ("fun_controlnet_union", (44, 99, 111, 112, 113, 47)),
    ("masked_guide", (44, 106, 107, 108, 109, 47)),
    ("ttm", (17, 23, 41, 42, 43, 24)),
)


@pytest.mark.parametrize("task,chain", WORKFLOW_CHAINS)
def test_minimax_lora_stack_profiles_agree(task, chain):
    workflow_name = f"vlo_minimax_h3_{task}.json"
    assert_profiles_agree_apart_from_weights(workflow_name)
    assert load_json(WORKFLOW_DIRS[0] / f"vlo_minimax_h3_{task}.rules.json") == (
        load_json(WORKFLOW_DIRS[1] / f"vlo_minimax_h3_{task}.rules.json")
    )


@pytest.mark.parametrize("directory", WORKFLOW_DIRS, ids=("default", "high_vram"))
@pytest.mark.parametrize("task,chain", WORKFLOW_CHAINS)
def test_minimax_lora_stack_is_optional_and_wired_in_packing_order(directory, task, chain):
    workflow_name = f"vlo_minimax_h3_{task}.json"
    workflow = load_json(directory / workflow_name)
    rules, warnings = load_rules_model_for_workflow(directory, workflow_name)
    assert warnings == []
    [stack] = rules.lora_stacks
    assert stack.id == "model_loras"
    assert stack.nodes == [str(node_id) for node_id in chain[1:-1]]
    assert stack.section_id == "lora_loaders"
    assert stack.group_title == "LoRA"
    sections = {section.id: section for section in rules.sections}
    assert sections["lora_loaders"].default_open is True
    assert sections["lora_loaders"].order < sections["advanced_settings"].order

    nodes = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: link for link in workflow["links"]}
    assert nodes[chain[0]]["type"] == "UNETLoader"
    assert nodes[chain[-1]]["type"] == "ModelAttentionBackend"
    assert {
        node["id"]
        for node in workflow["nodes"]
        if node["type"] == "LoraLoaderModelOnly"
    } == set(chain[1:-1])
    for node_id in chain[1:-1]:
        loader = nodes[node_id]
        # Bypassed placeholders must not trigger ComfyUI's missing-model scan.
        assert loader["mode"] == 4
        assert loader["inputs"][0]["type"] == "MODEL"
        assert loader["outputs"][0]["type"] == "MODEL"
        assert loader["widgets_values"] == [
            "minimax_h3_turbo_v4_step600_ema.safetensors",
            1,
        ]
        assert loader["widgets_values_named"] == {
            "lora_name": loader["widgets_values"][0],
            "strength_model": 1,
        }
    assert "models" in nodes[chain[1]]["properties"]
    assert all("models" not in nodes[node_id]["properties"] for node_id in chain[2:-1])

    # Check both socket metadata and the link table: bypassing any empty slot
    # must preserve the model path through the remaining selected LoRAs.
    for source_id, target_id in zip(chain, chain[1:]):
        model_input = nodes[target_id]["inputs"][0]
        link_id = model_input["link"]
        assert links[link_id] == [link_id, source_id, 0, target_id, 0, "MODEL"]
        assert nodes[source_id]["outputs"][0]["links"] == [link_id]

    assert len(nodes) == len(workflow["nodes"])
    assert len(links) == len(workflow["links"])
    assert workflow["last_node_id"] >= max(nodes)
    assert workflow["last_link_id"] >= max(links)
