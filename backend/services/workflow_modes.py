"""Workflow mode directory resolution."""

from __future__ import annotations

from pathlib import Path

from services.runtime_settings import get_workflow_mode

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS_DIR = _BACKEND_ROOT / "assets" / "workflows"
DEFAULT_WORKFLOWS_DIR = _BACKEND_ROOT / "assets" / ".config" / "default_workflows"
HIGH_VRAM_WORKFLOWS_DIR = _BACKEND_ROOT / "assets" / ".config" / "high_vram_workflows"


def get_packaged_workflows_dir() -> Path:
    if get_workflow_mode() == "high_vram":
        return HIGH_VRAM_WORKFLOWS_DIR
    return DEFAULT_WORKFLOWS_DIR
