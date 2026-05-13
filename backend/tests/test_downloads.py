import asyncio
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routers import downloads
from services import download_service
from services.download_service import DownloadFileSpec, DownloadJob


def test_start_download_route_runs_inside_event_loop(monkeypatch, tmp_path):
    spec = DownloadFileSpec(
        url="https://example.com/sam2.1_hiera_small.pt",
        dest_path=str(tmp_path / "sam2.1_hiera_small.pt"),
        filename="sam2.1_hiera_small.pt",
    )

    monkeypatch.setattr(download_service, "_active_jobs", {})
    monkeypatch.setattr(download_service, "_active_destinations", {})
    monkeypatch.setattr(download_service, "_job_destinations", {})
    monkeypatch.setattr("routers.downloads.get_sam2_download_specs", lambda _model_key: [spec])
    monkeypatch.setattr(
        "routers.downloads.get_available_sam2_models",
        lambda: [{"key": "sam2.1_hiera_small", "label": "SAM2.1 Small"}],
    )

    def fake_start_download(
        label: str,
        files: list[DownloadFileSpec],
        auth_token: str | None = None,
    ) -> DownloadJob:
        asyncio.get_running_loop()
        return DownloadJob(job_id="job-1", label=label, files=files, auth_token=auth_token)

    monkeypatch.setattr("routers.downloads.download_service.start_download", fake_start_download)

    response = asyncio.run(
        downloads.start_download(
            downloads.StartDownloadRequest(
                modelType="sam2",
                modelKey="sam2.1_hiera_small",
            )
        )
    )

    assert response == {
        "jobId": "job-1",
        "label": "SAM2.1 Small",
        "status": "pending",
    }


def test_start_download_reuses_active_job_for_same_destinations(monkeypatch, tmp_path):
    monkeypatch.setattr(download_service, "_active_jobs", {})
    monkeypatch.setattr(download_service, "_active_destinations", {})
    monkeypatch.setattr(download_service, "_job_destinations", {})

    spec = DownloadFileSpec(
        url="https://example.com/sam2.1_hiera_small.pt",
        dest_path=str(tmp_path / "sam2.1_hiera_small.pt"),
        filename="sam2.1_hiera_small.pt",
    )

    class _FakeLoop:
        def create_task(self, coro):
            coro.close()
            return object()

    monkeypatch.setattr(download_service.asyncio, "get_running_loop", lambda: _FakeLoop())

    first_job = download_service.start_download("SAM2.1 Small", [spec])
    duplicate_job = download_service.start_download("SAM2.1 Small", [spec])

    assert duplicate_job is first_job
    assert duplicate_job.job_id == first_job.job_id


def test_list_available_models_includes_workflow_models(monkeypatch):
    monkeypatch.setattr(
        "routers.downloads.get_available_sam2_models",
        lambda: [{"key": "sam2.1_hiera_small", "label": "SAM2.1 Small"}],
    )
    monkeypatch.setattr(
        "routers.downloads.is_comfyui_model_downloads_enabled",
        lambda: True,
    )
    monkeypatch.setattr(
        "routers.downloads.get_available_workflow_models",
        lambda workflow_id: [
            {
                "key": "checkpoints:model.safetensors",
                "label": "model.safetensors",
                "description": "Save to ComfyUI/models/checkpoints",
                "installed": False,
                "directory": "checkpoints",
                "filename": "model.safetensors",
                "gated": False,
                "gatedRepoUrl": None,
            }
        ]
        if workflow_id == "wf.json"
        else [],
    )

    response = downloads.list_available_models("wf.json")

    assert response == {
        "sam2": [{"key": "sam2.1_hiera_small", "label": "SAM2.1 Small"}],
        "comfyui": {
            "modelDownloadsEnabled": True,
            "workflowModels": [
                {
                    "key": "checkpoints:model.safetensors",
                    "label": "model.safetensors",
                    "description": "Save to ComfyUI/models/checkpoints",
                    "installed": False,
                    "directory": "checkpoints",
                    "filename": "model.safetensors",
                    "gated": False,
                    "gatedRepoUrl": None,
                }
            ],
        },
    }


