"""Persistent runtime settings edited from the app UI."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Literal, TypedDict

from config import COMFYUI_INSTALL_DIR as ENV_COMFYUI_INSTALL_DIR
from config import RUNTIME_ROOT
from services.hardware import HIGH_VRAM_THRESHOLD_MB

logger = logging.getLogger(__name__)

WorkflowMode = Literal["default", "high_vram"]
HighVramPromptStatus = Literal["accepted", "declined"]
ComfyuiInstallDirPromptStatus = Literal["dismissed"]

WORKFLOW_MODES: set[str] = {"default", "high_vram"}
HIGH_VRAM_PROMPT_STATUSES: set[str] = {"accepted", "declined"}
COMFYUI_INSTALL_DIR_PROMPT_STATUSES: set[str] = {"dismissed"}

SETTINGS_PATH = RUNTIME_ROOT / "app_settings.json"
_UNSET = object()


class RuntimeSettings(TypedDict, total=False):
    workflow_mode: WorkflowMode
    high_vram_prompt_status: HighVramPromptStatus | None
    comfyui_install_dir: str | None
    comfyui_install_dir_prompt_status: ComfyuiInstallDirPromptStatus | None


def _env_workflow_mode() -> WorkflowMode:
    raw_mode = os.environ.get("VLO_WORKFLOW_MODE", "default").strip().lower()
    return "high_vram" if raw_mode in {"high_vram", "high-vram", "highvram"} else "default"


def _read_raw_settings() -> dict[str, Any]:
    try:
        payload = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Failed to read runtime settings from %s: %s", SETTINGS_PATH, exc)
        return {}

    return payload if isinstance(payload, dict) else {}


def _write_raw_settings(settings: dict[str, Any]) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")


def _normalize_workflow_mode(value: Any, fallback: WorkflowMode) -> WorkflowMode:
    if isinstance(value, str):
        normalized = value.strip().lower().replace("-", "_")
        if normalized in WORKFLOW_MODES:
            return normalized  # type: ignore[return-value]
    return fallback


def _normalize_prompt_status(value: Any, allowed: set[str]) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in allowed:
            return normalized
    return None


def _normalize_install_dir(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        return None

    normalized = value.strip()
    if not normalized:
        return None
    return str(Path(normalized).expanduser())


def get_runtime_settings() -> RuntimeSettings:
    raw = _read_raw_settings()
    workflow_mode = _normalize_workflow_mode(
        raw.get("workflow_mode"),
        _env_workflow_mode(),
    )

    if "comfyui_install_dir" in raw:
        comfyui_install_dir = _normalize_install_dir(raw.get("comfyui_install_dir"))
    else:
        comfyui_install_dir = str(ENV_COMFYUI_INSTALL_DIR) if ENV_COMFYUI_INSTALL_DIR else None

    return {
        "workflow_mode": workflow_mode,
        "high_vram_prompt_status": _normalize_prompt_status(
            raw.get("high_vram_prompt_status"),
            HIGH_VRAM_PROMPT_STATUSES,
        ),  # type: ignore[typeddict-item]
        "comfyui_install_dir": comfyui_install_dir,
        "comfyui_install_dir_prompt_status": _normalize_prompt_status(
            raw.get("comfyui_install_dir_prompt_status"),
            COMFYUI_INSTALL_DIR_PROMPT_STATUSES,
        ),  # type: ignore[typeddict-item]
    }


def update_runtime_settings(
    *,
    workflow_mode: WorkflowMode | None = None,
    high_vram_prompt_status: HighVramPromptStatus | None = None,
    comfyui_install_dir: str | None | object = _UNSET,
    comfyui_install_dir_prompt_status: ComfyuiInstallDirPromptStatus | None = None,
) -> RuntimeSettings:
    raw = _read_raw_settings()

    if workflow_mode is not None:
        if workflow_mode not in WORKFLOW_MODES:
            raise ValueError("Invalid workflow mode")
        raw["workflow_mode"] = workflow_mode
        if workflow_mode == "high_vram" and high_vram_prompt_status is None:
            raw["high_vram_prompt_status"] = "accepted"

    if high_vram_prompt_status is not None:
        if high_vram_prompt_status not in HIGH_VRAM_PROMPT_STATUSES:
            raise ValueError("Invalid high VRAM prompt status")
        raw["high_vram_prompt_status"] = high_vram_prompt_status

    if comfyui_install_dir is not _UNSET:
        normalized = _normalize_install_dir(comfyui_install_dir)
        if normalized is not None and not Path(normalized).is_dir():
            raise ValueError("ComfyUI install directory does not exist")
        raw["comfyui_install_dir"] = normalized

    if comfyui_install_dir_prompt_status is not None:
        if comfyui_install_dir_prompt_status not in COMFYUI_INSTALL_DIR_PROMPT_STATUSES:
            raise ValueError("Invalid ComfyUI install directory prompt status")
        raw["comfyui_install_dir_prompt_status"] = comfyui_install_dir_prompt_status

    _write_raw_settings(raw)
    return get_runtime_settings()


def get_workflow_mode() -> WorkflowMode:
    return get_runtime_settings()["workflow_mode"]


def get_comfyui_install_dir() -> Path | None:
    raw_path = get_runtime_settings().get("comfyui_install_dir")
    if not raw_path:
        return None
    return Path(raw_path).expanduser()


def should_prompt_for_high_vram(total_vram_mb: int | None) -> bool:
    settings = get_runtime_settings()
    return (
        total_vram_mb is not None
        and total_vram_mb >= HIGH_VRAM_THRESHOLD_MB
        and settings["workflow_mode"] == "default"
        and settings.get("high_vram_prompt_status") is None
    )


def should_prompt_for_comfyui_install_dir() -> bool:
    settings = get_runtime_settings()
    return (
        settings.get("comfyui_install_dir") is None
        and settings.get("comfyui_install_dir_prompt_status") is None
    )
