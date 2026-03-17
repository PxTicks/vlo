from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel, Field

from services.sam2 import sam2_service
from services.sam2.sam2_service import (
    Sam2ConfigError,
    Sam2Point,
    Sam2RuntimeError,
    Sam2SourceNotFoundError,
)


router = APIRouter(prefix="/sam2", tags=["sam2"])


class Sam2PointRequest(BaseModel):
    x: float
    y: float
    label: int
    timeTicks: float


class Sam2GenerateMaskRequest(BaseModel):
    sourceId: str = Field(min_length=1)
    points: list[Sam2PointRequest]
    ticksPerSecond: float = Field(gt=0)
    maskId: str | None = None
    visibleSourceStartTicks: float | None = Field(default=None, ge=0)
    visibleSourceDurationTicks: float | None = Field(default=None, ge=0)


class Sam2GenerateFrameRequest(BaseModel):
    sourceId: str = Field(min_length=1)
    points: list[Sam2PointRequest]
    ticksPerSecond: float = Field(gt=0)
    timeTicks: float = Field(ge=0)
    maskId: str | None = None


class Sam2EditorSessionRequest(BaseModel):
    sourceId: str = Field(min_length=1)
    maskId: str = Field(min_length=1)
    ticksPerSecond: float | None = Field(default=None, gt=0)
    visibleSourceStartTicks: float | None = Field(default=None, ge=0)
    visibleSourceDurationTicks: float | None = Field(default=None, ge=0)


from services.sam2.sam2_discovery import discover_sam2_models

@router.get("/health")
async def sam2_health() -> dict[str, Any]:
    return sam2_service.get_health()

@router.get("/models")
async def get_sam2_models() -> dict[str, Any]:
    models = discover_sam2_models()
    return {"models": models}


@router.post("/sources")
async def register_sam2_source(
    video: UploadFile = File(...),
    source_hash: str = Form(...),
) -> dict[str, Any]:
    if not source_hash.strip():
        raise HTTPException(status_code=400, detail="source_hash is required")

    data = await video.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded video is empty")

    try:
        metadata = await run_in_threadpool(
            sam2_service.register_source_bytes,
            source_hash,
            video.filename or "source.mp4",
            data,
        )
        return metadata.to_response()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Sam2RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/editor/session/init")
async def init_sam2_editor_session(request: Sam2EditorSessionRequest) -> dict[str, Any]:
    try:
        return await run_in_threadpool(
            sam2_service.init_editor_session,
            request.sourceId,
            request.maskId,
            request.ticksPerSecond,
            request.visibleSourceStartTicks,
            request.visibleSourceDurationTicks,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Sam2SourceNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Sam2ConfigError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Sam2RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/editor/session/clear")
async def clear_sam2_editor_session(request: Sam2EditorSessionRequest) -> dict[str, Any]:
    try:
        return await run_in_threadpool(
            sam2_service.clear_editor_session,
            request.sourceId,
            request.maskId,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/masks/generate")
async def generate_sam2_mask_video(request: Sam2GenerateMaskRequest) -> Response:
    if not request.points:
        raise HTTPException(status_code=400, detail="At least one point is required")

    typed_points: list[Sam2Point] = [
        {
            "x": point.x,
            "y": point.y,
            "label": point.label,
            "timeTicks": point.timeTicks,
        }
        for point in request.points
    ]

    try:
        generated = await run_in_threadpool(
            sam2_service.generate_mask_video,
            request.sourceId,
            typed_points,
            request.ticksPerSecond,
            request.maskId,
            request.visibleSourceStartTicks,
            request.visibleSourceDurationTicks,
        )
    except Sam2SourceNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Sam2ConfigError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Sam2RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    headers = {
        "X-Sam2-Width": str(generated.width),
        "X-Sam2-Height": str(generated.height),
        "X-Sam2-Fps": f"{generated.fps:.6f}",
        "X-Sam2-Frame-Count": str(generated.frame_count),
    }
    return Response(
        content=generated.video_bytes,
        media_type="video/webm",
        headers=headers,
    )


@router.post("/masks/frame")
async def generate_sam2_mask_frame(request: Sam2GenerateFrameRequest) -> Response:
    if not request.points and not request.maskId:
        raise HTTPException(
            status_code=400,
            detail="maskId is required when requesting a frame without points",
        )

    typed_points: list[Sam2Point] = [
        {
            "x": point.x,
            "y": point.y,
            "label": point.label,
            "timeTicks": point.timeTicks,
        }
        for point in request.points
    ]

    try:
        generated = await run_in_threadpool(
            sam2_service.generate_single_frame_mask,
            request.sourceId,
            typed_points,
            request.ticksPerSecond,
            request.timeTicks,
            request.maskId,
        )
    except Sam2SourceNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Sam2ConfigError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Sam2RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    headers = {
        "X-Sam2-Width": str(generated.width),
        "X-Sam2-Height": str(generated.height),
        "X-Sam2-Frame-Index": str(generated.frame_index),
        "X-Sam2-Time-Ticks": f"{generated.time_ticks:.3f}",
    }
    return Response(
        content=generated.png_bytes,
        media_type="image/png",
        headers=headers,
    )
