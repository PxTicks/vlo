"""Enhancement graphs preserve the source and the IC-LoRA fusion contract."""

import json
from pathlib import Path

import pytest

from services import model_registry
from services.workflow_rules import load_rules_model_for_workflow


WORKFLOW_ROOT = Path(__file__).parents[1] / "assets" / ".config"
TASKS = {
    "refine": ("Refine-Details", "refine-details", [1024, 576], "4K"),
    "restore": ("Restore", "restore", [960, 544], "FullHD"),
}


@pytest.fixture(params=["default_workflows", "high_vram_workflows"])
def profile(request):
    return request.param


@pytest.fixture(params=TASKS)
def task(request):
    return request.param


@pytest.fixture
def workflow(profile, task):
    return json.loads(
        (WORKFLOW_ROOT / profile / f"vlo_ltx2_5_{task}.json").read_text()
    )


def _nodes(workflow):
    return {node["id"]: node for node in workflow["nodes"]}


def _source(workflow, node_id, input_name):
    node = _nodes(workflow)[node_id]
    input_spec = next(item for item in node["inputs"] if item["name"] == input_name)
    link = next(link for link in workflow["links"] if link[0] == input_spec["link"])
    return tuple(link[1:3])


def test_enhance_graph_links_have_consistent_endpoints_and_types(workflow):
    nodes = _nodes(workflow)
    links = {link[0]: link for link in workflow["links"]}
    assert len(nodes) == len(workflow["nodes"])
    assert len(links) == len(workflow["links"])
    assert max(nodes) <= workflow["last_node_id"]
    assert max(links) <= workflow["last_link_id"]
    for link_id, source, output_slot, target, input_slot, link_type in links.values():
        output_spec = nodes[source]["outputs"][output_slot]
        input_spec = nodes[target]["inputs"][input_slot]
        assert link_id in output_spec["links"]
        assert input_spec["link"] == link_id
        assert output_spec["type"] == input_spec["type"] == link_type
    for node in nodes.values():
        for slot, input_spec in enumerate(node.get("inputs", [])):
            if input_spec.get("link") is not None:
                assert links[input_spec["link"]][3:5] == [node["id"], slot]
        for slot, output_spec in enumerate(node.get("outputs", [])):
            for link_id in output_spec.get("links") or []:
                assert links[link_id][1:3] == [node["id"], slot]

    # A disconnected loader or old inpainting branch can still execute in ComfyUI.
    ancestors = {775}
    pending = [775]
    while pending:
        target = pending.pop()
        for _, source, _, linked_target, _, _ in links.values():
            if linked_target == target and source not in ancestors:
                ancestors.add(source)
                pending.append(source)
    assert ancestors == set(nodes)


def test_source_video_drives_geometry_length_audio_and_fps(workflow, task):
    nodes = _nodes(workflow)
    assert nodes[774]["type"] == "vloMemoryLoadVideo"
    assert _source(workflow, 690, "video") == (774, 0)
    assert _source(workflow, 780, "image") == (690, 0)
    assert _source(workflow, 724, "image") == (690, 0)
    assert _source(workflow, 723, "length") == (724, 3)
    assert nodes[780]["widgets_values"][5] == TASKS[task][3]
    for consumer in (512, 723):
        assert _source(workflow, consumer, "width") == (780, 4)
        assert _source(workflow, consumer, "height") == (780, 5)
    assert nodes[512]["type"] == "ImageScale"
    assert nodes[512]["widgets_values"][0::3] == ["lanczos", "disabled"]
    assert _source(workflow, 512, "image") == (690, 0)
    assert _source(workflow, 781, "image") == (512, 0)
    assert _source(workflow, 107, "frame_rate") == (690, 2)
    assert _source(workflow, 775, "audio") == (690, 1)
    assert _source(workflow, 775, "fps") == (690, 2)
    assert nodes[775]["type"] == "vloSaveVideo"
    # 0x0 keeps the generated frame size, rather than restoring the source size.
    assert nodes[775]["widgets_values"][2:5] == [False, 0, 0]
    assert _source(workflow, 775, "images") == (127, 0)
    assert _source(workflow, 127, "samples") == (782, 0)


