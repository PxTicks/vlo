"""Workflows opened directly in the ComfyUI editor exist only as a graph in the
client, so their download options must resolve without a file on disk."""

import os
import sys

import pytest

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import model_registry
from services.model_registry import (
    _resolve_workflow_graph,
    get_available_workflow_models,
    get_workflow_download_specs,
    is_workflow_model_gated,
)


GRAPH = {
    "nodes": [
        {
            "properties": {
                "models": [
                    {
                        "name": "model.safetensors",
                        "url": "https://huggingface.co/acme/repo/resolve/main/model.safetensors",
                        "directory": "checkpoints",
                    }
                ]
            }
        }
    ]
}


@pytest.fixture
def comfyui_dir(tmp_path, monkeypatch):
    install_dir = tmp_path / "ComfyUI"
    (install_dir / "models" / "checkpoints").mkdir(parents=True)
    monkeypatch.setattr(model_registry, "get_comfyui_install_dir", lambda: install_dir)
    return install_dir


def test_supplied_graph_wins_over_a_stale_workflow_on_disk(tmp_path, monkeypatch):
    """A saved workflow edited in the editor but not saved back must resolve
    against the live graph, not the stale file."""
    monkeypatch.setattr(model_registry, "WORKFLOWS_DIR", tmp_path)
    (tmp_path / "wf.json").write_text('{"nodes": [{"id": 1}]}', encoding="utf-8")

    assert _resolve_workflow_graph("wf.json", GRAPH) is GRAPH


def test_resolve_workflow_graph_loads_from_disk_without_a_graph(tmp_path, monkeypatch):
    monkeypatch.setattr(model_registry, "WORKFLOWS_DIR", tmp_path)
    (tmp_path / "wf.json").write_text('{"nodes": [{"id": 1}]}', encoding="utf-8")

    assert _resolve_workflow_graph("wf.json", None) == {"nodes": [{"id": 1}]}


def test_resolve_workflow_graph_uses_graph_for_temp_workflows():
    assert _resolve_workflow_graph("__temp__", GRAPH) is GRAPH


def test_resolve_workflow_graph_requires_a_source():
    with pytest.raises(ValueError):
        _resolve_workflow_graph(None, None)

    with pytest.raises(ValueError, match="not found"):
        _resolve_workflow_graph("missing.json", None)


def test_available_models_read_from_graph_when_workflow_is_not_on_disk(comfyui_dir):
    models = get_available_workflow_models("__temp__", GRAPH)

    assert [model["key"] for model in models] == ["checkpoints:model.safetensors"]
    assert models[0]["installed"] is False


def test_available_models_report_installed_from_graph(comfyui_dir):
    (comfyui_dir / "models" / "checkpoints" / "model.safetensors").write_bytes(b"")

    models = get_available_workflow_models("__temp__", GRAPH)

    assert models[0]["installed"] is True


def test_download_specs_read_from_graph_when_workflow_is_not_on_disk(comfyui_dir):
    specs = get_workflow_download_specs(
        "__temp__",
        "checkpoints:model.safetensors",
        GRAPH,
    )

    assert len(specs) == 1
    assert specs[0].url == GRAPH["nodes"][0]["properties"]["models"][0]["url"]
    assert specs[0].dest_path == str(
        comfyui_dir / "models" / "checkpoints" / "model.safetensors"
    )


def test_gating_is_read_from_graph(comfyui_dir):
    gated_graph = {
        "nodes": [
            {
                "properties": {
                    "models": [
                        {
                            "name": "flux1-dev.safetensors",
                            "url": (
                                "https://huggingface.co/black-forest-labs/FLUX.1-dev"
                                "/resolve/main/flux1-dev.safetensors"
                            ),
                            "directory": "diffusion_models",
                        }
                    ]
                }
            }
        ]
    }

    assert is_workflow_model_gated(
        "__temp__",
        "diffusion_models:flux1-dev.safetensors",
        gated_graph,
    )
    assert not is_workflow_model_gated(
        "__temp__",
        "checkpoints:model.safetensors",
        GRAPH,
    )
