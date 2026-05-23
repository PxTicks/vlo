"""Download API endpoints.

Provides endpoints for listing available models, starting downloads,
streaming progress via SSE, and cancelling downloads.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from pathlib import Path

from services import download_service
from services.model_registry import (
    get_available_sam2_models,
    get_available_workflow_models,
    get_sam2_download_specs,
    get_workflow_download_specs,
    is_comfyui_model_downloads_enabled,
    is_workflow_model_gated,
)

router = APIRouter(prefix="/downloads", tags=["downloads"])


class StartDownloadRequest(BaseModel):
    modelType: str
    modelKey: str
    workflowId: str | None = None
    hfToken: str | None = None


class StartBatchRequest(BaseModel):
    modelType: str
    modelKeys: list[str]
    workflowId: str | None = None
    hfToken: str | None = None


def _resolve_download_request(
    model_type: str,
    model_key: str,
    workflow_id: str | None,
    hf_token: str | None,
) -> tuple[str, list, str | None]:
    """Return (label, specs, auth_token) or raise HTTPException."""
    if model_type == "sam2":
        try:
            specs = get_sam2_download_specs(model_key)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        label = model_key
        for model in get_available_sam2_models():
            if model["key"] == model_key:
                label = model["label"]
                break
        return label, specs, None

    if model_type == "comfyui-workflow":
        if not workflow_id:
            raise HTTPException(
                status_code=400,
                detail="workflowId is required for ComfyUI workflow downloads",
            )

        try:
            specs = get_workflow_download_specs(workflow_id, model_key)
            workflow_models = get_available_workflow_models(workflow_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        label = model_key
        for model in workflow_models:
            if model["key"] == model_key:
                label = model["label"]
                break

        auth_token: str | None = None
        if is_workflow_model_gated(workflow_id, model_key):
            token = (hf_token or "").strip()
            if not token:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "This model is gated on HuggingFace. Accept the "
                        "license on the model's repository and provide a "
                        "HuggingFace access token to download it."
                    ),
                )
            auth_token = token
        return label, specs, auth_token

    raise HTTPException(status_code=400, detail=f"Unknown model type: {model_type}")


@router.get("/models")
def list_available_models(workflowId: str | None = None):
    workflow_models: list[dict] = []
    if workflowId and is_comfyui_model_downloads_enabled():
        try:
            workflow_models = get_available_workflow_models(workflowId)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    sam2_models = get_available_sam2_models()

    # Map each model to its destination paths, then look up any active jobs.
    sam2_paths: dict[str, list[str]] = {}
    for model in sam2_models:
        try:
            specs = get_sam2_download_specs(model["key"])
        except ValueError:
            continue
        sam2_paths[model["key"]] = [str(Path(s.dest_path).resolve()) for s in specs]

    workflow_paths: dict[str, list[str]] = {}
    if workflowId:
        for model in workflow_models:
            try:
                specs = get_workflow_download_specs(workflowId, model["key"])
            except ValueError:
                continue
            workflow_paths[model["key"]] = [str(Path(s.dest_path).resolve()) for s in specs]

    all_paths: set[str] = set()
    for paths in sam2_paths.values():
        all_paths.update(paths)
    for paths in workflow_paths.values():
        all_paths.update(paths)

    active_jobs_by_path = download_service.find_active_jobs_for_paths(all_paths)

    for model in sam2_models:
        for path in sam2_paths.get(model["key"], []):
            job_id = active_jobs_by_path.get(path)
            if job_id is not None:
                model["activeJobId"] = job_id
                break

    for model in workflow_models:
        for path in workflow_paths.get(model["key"], []):
            job_id = active_jobs_by_path.get(path)
            if job_id is not None:
                model["activeJobId"] = job_id
                break

    return {
        "sam2": sam2_models,
        "comfyui": {
            "modelDownloadsEnabled": is_comfyui_model_downloads_enabled(),
            "workflowModels": workflow_models,
        },
    }


@router.post("/start")
async def start_download(request: StartDownloadRequest):
    label, specs, auth_token = _resolve_download_request(
        request.modelType, request.modelKey, request.workflowId, request.hfToken
    )

    try:
        job = download_service.start_download(
            label=label,
            files=specs,
            auth_token=auth_token,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    return {"jobId": job.job_id, "label": job.label, "status": job.status}


@router.post("/start-batch")
async def start_batch_download(request: StartBatchRequest):
    """Queue several model downloads server-side. The worker runs them
    one at a time, so the queue survives client navigation and tab
    throttling. Per-key errors (gating, conflicts) are returned alongside
    the started jobs rather than aborting the whole batch."""
    jobs: list[dict] = []
    errors: list[dict] = []

    for model_key in request.modelKeys:
        try:
            label, specs, auth_token = _resolve_download_request(
                request.modelType, model_key, request.workflowId, request.hfToken
            )
        except HTTPException as exc:
            errors.append({"modelKey": model_key, "message": str(exc.detail)})
            continue

        try:
            job = download_service.start_download(
                label=label,
                files=specs,
                auth_token=auth_token,
            )
        except ValueError as exc:
            errors.append({"modelKey": model_key, "message": str(exc)})
            continue

        jobs.append({
            "modelKey": model_key,
            "jobId": job.job_id,
            "label": job.label,
            "status": job.status,
        })

    return {"jobs": jobs, "errors": errors}


@router.get("/{job_id}/progress")
async def stream_progress(job_id: str):
    job = download_service.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Download job not found")

    async def event_stream():
        last_snapshot: str | None = None
        while True:
            snapshot = json.dumps(job.to_dict())
            if snapshot != last_snapshot:
                last_snapshot = snapshot
                yield f"event: {job.status}\ndata: {snapshot}\n\n"

            if job.status in ("complete", "failed", "cancelled"):
                return

            progress_event = job.progress_event
            if progress_event is not None:
                progress_event.clear()
                try:
                    await asyncio.wait_for(progress_event.wait(), timeout=0.5)
                except asyncio.TimeoutError:
                    pass
            else:
                await asyncio.sleep(0.25)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{job_id}/cancel")
def cancel_download(job_id: str):
    if not download_service.cancel_job(job_id):
        raise HTTPException(status_code=404, detail="Download job not found")
    return {"cancelled": True}
