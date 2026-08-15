"""HTTP translation for coordinator errors.

Three distinct conditions, three distinct codes:

- ``503`` — the coordinator has not finished restoring in-flight work. Retrying
  later is correct; the machine's state is simply not known yet.
- ``429`` — admission was refused or the bounded wait expired. The resource is
  known and busy, so ``Retry-After`` is meaningful.
- ``409`` — used by the ComfyUI dispatch path, where the frontend queue holds
  the plan and retries on the next ledger event rather than backing off blindly.
"""

from __future__ import annotations

from fastapi import HTTPException

from services.model_work.leases import CoordinatorNotReadyError, LeaseTimeoutError

DEFAULT_RETRY_AFTER_SECONDS = 5


def http_exception_for(
    exc: Exception,
    *,
    retry_after_seconds: int = DEFAULT_RETRY_AFTER_SECONDS,
) -> HTTPException:
    if isinstance(exc, CoordinatorNotReadyError):
        return HTTPException(
            status_code=503,
            detail=str(exc),
            headers={"Retry-After": str(retry_after_seconds)},
        )
    if isinstance(exc, LeaseTimeoutError):
        return HTTPException(
            status_code=429,
            detail=str(exc),
            headers={"Retry-After": str(retry_after_seconds)},
        )
    raise exc


__all__ = ["DEFAULT_RETRY_AFTER_SECONDS", "http_exception_for"]
