from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse


def build_error_payload(
    code: str,
    message: str,
    *,
    retryable: bool | None = None,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "code": code,
        "message": message,
    }
    if retryable is not None:
        payload["retryable"] = retryable
    if details:
        payload["details"] = details
    return {"error": payload}


def error_response(
    status_code: int,
    code: str,
    message: str,
    *,
    retryable: bool | None = None,
    details: dict[str, Any] | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=build_error_payload(
            code,
            message,
            retryable=retryable,
            details=details,
        ),
    )
