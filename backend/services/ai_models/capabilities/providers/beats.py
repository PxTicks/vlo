"""Beat This! capability provider.

Beat This! ships in the base backend requirements, so a missing package here is
a broken install rather than a feature nobody asked for. Its checkpoints are
fetched by ``torch.hub`` on first use, which makes the cache directory — not a
model file — the thing worth checking on disk.
"""

from __future__ import annotations

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
from ..subprocess_probe import ModuleProbe, ProbeModule, ProbeSpec
from .base import CapabilityProvider, ProviderReport, probed_module


CAPABILITY_ID = "beat-this"
_IMPORT_TARGET = "beat_this.inference"

INSTALL_REMEDIATION = Remediation(
    kind=RemediationKind.COMMAND,
    summary="Reinstall the backend requirements",
    command=(
        "uv pip install --python backend/.venv/bin/python "
        "-r backend/requirements.txt"
    ),
    requires_restart=True,
)

MADMOM_REMEDIATION = Remediation(
    kind=RemediationKind.COMMAND,
    summary="Install madmom to enable DBN post-processing",
    command=(
        "uv pip install --python backend/.venv/bin/python "
        "git+https://github.com/CPJKU/madmom.git"
    ),
    requires_restart=True,
)


def _cached_checkpoints(cache_dir: Path, model: str) -> list[Path]:
    checkpoints = cache_dir / "torch" / "hub" / "checkpoints"
    if not checkpoints.is_dir():
        return []
    return [path for path in checkpoints.glob(f"*{model}*") if path.is_file()]


class BeatsProvider(CapabilityProvider):
    id = CAPABILITY_ID
    label = "Beat This!"
    uses_local_gpu = True

    def load_runtime(
        self,
        report_progress: Callable[[float, str], None] | None = None,
    ) -> dict[str, Any]:
        from services.beats.beats_service import probe_runtime_load

        if report_progress is not None:
            report_progress(0.2, "Loading the Beat This! predictor")
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
        return None

    def inspect(self, *, deep_probe: bool = True) -> ProviderReport:
        from config import BEATTHIS_CACHE_DIR, BEATTHIS_DEFAULT_MODEL, BEATTHIS_DEVICE

        probe = self.probe(
            ProbeSpec(
                modules=(
                    ProbeModule(_IMPORT_TARGET, distribution="beat-this"),
                    ProbeModule("madmom", distribution="madmom"),
                ),
                extra_sys_path=(str(BACKEND_ROOT),),
            ),
            deep_probe=deep_probe,
        )

        checks: list[Check] = [
            self._model_check(BEATTHIS_CACHE_DIR, BEATTHIS_DEFAULT_MODEL),
            python_version_check((3, 10)),
            package_check(
                check_id="package.beat_this",
                module="beat_this",
                label="Beat This!",
                distribution="beat-this",
                deep=probed_module(probe, _IMPORT_TARGET),
                remediation=INSTALL_REMEDIATION,
            ),
            self._madmom_check(probed_module(probe, "madmom")),
        ]

        device, device_report = device_check(
            check_id="device.requested",
            requested=BEATTHIS_DEVICE,
            probe=device_probe(deep_probe=deep_probe),
            env_var="BEATTHIS_DEVICE",
            label="Beat This!",
        )
        checks.append(device)
        checks.append(
            directory_check(
                check_id="cache.directory",
                path=BEATTHIS_CACHE_DIR,
                label="The Beat This! cache directory",
            )
        )

        return ProviderReport(
            checks=tuple(checks),
            # Part of the base backend requirements: always wanted, so a
            # missing package is a blocked capability, not an absent one.
            expected=True,
            device=device_report,
            selected_model=BEATTHIS_DEFAULT_MODEL,
        )

    def _model_check(self, cache_dir: Path, model: str) -> Check:
        cached = _cached_checkpoints(cache_dir, model)
        if cached:
            return Check(
                id="model.default",
                status=CheckStatus.PASS,
                stage=VerificationStage.DISCOVERED,
                summary=f"Checkpoint {model} is cached locally",
                detail=display_path(cached[0]),
            )
        return Check(
            id="model.default",
            status=CheckStatus.PASS,
            stage=VerificationStage.DISCOVERED,
            summary=f"Checkpoint {model} downloads on first use",
            detail=display_path(cache_dir),
        )

    def _madmom_check(self, madmom: ModuleProbe | None) -> Check:
        if madmom is None:
            return Check(
                id="package.madmom",
                status=CheckStatus.SKIPPED,
                summary="madmom availability was not checked",
            )
        if madmom.imported:
            return Check(
                id="package.madmom",
                status=CheckStatus.PASS,
                summary="madmom is installed, DBN post-processing is available",
            )
        # Optional: only the DBN path needs it, so this must not block the
        # capability.
        return Check(
            id="package.madmom",
            status=CheckStatus.WARN,
            code=FailureCode.PACKAGE_MISSING,
            summary="madmom is not installed, so DBN post-processing is unavailable",
            remediation=MADMOM_REMEDIATION,
        )
