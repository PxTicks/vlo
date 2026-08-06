from __future__ import annotations

import pytest
from fastapi import HTTPException

from routers import sam_audio as sam_audio_router
from services.jobs import BackendJobCapacityError


@pytest.mark.anyio
async def test_submit_maps_job_capacity_to_retryable_http_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def raise_capacity(*args, **kwargs):
        del args, kwargs
        raise BackendJobCapacityError("SAM-Audio is at capacity")

    monkeypatch.setattr(
        sam_audio_router.sam_audio_service,
        "submit_separation_job",
        raise_capacity,
    )
    monkeypatch.setattr(
        sam_audio_router.sam_audio_service,
        "get_source_metadata",
        lambda source_id: object(),
    )

    async def run_inline(function, *args):
        return function(*args)

    monkeypatch.setattr(sam_audio_router, "run_in_threadpool", run_inline)
    request = sam_audio_router.SamAudioJobRequest(
        sourceId="source",
        startTicks=0,
        durationTicks=20,
    )

    with pytest.raises(HTTPException) as raised:
        await sam_audio_router.submit_sam_audio_job(request)

    assert raised.value.status_code == 429
    assert raised.value.headers == {"Retry-After": "1"}
    assert raised.value.detail == "SAM-Audio is at capacity"
