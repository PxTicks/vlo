"""Local services behind the model-work lease (plan §5).

Their HTTP contracts are unchanged: ``/beats/detect`` and ``/sam2/masks/generate``
still return their payloads inline. What changes is that the wait and the
inference both live in the synchronous worker wrapper, so the lease cannot be
abandoned by request cancellation, and a saturated GPU answers 429 instead of
piling a second model onto the card.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi import HTTPException

from routers import beats as beats_router
from routers import sam2 as sam2_router
from services.beats import beats_service
from services.model_work import (
    LOCAL_GPU_RESOURCE,
    TENANT_BACKEND,
    TENANT_COMFYUI,
    LeaseTimeoutError,
)
from services.model_work import local_inference
from services.model_work.local_inference import holds_local_gpu, run_local_inference
from services.sam2 import sam2_service
from services.sam2.sam2_service import Sam2SourceMetadata


def _source(tmp_path: Path) -> Sam2SourceMetadata:
    source_path = tmp_path / "source.mp4"
    source_path.write_bytes(b"video")
    return Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=source_path,
        width=2,
        height=2,
        fps=24.0,
        frame_count=4,
        duration_sec=4 / 24.0,
    )


def _hold_comfyui(coordinator) -> Any:
    lease = coordinator.try_reserve_sync(
        resource=LOCAL_GPU_RESOURCE,
        tenant=TENANT_COMFYUI,
        source="comfyui-vlo",
        label="flux render",
        owner="vlo.comfyui",
        sharing="tenant",
    )
    assert lease is not None
    return lease


def test_sam2_predictor_exclusion(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    model_work_coordinator,
) -> None:
    """The two SAM2 panel buttons can no longer drive the predictor at once."""

    source = _source(tmp_path)
    monkeypatch.setattr(sam2_service, "get_source_metadata", lambda _source_id: source)
    monkeypatch.setattr(
        sam2_service,
        "encode_binary_masks_to_red_mp4",
        lambda _frames, _fps: b"mp4",
    )

    inside_propagation = threading.Event()
    finish_propagation = threading.Event()

    def _slow_propagation(*_args: Any, **_kwargs: Any) -> np.ndarray:
        inside_propagation.set()
        finish_propagation.wait(5)
        return np.zeros((source.frame_count, source.height, source.width), dtype=np.uint8)

    monkeypatch.setattr(sam2_service, "_run_sam2_propagation", _slow_propagation)

    def _generate_video() -> None:
        sam2_service.generate_mask_video(
            source_id="source_1",
            points=[{"x": 0.5, "y": 0.5, "label": 1, "timeTicks": 0}],
            ticks_per_second=96_000,
            mask_id="mask_1",
        )

    worker = threading.Thread(target=_generate_video)
    worker.start()
    try:
        assert inside_propagation.wait(5)

        # Frame preview is a foreground click, so it fails fast rather than
        # spinning behind a multi-minute batch lease.
        with pytest.raises(LeaseTimeoutError):
            sam2_service.generate_single_frame_mask(
                source_id="source_1",
                points=[{"x": 0.5, "y": 0.5, "label": 1, "timeTicks": 0}],
                ticks_per_second=96_000,
                time_ticks=0,
                mask_id="mask_1",
            )
    finally:
        finish_propagation.set()
        worker.join(5)

    # ...and once the batch lease is gone, the same click is admitted.
    assert model_work_coordinator.try_reserve_sync(
        resource=LOCAL_GPU_RESOURCE,
        tenant=TENANT_BACKEND,
        source="sam2",
        label="frame preview",
        owner="vlo.sam2",
    ) is not None


def test_sam2_mask_video_waits_for_comfyui_then_reports_429(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    model_work_coordinator,
) -> None:
    source = _source(tmp_path)
    monkeypatch.setattr(sam2_service, "get_source_metadata", lambda _source_id: source)
    monkeypatch.setattr(local_inference, "LOCAL_INFERENCE_WAIT_SECONDS", 0.05)
    blocker = _hold_comfyui(model_work_coordinator)

    with pytest.raises(LeaseTimeoutError):
        sam2_service.generate_mask_video(
            source_id="source_1",
            points=[{"x": 0.5, "y": 0.5, "label": 1, "timeTicks": 0}],
            ticks_per_second=96_000,
            mask_id="mask_1",
        )

    blocker.release()


@pytest.mark.anyio
async def test_sam2_router_translates_a_busy_gpu_to_429(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _busy(*_args: Any, **_kwargs: Any) -> None:
        raise LeaseTimeoutError("The GPU is busy", occupied_by="comfyui-process")

    monkeypatch.setattr(sam2_service, "generate_single_frame_mask", _busy)

    with pytest.raises(HTTPException) as excinfo:
        await sam2_router.generate_sam2_mask_frame(
            sam2_router.Sam2GenerateFrameRequest(
                sourceId="source_1",
                points=[
                    sam2_router.Sam2PointRequest(x=0.5, y=0.5, label=1, timeTicks=0)
                ],
                ticksPerSecond=96_000,
                timeTicks=0,
                maskId="mask_1",
            )
        )

    assert excinfo.value.status_code == 429
    assert (excinfo.value.headers or {}).get("Retry-After")


@pytest.mark.anyio
async def test_beats_router_translates_a_busy_gpu_to_429(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _busy(*_args: Any, **_kwargs: Any) -> None:
        raise LeaseTimeoutError("The GPU is busy", occupied_by="comfyui-process")

    monkeypatch.setattr(beats_service, "detect_beats", _busy)

    with pytest.raises(HTTPException) as excinfo:
        await beats_router.detect_beats(
            beats_router.BeatThisDetectRequest(sourceId="source_1", ticksPerSecond=96_000)
        )

    assert excinfo.value.status_code == 429


def test_beats_detection_holds_the_gpu_for_its_whole_opaque_call(
    monkeypatch: pytest.MonkeyPatch,
    model_work_coordinator,
) -> None:
    """Beat This! has no cooperative checkpoints, so `stopping` covers it."""

    observed: list[bool] = []

    class _Source:
        source_id = "source_1"
        path = Path("audio.wav")

    monkeypatch.setattr(beats_service, "get_source_metadata", lambda _id: _Source())
    monkeypatch.setattr(
        beats_service._runtime,
        "get_predictor",
        lambda checkpoint, dbn: object(),
    )

    def _detect(_predictor: object, _path: Path) -> tuple[list[float], list[float]]:
        observed.append(
            model_work_coordinator.try_reserve_sync(
                resource=LOCAL_GPU_RESOURCE,
                tenant=TENANT_COMFYUI,
                source="comfyui-vlo",
                label="flux render",
                owner="vlo.comfyui",
                sharing="tenant",
            )
            is None
        )
        return [1.0], [1.0]

    monkeypatch.setattr(beats_service, "_detect_beats_with_predictor", _detect)

    result = beats_service.detect_beats("source_1", 96_000)

    assert observed == [True]
    assert result["beatCount"] == 1


def test_nested_local_inference_passes_through_instead_of_deadlocking() -> None:
    """SAM-Audio reads cached SAM2 frames from inside its own lease."""

    depth: list[bool] = []

    def _inner() -> str:
        depth.append(holds_local_gpu())
        return "inner"

    def _outer() -> str:
        depth.append(holds_local_gpu())
        return run_local_inference(
            _inner,
            source="sam2",
            label="SAM2 session",
            owner="vlo.sam2",
            timeout=0.05,
        )

    started = time.monotonic()
    result = run_local_inference(
        _outer,
        source="sam-audio",
        label="Audio separation",
        owner="vlo.sam-audio",
    )

    assert result == "inner"
    assert depth == [True, True]
    assert time.monotonic() - started < 1  # No bounded wait was ever entered.