def test_start_download_route_supports_workflow_models(monkeypatch, tmp_path):
    spec = DownloadFileSpec(
        url="https://example.com/model.safetensors",
        dest_path=str(tmp_path / "ComfyUI" / "models" / "checkpoints" / "model.safetensors"),
        filename="model.safetensors",
    )

    monkeypatch.setattr(download_service, "_active_jobs", {})
    monkeypatch.setattr(download_service, "_active_destinations", {})
    monkeypatch.setattr(download_service, "_job_destinations", {})
    monkeypatch.setattr(
        "routers.downloads.get_workflow_download_specs",
        lambda workflow_id, model_key: [spec]
        if workflow_id == "wf.json" and model_key == "checkpoints:model.safetensors"
        else [],
    )
    monkeypatch.setattr(
        "routers.downloads.get_available_workflow_models",
        lambda workflow_id: [
            {"key": "checkpoints:model.safetensors", "label": "model.safetensors"}
        ]
        if workflow_id == "wf.json"
        else [],
    )
    monkeypatch.setattr(
        "routers.downloads.is_workflow_model_gated",
        lambda workflow_id, model_key: False,
    )

    def fake_start_download(
        label: str,
        files: list[DownloadFileSpec],
        auth_token: str | None = None,
    ) -> DownloadJob:
        asyncio.get_running_loop()
        return DownloadJob(job_id="job-2", label=label, files=files, auth_token=auth_token)

    monkeypatch.setattr("routers.downloads.download_service.start_download", fake_start_download)

    response = asyncio.run(
        downloads.start_download(
            downloads.StartDownloadRequest(
                modelType="comfyui-workflow",
                modelKey="checkpoints:model.safetensors",
                workflowId="wf.json",
            )
        )
    )

    assert response == {
        "jobId": "job-2",
        "label": "model.safetensors",
        "status": "pending",
    }


def test_start_gated_workflow_download_requires_hf_token(monkeypatch, tmp_path):
    spec = DownloadFileSpec(
        url="https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9b-fp8/resolve/main/flux.safetensors",
        dest_path=str(tmp_path / "ComfyUI" / "models" / "diffusion_models" / "flux.safetensors"),
        filename="flux.safetensors",
    )

    monkeypatch.setattr(download_service, "_active_jobs", {})
    monkeypatch.setattr(download_service, "_active_destinations", {})
    monkeypatch.setattr(download_service, "_job_destinations", {})
    monkeypatch.setattr(
        "routers.downloads.get_workflow_download_specs",
        lambda workflow_id, model_key: [spec],
    )
    monkeypatch.setattr(
        "routers.downloads.get_available_workflow_models",
        lambda workflow_id: [
            {"key": "diffusion_models:flux.safetensors", "label": "flux.safetensors"}
        ],
    )
    monkeypatch.setattr(
        "routers.downloads.is_workflow_model_gated",
        lambda workflow_id, model_key: True,
    )

    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            downloads.start_download(
                downloads.StartDownloadRequest(
                    modelType="comfyui-workflow",
                    modelKey="diffusion_models:flux.safetensors",
                    workflowId="wf.json",
                )
            )
        )

    assert exc_info.value.status_code == 400
    assert "gated" in exc_info.value.detail.lower()


def test_start_gated_workflow_download_forwards_token(monkeypatch, tmp_path):
    spec = DownloadFileSpec(
        url="https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9b-fp8/resolve/main/flux.safetensors",
        dest_path=str(tmp_path / "ComfyUI" / "models" / "diffusion_models" / "flux.safetensors"),
        filename="flux.safetensors",
    )

    monkeypatch.setattr(download_service, "_active_jobs", {})
    monkeypatch.setattr(download_service, "_active_destinations", {})
    monkeypatch.setattr(download_service, "_job_destinations", {})
    monkeypatch.setattr(
        "routers.downloads.get_workflow_download_specs",
        lambda workflow_id, model_key: [spec],
    )
    monkeypatch.setattr(
        "routers.downloads.get_available_workflow_models",
        lambda workflow_id: [
            {"key": "diffusion_models:flux.safetensors", "label": "flux.safetensors"}
        ],
    )
    monkeypatch.setattr(
        "routers.downloads.is_workflow_model_gated",
        lambda workflow_id, model_key: True,
    )

    received_tokens: list[str | None] = []

    def fake_start_download(
        label: str,
        files: list[DownloadFileSpec],
        auth_token: str | None = None,
    ) -> DownloadJob:
        asyncio.get_running_loop()
        received_tokens.append(auth_token)
        return DownloadJob(job_id="job-3", label=label, files=files, auth_token=auth_token)

    monkeypatch.setattr("routers.downloads.download_service.start_download", fake_start_download)

    response = asyncio.run(
        downloads.start_download(
            downloads.StartDownloadRequest(
                modelType="comfyui-workflow",
                modelKey="diffusion_models:flux.safetensors",
                workflowId="wf.json",
                hfToken="hf_secret123",
            )
        )
    )

    assert response["jobId"] == "job-3"
    assert received_tokens == ["hf_secret123"]
