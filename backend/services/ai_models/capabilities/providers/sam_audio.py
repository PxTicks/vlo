"""SAM-Audio model discovery.

The governing case the capability system exists for lives here: a checkpoint on
disk with the ``sam_audio`` package absent. Discovery passes, the environment
stage fails with ``package_missing``, and the remediation is a pip command — not
a model re-download, which could never fix it.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

from ..contract import Check, CheckStatus, FailureCode, VerificationStage
from ..descriptors import CapabilityDescriptor, Discovery
from ..environment import config_value, display_path


#: A SAM-Audio model directory is these two files. Missing one is the
#: difference between ``model_missing`` and ``model_invalid``.
MODEL_FILES: tuple[str, ...] = ("config.json", "checkpoint.pt")


def discover(descriptor: CapabilityDescriptor) -> Discovery:
    models = _scan_model_dirs(config_value("SAM_AUDIO_SEARCH_PATHS", ()) or ())
    selected = str(config_value("SAM_AUDIO_DEFAULT_MODEL", ""))

    return Discovery(
        checks=(_model_check(selected, models, descriptor),),
        models=tuple(models.values()),
        selected_model=selected,
        found=bool(models),
    )


def _scan_model_dirs(search_paths: Sequence[Path]) -> dict[str, dict[str, Any]]:
    """Every candidate model directory, complete or not.

    ``discover_sam_audio_models`` silently skips a directory that is missing one
    of its two required files, which is exactly the distinction this stage has
    to report — so the scan happens here instead.
    """

    found: dict[str, dict[str, Any]] = {}
    for search_dir in search_paths:
        search_dir = Path(search_dir)
        if not search_dir.exists() or not search_dir.is_dir():
            continue
        for model_dir in sorted(
            search_dir.iterdir(), key=lambda item: item.name.lower()
        ):
            if not model_dir.is_dir() or model_dir.name in found:
                continue
            present = [name for name in MODEL_FILES if (model_dir / name).is_file()]
            if not present:
                continue
            found[model_dir.name] = {
                "key": model_dir.name,
                "name": model_dir.name,
                "path": display_path(model_dir),
                "complete": len(present) == len(MODEL_FILES),
                "missingFiles": [name for name in MODEL_FILES if name not in present],
            }
    return found


def _model_check(
    selected: str,
    models: dict[str, dict[str, Any]],
    descriptor: CapabilityDescriptor,
) -> Check:
    entry = models.get(selected)
    if entry is not None and entry["complete"]:
        return Check(
            id="model.default",
            status=CheckStatus.PASS,
            stage=VerificationStage.DISCOVERED,
            summary=f"{selected} checkpoint found",
            detail=str(entry["path"]),
        )

    if entry is not None:
        missing = ", ".join(entry["missingFiles"])
        return Check(
            id="model.default",
            status=CheckStatus.FAIL,
            stage=VerificationStage.DISCOVERED,
            code=FailureCode.MODEL_INVALID,
            summary=f"The {selected} model directory is missing {missing}",
            detail=str(entry["path"]),
            remediation=descriptor.download_remediation,
        )

    return Check(
        id="model.default",
        status=CheckStatus.FAIL,
        stage=VerificationStage.DISCOVERED,
        code=FailureCode.MODEL_MISSING,
        summary=f"No local {selected} model was found",
        remediation=descriptor.download_remediation,
    )


__all__ = ["MODEL_FILES", "discover"]
