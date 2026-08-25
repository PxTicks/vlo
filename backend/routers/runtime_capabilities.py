"""Runtime-capability reads, explicit load-test jobs, and support export.

The GET capability routes remain cheap and safe to poll. Model loading happens
only after an explicit POST and runs through the shared job and admission
lifecycle.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from services.ai_models.capabilities import (
    capabilities_payload,
    capability_payload,
    list_capability_ids,
)
from services.ai_models.capabilities.load_probes import (
    CapabilityProbeNotFoundError,
    CapabilityProbeNotReadyError,
    get_runtime_capability_probe_jobs,
)
from services.jobs import BackendJobCapacityError, BackendJobNotFoundError


router = APIRouter(prefix="/app", tags=["runtime-capabilities"])


@router.get("/runtime-capabilities")
async def get_runtime_capabilities(refresh: bool = False) -> dict[str, Any]:
    # The probes stat directories and may wait on a subprocess, so they run off
    # the event loop.
    return await run_in_threadpool(capabilities_payload, refresh=refresh)


@router.get("/runtime-capabilities/diagnostics/export")
async def export_runtime_diagnostics() -> Response:
    payload = await run_in_threadpool(capabilities_payload)
    return Response(
        content=json.dumps(payload, indent=2, ensure_ascii=False),
        media_type="application/json",
        headers={
            "Content-Disposition": (
                'attachment; filename="vlo-runtime-diagnostics.json"'
            )
        },
    )


@router.get("/runtime-capabilities/{capability_id}")
async def get_runtime_capability(
    capability_id: str,
    refresh: bool = False,
) -> dict[str, Any]:
    payload = await run_in_threadpool(
        capability_payload, capability_id, refresh=refresh
    )
    if payload is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Unknown capability '{capability_id}'. "
                f"Known capabilities: {', '.join(list_capability_ids())}"
            ),
        )
    return payload


@router.post("/runtime-capabilities/{capability_id}/probe")
async def submit_runtime_capability_probe(
    capability_id: str,
) -> dict[str, str]:
    try:
        snapshot = await get_runtime_capability_probe_jobs().submit(capability_id)
    except CapabilityProbeNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except CapabilityProbeNotReadyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except BackendJobCapacityError as exc:
        raise HTTPException(
            status_code=429,
            detail=str(exc),
            headers={"Retry-After": "1"},
        ) from exc
    return {"jobId": snapshot.identity.job_id}


@router.get("/runtime-capabilities/{capability_id}/probe/{job_id}")
async def get_runtime_capability_probe(
    capability_id: str,
    job_id: str,
) -> dict[str, Any]:
    try:
        snapshot = await run_in_threadpool(
            get_runtime_capability_probe_jobs().get,
            capability_id,
            job_id,
        )
    except BackendJobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return snapshot.to_dict()
