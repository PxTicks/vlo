"""Route-level coverage for the workflowGraph request bodies.

A graph cannot ride on a GET query string, so the download endpoints grew a
POST /downloads/models variant plus a workflowGraph field on start/start-batch.
These tests exercise the HTTP seam, not the registry internals.
"""


import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import downloads
from services import download_service
from services.download_service import DownloadFileSpec, DownloadJob


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

MODEL = {
    "key": "checkpoints:model.safetensors",
    "label": "model.safetensors",
    "description": "Save to ComfyUI/models/checkpoints",
    "installed": False,
    "directory": "checkpoints",
    "filename": "model.safetensors",
    "gated": False,
    "gatedRepoUrl": None,
}


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(downloads.router)
    return TestClient(app)


@pytest.fixture
def registry(monkeypatch, tmp_path):
    """Record what the router hands the registry, and answer from the graph."""
    calls: dict[str, list] = {"list": [], "specs": [], "gated": []}

    def fake_list(workflow_id, workflow_graph=None):
        calls["list"].append((workflow_id, workflow_graph))
        # Mirrors the real registry: a temp id only resolves via the graph.
        if workflow_graph is None and workflow_id != "wf.json":
            raise ValueError(f"Workflow not found: {workflow_id}")
        return [dict(MODEL)] if workflow_id == "wf.json" or workflow_graph else []

    def fake_specs(workflow_id, model_key, workflow_graph=None):
        calls["specs"].append((workflow_id, model_key, workflow_graph))
        return [
            DownloadFileSpec(
                url="https://huggingface.co/acme/repo/resolve/main/model.safetensors",
                dest_path=str(tmp_path / "model.safetensors"),
                filename="model.safetensors",
            )
        ]

    def fake_gated(workflow_id, model_key, workflow_graph=None):
        calls["gated"].append((workflow_id, model_key, workflow_graph))
        return False

    monkeypatch.setattr(download_service, "_active_jobs", {})
    monkeypatch.setattr(download_service, "_active_destinations", {})
    monkeypatch.setattr(download_service, "_job_destinations", {})
    monkeypatch.setattr(download_service, "_pending_job_ids", [])
    monkeypatch.setattr("routers.downloads.get_available_sam2_models", lambda: [])
    monkeypatch.setattr("routers.downloads.get_available_sam_audio_models", lambda: [])
    monkeypatch.setattr(
        "routers.downloads.is_comfyui_model_downloads_enabled", lambda: True
    )
    monkeypatch.setattr("routers.downloads.get_available_workflow_models", fake_list)
    monkeypatch.setattr("routers.downloads.get_workflow_download_specs", fake_specs)
    monkeypatch.setattr("routers.downloads.is_workflow_model_gated", fake_gated)
    monkeypatch.setattr(
        "routers.downloads.download_service.start_download",
        lambda label, files, auth_token=None: DownloadJob(
            job_id="job-1", label=label, files=files, auth_token=auth_token
        ),
    )
    return calls


def test_post_models_forwards_the_graph_for_a_temp_workflow(client, registry):
    response = client.post(
        "/downloads/models",
        json={"workflowId": "__temp__", "workflowGraph": GRAPH},
    )

    assert response.status_code == 200
    assert response.json()["comfyui"]["workflowModels"] == [MODEL]
    assert registry["list"] == [("__temp__", GRAPH)]


def test_post_models_forwards_the_graph_without_a_workflow_id(client, registry):
    response = client.post("/downloads/models", json={"workflowGraph": GRAPH})

    assert response.status_code == 200
    assert response.json()["comfyui"]["workflowModels"] == [MODEL]
    assert registry["list"] == [(None, GRAPH)]


def test_post_models_without_a_graph_still_resolves_by_id(client, registry):
    response = client.post("/downloads/models", json={"workflowId": "wf.json"})

    assert response.status_code == 200
    assert response.json()["comfyui"]["workflowModels"] == [MODEL]
    assert registry["list"] == [("wf.json", None)]


def test_post_models_returns_400_when_nothing_resolves(client, registry):
    response = client.post("/downloads/models", json={"workflowId": "__temp__"})

    assert response.status_code == 400
    assert "not found" in response.json()["detail"]


def test_post_models_with_neither_id_nor_graph_skips_workflow_models(client, registry):
    response = client.post("/downloads/models", json={})

    assert response.status_code == 200
    assert response.json()["comfyui"]["workflowModels"] == []
    assert registry["list"] == []


def test_get_models_is_unchanged_and_sends_no_graph(client, registry):
    response = client.get("/downloads/models", params={"workflowId": "wf.json"})

    assert response.status_code == 200
    assert response.json()["comfyui"]["workflowModels"] == [MODEL]
    assert registry["list"] == [("wf.json", None)]


def test_start_forwards_the_graph_to_specs_and_gating(client, registry):
    response = client.post(
        "/downloads/start",
        json={
            "modelType": "comfyui-workflow",
            "modelKey": "checkpoints:model.safetensors",
            "workflowId": "__temp__",
            "workflowGraph": GRAPH,
        },
    )

    assert response.status_code == 200
    assert response.json()["jobId"] == "job-1"
    assert registry["specs"] == [("__temp__", "checkpoints:model.safetensors", GRAPH)]
    assert registry["gated"] == [("__temp__", "checkpoints:model.safetensors", GRAPH)]


def test_start_batch_forwards_the_graph_for_every_key(client, registry):
    response = client.post(
        "/downloads/start-batch",
        json={
            "modelType": "comfyui-workflow",
            "modelKeys": ["checkpoints:a.safetensors", "checkpoints:b.safetensors"],
            "workflowId": "__temp__",
            "workflowGraph": GRAPH,
        },
    )

    assert response.status_code == 200
    assert response.json()["errors"] == []
    assert [call[0] for call in registry["specs"]] == ["__temp__", "__temp__"]
    assert [call[2] for call in registry["specs"]] == [GRAPH, GRAPH]


def test_start_requires_an_id_or_a_graph(client, registry):
    response = client.post(
        "/downloads/start",
        json={
            "modelType": "comfyui-workflow",
            "modelKey": "checkpoints:model.safetensors",
        },
    )

    assert response.status_code == 400
    assert "workflowGraph" in response.json()["detail"]
    assert registry["specs"] == []