def test_fusion_uses_streaming_reference_guides_and_task_training_window(workflow, task):
    nodes = _nodes(workflow)
    guide = nodes[781]
    sampler = nodes[782]
    assert guide["type"] == "LTXAddVideoICLoRAGuide"
    assert guide["widgets_values"] == [0, 1, 1, "disabled", False, 256, 64, True, 97]
    assert _source(workflow, 781, "latent") == (723, 0)
    assert sampler["type"] == "LTXVTiledFusionSampler"
    assert sampler["widgets_values"][2:9] == [1, *TASKS[task][2], 0.5, 0.05, 1, 97]
    assert _source(workflow, 782, "latents") == (781, 2)
    assert _source(workflow, 782, "positive") == (781, 0)
    assert _source(workflow, 782, "negative") == (781, 1)
    assert _source(workflow, 782, "model") == (776, 0)
    assert _source(workflow, 776, "model") == (474, 0)
    assert _source(workflow, 782, "tile_frames") == _source(workflow, 781, "tile_frames")
    assert nodes[783]["widgets_values"][0] == 97
    assert nodes[137]["widgets_values"] == ["euler"]
    sigmas = [float(value) for value in nodes[480]["widgets_values"][0].split(",")]
    assert len(sigmas) == 9
    assert sigmas[-1] == 0
    assert all(a > b for a, b in zip(sigmas, sigmas[1:]))
    assert nodes[127]["type"] == "VAEDecodeTiled"


def test_models_reuse_profile_stack_and_expose_gated_adapter_downloads(
    workflow, profile, task, tmp_path, monkeypatch
):
    monkeypatch.setattr(model_registry, "get_comfyui_install_dir", lambda: tmp_path)
    original = json.loads((WORKFLOW_ROOT / profile / "vlo_ltx2_5_inpaint.json").read_text())
    nodes = _nodes(workflow)
    for node_id in (463, 466, 474):
        assert nodes[node_id]["widgets_values"] == _nodes(original)[node_id]["widgets_values"]
        assert nodes[node_id]["properties"]["models"] == _nodes(original)[node_id]["properties"]["models"]

    adapter, filename_task, _, _ = TASKS[task]
    filename = f"ltx-2.5-22b-ic-lora-{filename_task}-1.0.safetensors"
    repo = f"https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-{adapter}"
    key = f"loras:{filename}"
    models = model_registry.get_available_workflow_models("__temp__", workflow)
    assert len(models) == 4
    model = next(model for model in models if model["key"] == key)
    assert model["gated"] is True
    assert model["gatedRepoUrl"] == repo
    assert nodes[776]["widgets_values"] == [filename, 1]
    specs = model_registry.get_workflow_download_specs("__temp__", key, workflow)
    assert len(specs) == 1
    assert specs[0].url == f"{repo}/resolve/main/{filename}"
    assert Path(specs[0].dest_path) == tmp_path / "models" / "loras" / filename


def test_sidecars_load_source_selection_and_do_not_resize_enhanced_output(profile, task):
    rules, warnings = load_rules_model_for_workflow(
        WORKFLOW_ROOT / profile, f"vlo_ltx2_5_{task}.json"
    )
    assert warnings == []
    assert rules.nodes["774"].present.required is True
    selection = rules.nodes["774"].selection
    assert selection.export_fps == "project"
    assert selection.frame_step == 8
    assert selection.max_frames == 481
    assert rules.pipeline == []
    assert rules.nodes["782"].widgets["seed"].control_after_generate is True


def test_enhancement_workflows_are_visible_under_video_enhance():
    menu = json.loads((WORKFLOW_ROOT / "workflow_menu.json").read_text())
    for task in TASKS:
        workflow_id = f"vlo_ltx2_5_{task}.json"
        assert workflow_id not in menu["hidden_workflows"]
        placements = [item for item in menu["leaf_placements"] if item["workflow_id"] == workflow_id]
        assert len(placements) == 1
        assert placements[0]["parent_id"] == "video.enhance"
