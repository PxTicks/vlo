"""Workflow mode directory resolution."""

from __future__ import annotations

from pathlib import Path
from config import LOCAL_MACHINE_MODE, RUNTIME_ROOT
import os
import json
import re

from services.runtime_settings import get_workflow_mode

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS_DIR = RUNTIME_ROOT / "workflows" if LOCAL_MACHINE_MODE else _BACKEND_ROOT / "assets" / "workflows"
DEFAULT_WORKFLOWS_DIR = _BACKEND_ROOT / "assets" / ".config" / "default_workflows"
HIGH_VRAM_WORKFLOWS_DIR = _BACKEND_ROOT / "assets" / ".config" / "high_vram_workflows"


def get_packaged_workflows_dir() -> Path:
    if get_workflow_mode() == "high_vram":
        return HIGH_VRAM_WORKFLOWS_DIR
    return DEFAULT_WORKFLOWS_DIR


def machine_workflow_allowed(workflow_id: str) -> bool:
    """User-selected models only; explicit prefixes allow future registered additions."""
    if not LOCAL_MACHINE_MODE:
        return True
    prefixes = os.environ.get("VLO_ENABLED_WORKFLOW_PREFIXES", "vlo_minimax_h3_,vlo_qwen_image_2_1_").split(",")
    return any(workflow_id.startswith(prefix.strip()) for prefix in prefixes if prefix.strip())


def machine_submission_allowed(workflow_id: str | None, workflow: dict) -> bool:
    if not LOCAL_MACHINE_MODE:
        return True
    if not workflow_id or not machine_workflow_allowed(workflow_id):
        return False
    family = machine_graph_family(workflow)
    return family is not None and workflow_id.startswith(f"vlo_{family}_")


def machine_graph_family(workflow: dict) -> str | None:
    """Positive execution evidence, including every generative checkpoint loader.

    Prompt text and metadata cannot authorize a model. A supported node alongside
    an unrelated checkpoint cannot disguise a mixed-model workflow either.
    Future installed families require explicit family patterns and workflow prefixes.
    """
    defaults = {"minimax_h3": r"minimax[_ -]?h3", "qwen_image_2_1": r"qwen[_ -]?image[_ -]?2[._-]1"}
    patterns = json.loads(os.environ.get("VLO_MODEL_FAMILY_PATTERNS", json.dumps(defaults)))
    primary_fields = {"model_name", "ckpt_name", "unet_name", "diffusion_model", "model_path", "checkpoint", "dit_name"}
    families = set()
    for node in workflow.values():
        if not isinstance(node, dict) or not isinstance(node.get("inputs", {}), dict):
            return None
        class_type = str(node.get("class_type", ""))
        for family, pattern in patterns.items():
            if re.search(pattern, class_type, re.IGNORECASE):
                families.add(family)
        for key, value in node.get("inputs", {}).items():
            if not isinstance(value, str):
                continue
            is_primary = key in primary_fields or (
                key in {"filename", "path", "model"} and
                re.search(r"(?:unet|diffusion|checkpoint|model).*load|load.*(?:unet|diffusion|checkpoint|model)", class_type, re.IGNORECASE)
            )
            if not is_primary:
                continue
            matches = {family for family, pattern in patterns.items() if re.search(pattern, value, re.IGNORECASE)}
            if len(matches) != 1:
                return None
            families.update(matches)
    return next(iter(families)) if len(families) == 1 else None
