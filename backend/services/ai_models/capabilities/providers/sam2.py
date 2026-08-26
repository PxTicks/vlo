"""SAM2 model discovery.

Everything else about this capability — its package, Python floor, device,
cache directory, install profile and load boundary — is declared in
:mod:`..catalogue`. What is left here is the part that genuinely differs:
SAM2 resolves loose checkpoints from the search paths and pairs each with a
Hydra config that may be a bare filename the installed package supplies.

SAM2 installs from ``backend/requirements-sam2.txt`` while checkpoints are
downloaded from the app independently, so the two halves come apart routinely.
They are reported separately for exactly that reason.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..contract import Check, CheckStatus, FailureCode, VerificationStage
from ..descriptors import CapabilityDescriptor, Discovery
from ..environment import display_path


def discover(descriptor: CapabilityDescriptor) -> Discovery:
    from services.sam2.sam2_discovery import discover_sam2_models

    models = [dict(model) for model in discover_sam2_models()]
    selected = models[0] if models else None

    return Discovery(
        checks=(
            _checkpoint_check(models, descriptor),
            _config_check(selected, descriptor),
        ),
        models=tuple(
            {
                "name": model.get("name"),
                "checkpointPath": display_path(model.get("checkpoint_path", "")),
                "configPath": display_path(model.get("config_path", "")),
            }
            for model in models
        ),
        selected_model=str(selected["name"]) if selected else None,
        found=bool(models),
    )


def _checkpoint_check(
    models: list[dict[str, Any]],
    descriptor: CapabilityDescriptor,
) -> Check:
    if not models:
        return Check(
            id="model.checkpoint",
            status=CheckStatus.FAIL,
            stage=VerificationStage.DISCOVERED,
            code=FailureCode.MODEL_MISSING,
            summary="No SAM2 checkpoints were found in the search paths",
            remediation=descriptor.download_remediation,
        )
    names = ", ".join(str(model.get("name")) for model in models[:3])
    return Check(
        id="model.checkpoint",
        status=CheckStatus.PASS,
        stage=VerificationStage.DISCOVERED,
        summary=(
            f"{len(models)} SAM2 checkpoint{'s' if len(models) != 1 else ''} found"
        ),
        detail=names,
    )


def _config_check(
    selected: dict[str, Any] | None,
    descriptor: CapabilityDescriptor,
) -> Check:
    if selected is None:
        return Check(
            id="model.config",
            status=CheckStatus.SKIPPED,
            stage=VerificationStage.DISCOVERED,
            summary="No checkpoint selected, so no config to resolve",
        )

    config_path = Path(str(selected.get("config_path", "")))
    if config_path.is_absolute() and not config_path.exists():
        return Check(
            id="model.config",
            status=CheckStatus.FAIL,
            stage=VerificationStage.DISCOVERED,
            code=FailureCode.MODEL_INVALID,
            summary=f"The config for {selected.get('name')} is missing",
            detail=display_path(config_path),
            remediation=descriptor.download_remediation,
        )

    if not config_path.is_absolute():
        # A bare filename means Hydra resolves it from the installed sam2
        # package at load time; the package check covers whether that package
        # exists at all.
        return Check(
            id="model.config",
            status=CheckStatus.PASS,
            stage=VerificationStage.DISCOVERED,
            summary=f"Config {config_path} resolves from the sam2 package",
        )

    return Check(
        id="model.config",
        status=CheckStatus.PASS,
        stage=VerificationStage.DISCOVERED,
        summary=f"Config found for {selected.get('name')}",
        detail=display_path(config_path),
    )


__all__ = ["discover"]
