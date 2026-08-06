from __future__ import annotations

import json
from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel, Field

from services.jobs import BackendJobCapacityError
from services.sam_audio import sam_audio_service
from services.sam_audio.sam_audio_discovery import discover_sam_audio_models
from services.sam_audio.sam_audio_service import (
    SamAudioConfigError,
    SamAudioJobNotFoundError,
    SamAudioJobNotReadyError,
    SamAudioRuntimeError,
    SamAudioSourceNotFoundError,
)
from services.sam2.sam2_service import Sam2RuntimeError, Sam2SourceNotFoundError


router = APIRouter(prefix="/sam-audio", tags=["sam-audio"])


class SamAudioPromptRequest(BaseModel):
    text: str | None = None
    anchors: list[list[tuple[Literal["+", "-"], float, float]]] | None = None
    sam2SourceId: str | None = None
    sam2MaskId: str | None = None
    predictSpans: bool | None = None
    rerankingCandidates: int | None = Field(default=None, ge=1, le=8)


class SamAudioJobRequest(BaseModel):
    sourceId: str = Field(min_length=1)
    startTicks: int = Field(ge=0)
    durationTicks: int = Field(gt=0)
    prompt: SamAudioPromptRequest = Field(default_factory=SamAudioPromptRequest)


@router.get("/health")
async def sam_audio_health() -> dict[str, Any]:
    return sam_audio_service.get_health()


@router.get("/models")
async def get_sam_audio_models() -> dict[str, Any]:
    return {"models": discover_sam_audio_models()}


@router.post("/sources")
async def register_sam_audio_source(
    audio: UploadFile = File(...),
    source_hash: str = Form(...),
) -> dict[str, Any]:
    if not source_hash.strip():
        raise HTTPException(status_code=400, detail="source_hash is required")

    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded audio is empty")

    try:
        metadata = await run_in_threadpool(
            sam_audio_service.register_source_bytes,
            source_hash,
            audio.filename or "source.wav",
            data,
        )
        return metadata.to_response()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except SamAudioRuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/jobs")
async def submit_sam_audio_job(request: SamAudioJobRequest) -> dict[str, str]:
    try:
        source = await run_in_threadpool(
            sam_audio_service.get_source_metadata,
            request.sourceId,
        )
        job = await sam_audio_service.submit_separation_job(
            source,
            request.startTicks,
            request.durationTicks,
            request.prompt.model_dump(exclude_none=True),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except SamAudioSourceNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except BackendJobCapacityError as exc:
        raise HTTPException(
            status_code=429,
            detail=str(exc),
            headers={"Retry-After": "1"},
        ) from exc

    return {"jobId": job.job_id}


@router.get("/jobs/{job_id}")
async def get_sam_audio_job(job_id: str) -> dict[str, Any]:
    try:
        return sam_audio_service.get_job_or_raise(job_id).to_dict()
    except SamAudioJobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/cancel")
async def cancel_sam_audio_job(job_id: str) -> dict[str, Any]:
    try:
        return (await sam_audio_service.cancel_job(job_id)).to_dict()
    except SamAudioJobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/jobs/{job_id}/stems/{stem}")
async def get_sam_audio_stem(
    job_id: str,
    stem: Literal["target", "residual"],
) -> Response:
    try:
        data, result = await run_in_threadpool(
            sam_audio_service.get_job_stem,
            job_id,
            stem,
        )
    except SamAudioJobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SamAudioJobNotReadyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    headers = {
        "X-SamAudio-SampleRate": str(result.sample_rate),
        "X-SamAudio-DurationTicks": str(result.duration_ticks),
    }
    if result.predicted_spans is not None:
        headers["X-SamAudio-Spans"] = json.dumps(result.predicted_spans)

    return Response(
        content=data,
        media_type="audio/wav",
        headers=headers,
    )


def sam_audio_exception_to_http(exc: Exception) -> HTTPException:
    if isinstance(exc, (SamAudioSourceNotFoundError, Sam2SourceNotFoundError)):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=400, detail=str(exc))
    if isinstance(exc, (SamAudioConfigError, SamAudioRuntimeError, Sam2RuntimeError)):
        return HTTPException(status_code=500, detail=str(exc))
    return HTTPException(status_code=500, detail="SAM-Audio request failed")
