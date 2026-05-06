from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from services.beats import beats_service
from services.beats.beats_service import (
    BeatThisConfigError,
    BeatThisRuntimeError,
    BeatThisSourceNotFoundError,
)


router = APIRouter(prefix="/beats", tags=["beats"])


class BeatThisDetectRequest(BaseModel):
    sourceId: str = Field(min_length=1)
    ticksPerSecond: float = Field(gt=0)
    dbn: bool = False
    model: str | None = None


@router.get("/health")
async def beats_health() -> dict[str, Any]:
    return beats_service.get_health()


@router.post("/sources")
async def register_beats_source(
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
            beats_service.register_source_bytes,
            source_hash,
            audio.filename or "audio.wav",
            data,
        )
        return metadata.to_response()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except BeatThisRuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/detect")
async def detect_beats(request: BeatThisDetectRequest) -> dict[str, Any]:
    try:
        return await run_in_threadpool(
            beats_service.detect_beats,
            request.sourceId,
            request.ticksPerSecond,
            request.dbn,
            request.model,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except BeatThisSourceNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except BeatThisConfigError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except BeatThisRuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
