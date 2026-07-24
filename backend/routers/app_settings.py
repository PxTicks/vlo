from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from api_errors import error_response
from services.comfyui.comfyui_client import get_comfyui_url, set_comfyui_url
from services.hardware import HIGH_VRAM_THRESHOLD_MB, VramInfo, detect_local_vram
from services.runtime_settings import (
    get_runtime_settings,
    should_prompt_for_comfyui_install_dir,
    should_prompt_for_high_vram,
    update_runtime_settings,
)
from services.menu_layouts import (
    MenuLayoutConflictError,
    delete_menu_layout,
    get_menu_layout,
    put_menu_layout,
)

router = APIRouter(prefix="/app", tags=["app-settings"])


def build_public_settings_payload(vram_info: VramInfo | None = None) -> dict[str, Any]:
    settings = get_runtime_settings()
    resolved_vram = vram_info if vram_info is not None else detect_local_vram()

    return {
        "settings": {
            "workflowMode": settings["workflow_mode"],
            "comfyuiUrl": get_comfyui_url(),
            "comfyuiInstallDir": settings.get("comfyui_install_dir"),
            "highVramPromptStatus": settings.get("high_vram_prompt_status"),
            "comfyuiInstallDirPromptStatus": settings.get(
                "comfyui_install_dir_prompt_status",
            ),
        },
        "hardware": {
            "vram": {
                "totalMb": resolved_vram.total_mb,
                "source": resolved_vram.source,
                "meetsHighVramThreshold": resolved_vram.meets_high_vram_threshold,
            },
            "highVramThresholdMb": HIGH_VRAM_THRESHOLD_MB,
        },
        "recommendations": {
            "shouldPromptForHighVram": should_prompt_for_high_vram(
                resolved_vram.total_mb,
            ),
            "shouldPromptForComfyuiInstallDir": should_prompt_for_comfyui_install_dir(),
        },
    }


def _optional_string(payload: dict[str, Any], key: str) -> str | None:
    value = payload.get(key)
    return value if isinstance(value, str) else None


@router.get("/settings")
async def get_app_settings():
    return build_public_settings_payload()


@router.patch("/settings")
async def patch_app_settings(request: Request):
    body = await request.json()
    if not isinstance(body, dict):
        return error_response(
            400,
            "invalid_app_settings_payload",
            "Settings payload must be an object",
            retryable=False,
        )

    comfyui_url = _optional_string(body, "comfyuiUrl")
    if comfyui_url is not None:
        try:
            await set_comfyui_url(comfyui_url)
        except ValueError as exc:
            return error_response(
                400,
                "invalid_comfyui_url",
                str(exc),
                retryable=False,
            )

    workflow_mode = _optional_string(body, "workflowMode")
    high_vram_prompt_status = _optional_string(body, "highVramPromptStatus")
    comfyui_install_dir_prompt_status = _optional_string(
        body,
        "comfyuiInstallDirPromptStatus",
    )

    update_kwargs: dict[str, Any] = {
        "workflow_mode": workflow_mode,
        "high_vram_prompt_status": high_vram_prompt_status,
        "comfyui_install_dir_prompt_status": comfyui_install_dir_prompt_status,
    }
    if "comfyuiInstallDir" in body:
        raw_dir = body.get("comfyuiInstallDir")
        if raw_dir is not None and not isinstance(raw_dir, str):
            return error_response(
                400,
                "invalid_comfyui_install_dir",
                "ComfyUI install directory must be a string or null",
                retryable=False,
            )
        update_kwargs["comfyui_install_dir"] = raw_dir

    try:
        update_runtime_settings(**update_kwargs)  # type: ignore[arg-type]
    except ValueError as exc:
        return error_response(
            400,
            "invalid_app_settings",
            str(exc),
            retryable=False,
        )

    return build_public_settings_payload()


@router.get("/menu-layouts/{menu_id}")
async def get_persisted_menu_layout(menu_id: str):
    try:
        return await run_in_threadpool(get_menu_layout, menu_id)
    except ValueError as exc:
        return error_response(
            400,
            "invalid_menu_layout_id",
            str(exc),
            retryable=False,
        )
    except OSError as exc:
        return error_response(
            500,
            "menu_layout_read_failed",
            "Failed to read the menu layout",
            retryable=True,
            details={"reason": str(exc)},
        )


@router.put("/menu-layouts/{menu_id}")
async def put_persisted_menu_layout(menu_id: str, request: Request):
    body = await request.json()
    if not isinstance(body, dict):
        return error_response(
            400,
            "invalid_menu_layout_payload",
            "Menu layout payload must be an object",
            retryable=False,
        )
    try:
        return await run_in_threadpool(
            put_menu_layout,
            menu_id,
            body.get("customization"),
            body.get("baseRevision"),
        )
    except MenuLayoutConflictError as exc:
        return error_response(
            409,
            "menu_layout_revision_conflict",
            str(exc),
            retryable=True,
        )
    except ValueError as exc:
        return error_response(
            400,
            "invalid_menu_layout_payload",
            str(exc),
            retryable=False,
        )
    except OSError as exc:
        return error_response(
            500,
            "menu_layout_write_failed",
            "Failed to save the menu layout",
            retryable=True,
            details={"reason": str(exc)},
        )


@router.delete("/menu-layouts/{menu_id}")
async def delete_persisted_menu_layout(menu_id: str):
    try:
        return await run_in_threadpool(delete_menu_layout, menu_id)
    except ValueError as exc:
        return error_response(
            400,
            "invalid_menu_layout_id",
            str(exc),
            retryable=False,
        )
    except OSError as exc:
        return error_response(
            500,
            "menu_layout_delete_failed",
            "Failed to reset the menu layout",
            retryable=True,
            details={"reason": str(exc)},
        )
