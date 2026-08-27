"""Restarting the backend, and reporting whether anything needs it.

``GET /app/lifecycle`` is the poll a client waits on across a restart: it is
cheap, it answers before the app has finished doing anything else, and its
``instanceId`` changes exactly once — when a genuinely new process answers it.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from services.app_lifecycle import (
    RestartBlockedError,
    RestartNotSupportedError,
    request_restart,
    restart_state,
)


router = APIRouter(prefix="/app", tags=["app-lifecycle"])


@router.get("/lifecycle")
async def get_app_lifecycle() -> dict[str, Any]:
    return restart_state()


@router.post("/lifecycle/restart")
async def restart_app(force: bool = False) -> dict[str, Any]:
    """Restart the backend process.

    ``force`` overrides the in-flight GPU work guard, and only that: it cannot
    make a process that has no way to relaunch itself restart anyway.
    """

    try:
        return request_restart(force=force)
    except RestartNotSupportedError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    except RestartBlockedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
