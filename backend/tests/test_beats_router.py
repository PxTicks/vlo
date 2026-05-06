import os
import sys

import anyio
import pytest
from fastapi import HTTPException

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routers import beats as beats_router  # noqa: E402
from routers.beats import BeatThisDetectRequest  # noqa: E402
from services.beats import beats_service  # noqa: E402
from services.beats.beats_service import (  # noqa: E402
    BeatThisConfigError,
    BeatThisRuntimeError,
    BeatThisSourceNotFoundError,
)


def _direct_threadpool():
    async def runner(func, *args, **kwargs):
        return func(*args, **kwargs)

    return runner


def test_detect_endpoint_returns_404_for_missing_source(monkeypatch):
    monkeypatch.setattr(beats_router, "run_in_threadpool", _direct_threadpool())

    def _fake_detect(*_args, **_kwargs):
        raise BeatThisSourceNotFoundError("missing source")

    monkeypatch.setattr(beats_service, "detect_beats", _fake_detect)

    request = BeatThisDetectRequest(sourceId="missing", ticksPerSecond=96_000)
    with pytest.raises(HTTPException) as exc_info:
        anyio.run(beats_router.detect_beats, request)
    assert exc_info.value.status_code == 404
    assert "missing source" in str(exc_info.value.detail)


def test_detect_endpoint_returns_500_for_config_errors(monkeypatch):
    monkeypatch.setattr(beats_router, "run_in_threadpool", _direct_threadpool())

    def _fake_detect(*_args, **_kwargs):
        raise BeatThisConfigError("madmom not installed")

    monkeypatch.setattr(beats_service, "detect_beats", _fake_detect)

    request = BeatThisDetectRequest(
        sourceId="anything",
        ticksPerSecond=96_000,
        dbn=True,
    )
    with pytest.raises(HTTPException) as exc_info:
        anyio.run(beats_router.detect_beats, request)
    assert exc_info.value.status_code == 500
    assert "madmom" in str(exc_info.value.detail)


def test_detect_endpoint_returns_500_for_runtime_errors(monkeypatch):
    monkeypatch.setattr(beats_router, "run_in_threadpool", _direct_threadpool())

    def _fake_detect(*_args, **_kwargs):
        raise BeatThisRuntimeError("decode failed")

    monkeypatch.setattr(beats_service, "detect_beats", _fake_detect)

    request = BeatThisDetectRequest(sourceId="anything", ticksPerSecond=96_000)
    with pytest.raises(HTTPException) as exc_info:
        anyio.run(beats_router.detect_beats, request)
    assert exc_info.value.status_code == 500
    assert "decode failed" in str(exc_info.value.detail)


def test_detect_endpoint_returns_400_for_validation_errors(monkeypatch):
    monkeypatch.setattr(beats_router, "run_in_threadpool", _direct_threadpool())

    def _fake_detect(*_args, **_kwargs):
        raise ValueError("ticks_per_second must be > 0, got 0")

    monkeypatch.setattr(beats_service, "detect_beats", _fake_detect)

    # Pydantic enforces ticksPerSecond > 0, so we trigger a service-level
    # ValueError to assert the router maps it to a 400.
    request = BeatThisDetectRequest(sourceId="anything", ticksPerSecond=1)
    with pytest.raises(HTTPException) as exc_info:
        anyio.run(beats_router.detect_beats, request)
    assert exc_info.value.status_code == 400


def test_detect_endpoint_passes_through_response(monkeypatch):
    monkeypatch.setattr(beats_router, "run_in_threadpool", _direct_threadpool())

    captured: dict[str, object] = {}

    def _fake_detect(source_id, ticks_per_second, dbn, model):
        captured.update(
            {
                "source_id": source_id,
                "ticks_per_second": ticks_per_second,
                "dbn": dbn,
                "model": model,
            }
        )
        return {
            "sourceId": source_id,
            "modelName": model or "final0",
            "dbn": dbn,
            "beats": [{"timeSeconds": 1.0, "timeTicks": 96_000.0, "isDownbeat": True}],
            "beatCount": 1,
            "downbeatCount": 1,
        }

    monkeypatch.setattr(beats_service, "detect_beats", _fake_detect)

    request = BeatThisDetectRequest(
        sourceId="abc",
        ticksPerSecond=96_000,
        dbn=False,
        model="custom-model",
    )
    response = anyio.run(beats_router.detect_beats, request)

    assert captured == {
        "source_id": "abc",
        "ticks_per_second": 96_000,
        "dbn": False,
        "model": "custom-model",
    }
    assert response["beats"][0]["timeTicks"] == 96_000.0
    assert response["beats"][0]["isDownbeat"] is True
