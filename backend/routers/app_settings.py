from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from api_errors import error_response
from services.comfyui.comfyui_client import get_comfyui_url, set_comfyui_url
from services.hardware import HIGH_VRAM_THRESHOLD_MB, VramInfo, detect_local_vram
from services.comfyui.local_runtime import (
    ComfyuiPythonEnvironmentRequired,
    DirectoryPickerBusyError,
    comfyui_local_runtime,
    get_cached_comfyui_install_verification,
    pick_directory,
    verify_comfyui_install,
)
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


def build_public_settings_payload(
    vram_info: VramInfo | None = None,
    *,
    verify_install_dir: bool = False,
) -> dict[str, Any]:
    settings = get_runtime_settings()
    resolved_vram = vram_info if vram_info is not None else detect_local_vram()
    install_dir = settings.get("comfyui_install_dir")
    install_verification = None
    if install_dir:
        install_verification = (
            verify_comfyui_install(install_dir)
            if verify_install_dir
            else get_cached_comfyui_install_verification(install_dir)
        )

    return {
        "settings": {
            "workflowMode": settings["workflow_mode"],
            "comfyuiUrl": get_comfyui_url(),
            "comfyuiInstallDir": install_dir,
            "comfyuiInstallVerification": install_verification,
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
    return build_public_settings_payload(verify_install_dir=True)


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
        if raw_dir:
            verification = verify_comfyui_install(raw_dir)
            allow_unverified = body.get("allowUnverifiedComfyuiInstallDir") is True
            if not verification["valid"] and not allow_unverified:
                return error_response(
                    400,
                    "invalid_comfyui_install_dir",
                    "The selected folder is not a recognized ComfyUI install",
                    retryable=False,
                    details={
                        "verification": verification,
                    },
                )
            raw_dir = verification["installPath"] or raw_dir
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


async def _read_optional_json_object(request: Request) -> dict[str, Any]:
    raw_body = await request.body()
    if not raw_body:
        return {}
    try:
        body = await request.json()
    except ValueError as exc:
        raise ValueError("Request body must contain valid JSON") from exc
    if not isinstance(body, dict):
        raise ValueError("Request body must be an object")
    return body


@router.post("/comfyui/pick-directory")
async def pick_comfyui_directory(request: Request):
    try:
        body = await _read_optional_json_object(request)
    except ValueError as exc:
        return error_response(
            400,
            "invalid_directory_picker_payload",
            str(exc),
            retryable=False,
        )
    purpose = body.get("purpose") if isinstance(body, dict) else None
    title = (
        "Choose where to install ComfyUI"
        if purpose == "install"
        else "Choose your ComfyUI installation"
    )
    try:
        path = await run_in_threadpool(pick_directory, title)
    except DirectoryPickerBusyError as exc:
        return error_response(
            409,
            "directory_picker_already_open",
            str(exc),
            retryable=True,
        )
    except RuntimeError as exc:
        return error_response(
            501,
            "native_directory_picker_unavailable",
            str(exc),
            retryable=False,
        )

    return {
        "cancelled": path is None,
        "path": path,
        "verification": (
            verify_comfyui_install(path)
            if path is not None and purpose != "install"
            else None
        ),
    }


@router.post("/comfyui/verify-install")
async def verify_comfyui_install_route(request: Request):
    try:
        body = await _read_optional_json_object(request)
    except ValueError as exc:
        return error_response(
            400,
            "invalid_comfyui_verify_payload",
            str(exc),
            retryable=False,
        )
    path = body.get("path")
    if not isinstance(path, str) or not path.strip():
        return error_response(
            400,
            "invalid_comfyui_install_dir",
            "A ComfyUI install directory is required",
            retryable=False,
        )
    return verify_comfyui_install(path)


@router.post("/comfyui/install")
async def install_comfyui(request: Request):
    try:
        body = await _read_optional_json_object(request)
    except ValueError as exc:
        return error_response(
            400,
            "invalid_comfyui_install_payload",
            str(exc),
            retryable=False,
        )
    parent_path = body.get("parentPath")
    if not isinstance(parent_path, str) or not parent_path.strip():
        return error_response(
            400,
            "invalid_comfyui_install_parent",
            "An installation parent directory is required",
            retryable=False,
        )
    try:
        return comfyui_local_runtime.start_install(parent_path)
    except (ValueError, RuntimeError) as exc:
        return error_response(
            409,
            "comfyui_install_not_started",
            str(exc),
            retryable=False,
        )


@router.get("/comfyui/install")
async def get_comfyui_install_status():
    return comfyui_local_runtime.get_install_status()


@router.post("/comfyui/environment")
async def prepare_comfyui_environment():
    settings = get_runtime_settings()
    install_dir = settings.get("comfyui_install_dir")
    if not install_dir:
        return error_response(
            409,
            "comfyui_install_not_configured",
            "Choose ComfyUI before creating an environment",
            retryable=False,
        )
    try:
        return comfyui_local_runtime.start_environment_setup(install_dir)
    except (ValueError, RuntimeError) as exc:
        return error_response(
            409,
            "comfyui_environment_not_started",
            str(exc),
            retryable=False,
        )


@router.post("/comfyui/launch")
async def launch_comfyui(request: Request):
    try:
        body = await _read_optional_json_object(request)
    except ValueError as exc:
        return error_response(
            400,
            "invalid_comfyui_launch_payload",
            str(exc),
            retryable=False,
        )
    settings = get_runtime_settings()
    install_dir = settings.get("comfyui_install_dir")
    if not install_dir:
        return error_response(
            409,
            "comfyui_install_not_configured",
            "Choose or install ComfyUI before launching it",
            retryable=False,
        )
    python_path = body.get("pythonPath")
    if python_path is not None and not isinstance(python_path, str):
        return error_response(
            400,
            "invalid_comfyui_python_path",
            "pythonPath must be a string",
            retryable=False,
        )
    try:
        return await run_in_threadpool(
            comfyui_local_runtime.launch,
            install_dir,
            get_comfyui_url(),
            python_path=python_path,
            use_system_python=body.get("useSystemPython") is True,
        )
    except ComfyuiPythonEnvironmentRequired as exc:
        return {
            "started": False,
            "alreadyRunning": False,
            "requiresPythonChoice": True,
            "message": str(exc),
        }
    except (ValueError, OSError) as exc:
        return error_response(
            409,
            "comfyui_launch_failed",
            str(exc),
            retryable=False,
        )


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
