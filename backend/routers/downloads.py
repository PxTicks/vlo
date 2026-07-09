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

from services import download_service
from services.ai_models.downloads import (
    DownloadContext,
    DownloadProvider,
    DownloadProviderRegistry,
)
from services.model_registry import (
    get_available_sam_audio_models,
    get_available_sam2_models,
    get_available_workflow_models,
    get_sam_audio_download_specs,
    get_sam2_download_specs,
    get_workflow_download_specs,
    is_comfyui_model_downloads_enabled,
    is_sam_audio_model_gated,
    is_workflow_model_gated,
)

router = APIRouter(prefix="/downloads", tags=["downloads"])


class StartDownloadRequest(BaseModel):
    modelType: str
    modelKey: str
    workflowId: str | None = None
    hfToken: str | None = None
    workflowGraph: dict | None = None


class StartBatchRequest(BaseModel):
    modelType: str
    modelKeys: list[str]
    workflowId: str | None = None
    hfToken: str | None = None
    workflowGraph: dict | None = None


class ListModelsRequest(BaseModel):
    workflowId: str | None = None
    workflowGraph: dict | None = None


SAM_AUDIO_GATED_MESSAGE = (
    "This SAM-Audio model is gated on Hugging Face. Accept "
    "the license on the model repository and provide a "
    "Hugging Face access token to download it."
)

WORKFLOW_GATED_MESSAGE = (
    "This model is gated on HuggingFace. Accept the "
    "license on the model's repository and provide a "
    "HuggingFace access token to download it."
)


def _download_provider_registry() -> DownloadProviderRegistry:
    return DownloadProviderRegistry(
        [
            DownloadProvider(
                model_type="sam2",
                response_key="sam2",
                list_models_fn=lambda _context: get_available_sam2_models(),
                download_specs_fn=lambda model_key, _context: get_sam2_download_specs(
                    model_key
                ),
            ),
            DownloadProvider(
                model_type="sam-audio",
                response_key="samAudio",
                list_models_fn=lambda _context: get_available_sam_audio_models(),
                download_specs_fn=lambda model_key, _context: (
                    get_sam_audio_download_specs(model_key)
                ),
                is_gated_fn=lambda model_key, _context: is_sam_audio_model_gated(
                    model_key
                ),
                gated_message=SAM_AUDIO_GATED_MESSAGE,
            ),
            DownloadProvider(
                model_type="comfyui-workflow",
                response_key="workflowModels",
                list_models_fn=lambda context: (
                    get_available_workflow_models(
                        context.workflow_id,
                        context.workflow_graph,
                    )
                    if context.workflow_id or context.workflow_graph
                    else []
                ),
                download_specs_fn=lambda model_key, context: (
                    get_workflow_download_specs(
                        _require_workflow_source(context),
                        model_key,
                        context.workflow_graph,
                    )
                ),
                is_gated_fn=lambda model_key, context: is_workflow_model_gated(
                    _require_workflow_source(context),
                    model_key,
                    context.workflow_graph,
                ),
                gated_message=WORKFLOW_GATED_MESSAGE,
                is_enabled_fn=lambda _context: is_comfyui_model_downloads_enabled(),
            ),
        ]
    )


def _require_workflow_source(context: DownloadContext) -> str | None:
    if not context.workflow_id and not context.workflow_graph:
        raise ValueError(
            "workflowId or workflowGraph is required for ComfyUI workflow downloads"
        )
    return context.workflow_id


def _resolve_download_request(
    model_type: str,
    model_key: str,
    workflow_id: str | None,
    hf_token: str | None,
    workflow_graph: dict | None = None,
) -> tuple[str, list[download_service.DownloadFileSpec], str | None]:
    """Return (label, specs, auth_token) or raise HTTPException."""
    context = DownloadContext(
        workflow_id=workflow_id,
        hf_token=hf_token,
        workflow_graph=workflow_graph,
    )
    try:
        resolved = _download_provider_registry().resolve_download(
            model_type,
            model_key,
            context,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return resolved.label, resolved.files, resolved.auth_token


@router.get("/models")
def list_available_models(workflowId: str | None = None):
    return _list_available_models(DownloadContext(workflow_id=workflowId))


@router.post("/models")
def list_available_models_for_graph(request: ListModelsRequest):
    """POST variant for workflows that live only in the ComfyUI editor: their
    graph has to travel in the body since there is nothing to load by id."""
    return _list_available_models(
        DownloadContext(
            workflow_id=request.workflowId,
            workflow_graph=request.workflowGraph,
        )
    )


def _list_available_models(context: DownloadContext):
    registry = _download_provider_registry()
    try:
        sam2_models = registry.list_models_for("sam2", context)
        sam_audio_models = registry.list_models_for("sam-audio", context)
        workflow_models = registry.list_models_for("comfyui-workflow", context)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    registry.annotate_active_jobs(
        {
            "sam2": sam2_models,
            "sam-audio": sam_audio_models,
            "comfyui-workflow": workflow_models,
        },
        context,
        download_service.find_active_jobs_for_paths,
    )

    return {
        "sam2": sam2_models,
        "samAudio": sam_audio_models,
        "comfyui": {
            "modelDownloadsEnabled": is_comfyui_model_downloads_enabled(),
            "workflowModels": workflow_models,
        },
    }


@router.post("/start")
async def start_download(request: StartDownloadRequest):
    label, specs, auth_token = _resolve_download_request(
        request.modelType,
        request.modelKey,
        request.workflowId,
        request.hfToken,
        request.workflowGraph,
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
                request.modelType,
                model_key,
                request.workflowId,
                request.hfToken,
                request.workflowGraph,
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
