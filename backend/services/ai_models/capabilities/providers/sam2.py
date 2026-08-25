"""SAM2 capability provider.

SAM2 is installed by the shell installer as a git clone plus an editable
install, with every step a soft warn-and-continue. Checkpoints, meanwhile, are
downloaded from the app independently. The two halves come apart routinely, so
this provider reports them separately.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..contract import (
    Check,
    CheckStatus,
    FailureCode,
    Remediation,
    RemediationKind,
    VerificationStage,
)
from ..environment import device_probe, display_path
from ..probes import (
    BACKEND_ROOT,
    device_check,
    directory_check,
    package_check,
    python_version_check,
)
from ..subprocess_probe import ProbeModule, ProbeSpec
from .base import CapabilityProvider, ProviderReport, probed_module


CAPABILITY_ID = "sam2"

#: What the service actually imports. Probing the submodule rather than the
#: top-level name matters: the installer's ``backend/sam2`` clone makes a bare
#: ``import sam2`` succeed as an empty namespace package even when nothing was
#: installed into the venv.
_IMPORT_TARGET = "sam2.build_sam"

INSTALL_REMEDIATION = Remediation(
    kind=RemediationKind.COMMAND,
    summary="Install SAM2 into the backend virtual environment",
    command=(
        "git clone https://github.com/facebookresearch/sam2.git backend/sam2 && "
        "uv pip install --python backend/.venv/bin/python -e backend/sam2"
    ),
    requires_restart=True,
)

DOWNLOAD_REMEDIATION = Remediation(
    kind=RemediationKind.DOWNLOAD,
    summary="Download a SAM2 checkpoint from the model manager",
)


def _extra_sys_paths() -> tuple[str, ...]:
    paths = [str(BACKEND_ROOT)]
    explicit = os.environ.get("SAM2_PYTHONPATH", "").strip()
    if explicit:
        paths.insert(0, explicit)
    return tuple(paths)


def _discover_models() -> list[dict[str, Any]]:
    from services.sam2.sam2_discovery import discover_sam2_models

    return [dict(model) for model in discover_sam2_models()]


class Sam2Provider(CapabilityProvider):
    id = CAPABILITY_ID
    label = "SAM2"
    uses_local_gpu = True

    def load_runtime(
        self,
        report_progress: Callable[[float, str], None] | None = None,
    ) -> dict[str, Any]:
        from services.sam2.sam2_service import probe_runtime_load

        if report_progress is not None:
            report_progress(0.2, "Loading the SAM2 predictor")
        return probe_runtime_load()

    def remediation_for(self, code: FailureCode) -> Remediation | None:
        # A failure reported by a real load carries no remedy of its own; for
        # the package-shaped ones this capability's install command is it.
        if code in {
            FailureCode.PACKAGE_MISSING,
            FailureCode.PACKAGE_IMPORT_FAILED,
            FailureCode.DEPENDENCY_INCOMPATIBLE,
        }:
            return INSTALL_REMEDIATION
        if code in {FailureCode.MODEL_MISSING, FailureCode.MODEL_INVALID}:
            return DOWNLOAD_REMEDIATION
        return None

    def inspect(self, *, deep_probe: bool = True) -> ProviderReport:
        from config import SAM2_CACHE_DIR, SAM2_DEVICE

        extra_paths = _extra_sys_paths()
        probe = self.probe(
            ProbeSpec(
                modules=(ProbeModule(_IMPORT_TARGET, distribution="sam2"),),
                extra_sys_path=extra_paths,
            ),
            deep_probe=deep_probe,
        )

        models = _discover_models()
        selected = models[0] if models else None

        checks: list[Check] = [
            self._checkpoint_check(models),
            self._config_check(selected),
            python_version_check((3, 10)),
            package_check(
                check_id="package.sam2",
                module="sam2",
                label="SAM2",
                distribution="sam2",
                extra_paths=extra_paths,
                deep=probed_module(probe, _IMPORT_TARGET),
                remediation=INSTALL_REMEDIATION,
            ),
        ]
        package = checks[-1]

        device, device_report = device_check(
            check_id="device.requested",
            requested=SAM2_DEVICE,
            probe=device_probe(deep_probe=deep_probe),
            env_var="SAM2_DEVICE",
            label="SAM2",
        )
        checks.append(device)
        checks.append(
            directory_check(
                check_id="cache.directory",
                path=SAM2_CACHE_DIR,
                label="The SAM2 cache directory",
            )
        )

        return ProviderReport(
            checks=tuple(checks),
            # Import failure proves the package is present but broken. Treat it
            # as a blocked requested capability even when no checkpoint exists.
            expected=(
                bool(models) or package.code is not FailureCode.PACKAGE_MISSING
            ),
            device=device_report,
            selected_model=str(selected["name"]) if selected else None,
            models=tuple(
                {
                    "name": model.get("name"),
                    "checkpointPath": display_path(model.get("checkpoint_path", "")),
                    "configPath": display_path(model.get("config_path", "")),
                }
                for model in models
            ),
        )

    def _checkpoint_check(self, models: list[dict[str, Any]]) -> Check:
        if not models:
            return Check(
                id="model.checkpoint",
                status=CheckStatus.FAIL,
                stage=VerificationStage.DISCOVERED,
                code=FailureCode.MODEL_MISSING,
                summary="No SAM2 checkpoints were found in the search paths",
                remediation=DOWNLOAD_REMEDIATION,
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

    def _config_check(self, selected: dict[str, Any] | None) -> Check:
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
                remediation=DOWNLOAD_REMEDIATION,
            )

        if not config_path.is_absolute():
            # A bare filename means Hydra resolves it from the installed sam2
            # package at load time; the package check covers whether that
            # package exists at all.
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
