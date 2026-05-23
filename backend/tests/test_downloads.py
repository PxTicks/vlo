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
        "status": "queued",
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
        "status": "queued",
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


def test_find_active_jobs_for_paths_returns_only_in_flight_jobs(monkeypatch, tmp_path):
    monkeypatch.setattr(download_service, "_active_jobs", {})
    monkeypatch.setattr(download_service, "_active_destinations", {})
    monkeypatch.setattr(download_service, "_job_destinations", {})

    in_flight_path = tmp_path / "in_flight.bin"
    completed_path = tmp_path / "done.bin"
    untracked_path = tmp_path / "untracked.bin"

    in_flight = DownloadJob(
        job_id="job-in-flight",
        label="in-flight",
        files=[DownloadFileSpec(url="http://x", dest_path=str(in_flight_path), filename="in_flight.bin")],
        status="downloading",
    )
    completed = DownloadJob(
        job_id="job-done",
        label="done",
        files=[DownloadFileSpec(url="http://x", dest_path=str(completed_path), filename="done.bin")],
        status="complete",
    )
    download_service._active_jobs[in_flight.job_id] = in_flight
    download_service._active_jobs[completed.job_id] = completed
    download_service._active_destinations[str(in_flight_path.resolve())] = in_flight.job_id
    download_service._active_destinations[str(completed_path.resolve())] = completed.job_id

    result = download_service.find_active_jobs_for_paths(
        {str(in_flight_path), str(completed_path), str(untracked_path)}
    )

    assert result == {str(in_flight_path.resolve()): "job-in-flight"}


def test_list_available_models_includes_active_job_for_in_flight_destination(monkeypatch, tmp_path):
    sam2_dest = tmp_path / "sam2.1_hiera_small.pt"

    monkeypatch.setattr(
        "routers.downloads.get_available_sam2_models",
        lambda: [{"key": "sam2.1_hiera_small", "label": "SAM2.1 Small"}],
    )
    monkeypatch.setattr(
        "routers.downloads.get_sam2_download_specs",
        lambda _model_key: [
            DownloadFileSpec(
                url="https://example.com/sam2.1_hiera_small.pt",
                dest_path=str(sam2_dest),
                filename="sam2.1_hiera_small.pt",
            )
        ],
    )
    monkeypatch.setattr(
        "routers.downloads.is_comfyui_model_downloads_enabled",
        lambda: False,
    )
    monkeypatch.setattr(
        download_service,
        "find_active_jobs_for_paths",
        lambda paths: {str(sam2_dest.resolve()): "job-active"},
    )

    response = downloads.list_available_models(None)

    assert response["sam2"] == [
        {
            "key": "sam2.1_hiera_small",
            "label": "SAM2.1 Small",
            "activeJobId": "job-active",
        }
    ]


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


def test_start_batch_enqueues_per_key_and_surfaces_errors(monkeypatch, tmp_path):
    monkeypatch.setattr(download_service, "_active_jobs", {})
    monkeypatch.setattr(download_service, "_active_destinations", {})
    monkeypatch.setattr(download_service, "_job_destinations", {})
    monkeypatch.setattr(download_service, "_pending_job_ids", [])

    monkeypatch.setattr(
        "routers.downloads.is_workflow_model_gated",
        lambda workflow_id, model_key: model_key.startswith("gated:"),
    )

    def fake_specs(workflow_id, model_key):
        return [
            DownloadFileSpec(
                url=f"https://example.com/{model_key}",
                dest_path=str(tmp_path / model_key.replace(":", "_")),
                filename=model_key.replace(":", "_"),
            )
        ]

    monkeypatch.setattr("routers.downloads.get_workflow_download_specs", fake_specs)
    monkeypatch.setattr(
        "routers.downloads.get_available_workflow_models",
        lambda workflow_id: [
            {"key": "checkpoints:a.safetensors", "label": "a"},
            {"key": "checkpoints:b.safetensors", "label": "b"},
            {"key": "gated:c.safetensors", "label": "c"},
        ],
    )

    counter = {"n": 0}

    def fake_start_download(label, files, auth_token=None):
        asyncio.get_running_loop()
        counter["n"] += 1
        return DownloadJob(
            job_id=f"job-{counter['n']}",
            label=label,
            files=files,
            auth_token=auth_token,
            status="queued",
        )

    monkeypatch.setattr(
        "routers.downloads.download_service.start_download", fake_start_download
    )

    response = asyncio.run(
        downloads.start_batch_download(
            downloads.StartBatchRequest(
                modelType="comfyui-workflow",
                modelKeys=[
                    "checkpoints:a.safetensors",
                    "checkpoints:b.safetensors",
                    "gated:c.safetensors",  # missing hfToken — should error, not raise
                ],
                workflowId="wf.json",
                hfToken=None,
            )
        )
    )

    assert [job["modelKey"] for job in response["jobs"]] == [
        "checkpoints:a.safetensors",
        "checkpoints:b.safetensors",
    ]
    assert all(job["status"] == "queued" for job in response["jobs"])
    assert response["errors"] == [
        {
            "modelKey": "gated:c.safetensors",
            "message": (
                "This model is gated on HuggingFace. Accept the license on the "
                "model's repository and provide a HuggingFace access token to "
                "download it."
            ),
        }
    ]


def test_queue_runs_one_job_at_a_time_in_fifo_order(monkeypatch, tmp_path):
    """The worker should release the in-flight slot before the next job's
    semaphore acquire returns. Two jobs started back-to-back should run
    strictly serially."""
    monkeypatch.setattr(download_service, "_active_jobs", {})
    monkeypatch.setattr(download_service, "_active_destinations", {})
    monkeypatch.setattr(download_service, "_job_destinations", {})
    monkeypatch.setattr(download_service, "_pending_job_ids", [])
    monkeypatch.setattr(download_service, "_download_semaphore", None)

    started_order: list[str] = []
    completed_order: list[str] = []

    gate_a = asyncio.Event()
    gate_b = asyncio.Event()

    async def fake_execute(job):
        started_order.append(job.label)
        if job.label == "a":
            await gate_a.wait()
        else:
            await gate_b.wait()
        job.status = "complete"
        completed_order.append(job.label)

    monkeypatch.setattr(download_service, "_execute_download_job", fake_execute)

    async def scenario():
        spec_a = DownloadFileSpec(url="x", dest_path=str(tmp_path / "a"), filename="a")
        spec_b = DownloadFileSpec(url="x", dest_path=str(tmp_path / "b"), filename="b")
        job_a = download_service.start_download("a", [spec_a])
        job_b = download_service.start_download("b", [spec_b])
        await asyncio.sleep(0.05)
        assert started_order == ["a"], "second job ran before first finished"
        assert job_b.status == "queued"
        # queue_position is recomputed after each pending removal; b should be
        # ahead of an empty queue once a starts.
        gate_a.set()
        await asyncio.sleep(0.05)
        assert started_order == ["a", "b"]
        assert completed_order == ["a"]
        gate_b.set()
        await asyncio.sleep(0.05)
        assert completed_order == ["a", "b"]
        assert job_a.status == "complete"
        assert job_b.status == "complete"

    asyncio.run(scenario())
