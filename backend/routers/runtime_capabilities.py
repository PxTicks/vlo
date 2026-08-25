"""Runtime-capability endpoints.

Cheap stages only. These routes stat the filesystem, read package metadata, and
consult a cached out-of-process probe; none of them loads a model. That keeps
them safe to poll and keeps ``/app/status`` — already a fat endpoint — free of
anything expensive.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool

from services.ai_models.capabilities import (
    capabilities_payload,
    capability_payload,
    list_capability_ids,
)


router = APIRouter(prefix="/app", tags=["runtime-capabilities"])


@router.get("/runtime-capabilities")
async def get_runtime_capabilities(refresh: bool = False) -> dict[str, Any]:
    # The probes stat directories and may wait on a subprocess, so they run off
    # the event loop.
    return await run_in_threadpool(capabilities_payload, refresh=refresh)


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
