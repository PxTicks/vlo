"""SAM-Audio capability provider.

This is the capability the plan's governing case is about: a checkpoint on disk
with the ``sam_audio`` package absent. Discovery passes, the environment stage
fails with ``package_missing``, and the remediation is a pip command — not a
model re-download, which could never fix it.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Sequence
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
    device_check,
    directory_check,
    package_check,
    python_version_check,
)
from ..profiles import (
    SAM_AUDIO_PROFILE_ID,
    capability_was_requested,
    failed_install_check,
    install_remediation,
)
from ..subprocess_probe import ProbeModule, ProbeSpec
from .base import CapabilityProvider, ProviderReport, probed_module


CAPABILITY_ID = "sam-audio"

MODEL_FILES: tuple[str, ...] = ("config.json", "checkpoint.pt")

#: The optional modules the real load path fakes when they are absent. The
#: probe stubs them too, so an importability check answers the same question
#: the service does — the accelerator shims, plus wandb, which SAM-Audio's
#: dependency chain imports at module scope and uses only for training.
_IMPORT_STUBS: tuple[str, ...] = (
    "xformers.ops.fmha",
    "torchcodec.decoders",
    "wandb",
)

DOWNLOAD_REMEDIATION = Remediation(
    kind=RemediationKind.DOWNLOAD,
    summary="Download a SAM-Audio model from the model manager",
)


def _extra_sys_paths() -> tuple[str, ...]:
    """The paths the service itself adds before importing ``sam_audio``."""

    paths: list[str] = []
    explicit = os.environ.get("SAM_AUDIO_PYTHONPATH", "").strip()
    if explicit:
        paths.append(explicit)
    paths.append(str(Path.home() / "sam-audio"))
    return tuple(paths)


def _scan_model_dirs(search_paths: Sequence[Path]) -> dict[str, dict[str, Any]]:
    """Every candidate model directory, complete or not.

    ``discover_sam_audio_models`` silently skips a directory that is missing one
    of its two required files, which is exactly the difference between
    ``model_missing`` and ``model_invalid`` — so the scan happens here instead.
    """

    found: dict[str, dict[str, Any]] = {}
    for search_dir in search_paths:
        if not search_dir.exists() or not search_dir.is_dir():
            continue
        for model_dir in sorted(search_dir.iterdir(), key=lambda item: item.name.lower()):
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


class SamAudioProvider(CapabilityProvider):
    id = CAPABILITY_ID
    label = "SAM-Audio"
    uses_local_gpu = True

    def load_runtime(
        self,
        report_progress: Callable[[float, str], None] | None = None,
    ) -> dict[str, Any]:
        from services.sam_audio.sam_audio_service import probe_runtime_load

        return probe_runtime_load(on_progress=report_progress)

    def remediation_for(self, code: FailureCode) -> Remediation | None:
        # A failure reported by a real load carries no remedy of its own; for
        # the package-shaped ones this capability's install command is it.
        if code in {
            FailureCode.PACKAGE_MISSING,
            FailureCode.PACKAGE_IMPORT_FAILED,
            FailureCode.DEPENDENCY_INCOMPATIBLE,
        }:
            return install_remediation(SAM_AUDIO_PROFILE_ID)
        if code in {FailureCode.MODEL_MISSING, FailureCode.MODEL_INVALID}:
            return DOWNLOAD_REMEDIATION
        return None

    def inspect(self, *, deep_probe: bool = True) -> ProviderReport:
        from config import (
            SAM_AUDIO_CACHE_DIR,
            SAM_AUDIO_DEFAULT_MODEL,
            SAM_AUDIO_DEVICE,
            SAM_AUDIO_SEARCH_PATHS,
        )

        extra_paths = _extra_sys_paths()
        probe = self.probe(
            ProbeSpec(
                modules=(ProbeModule("sam_audio", distribution="sam-audio"),),
                extra_sys_path=extra_paths,
                stub_modules=_IMPORT_STUBS,
            ),
            deep_probe=deep_probe,
        )

        models = _scan_model_dirs(SAM_AUDIO_SEARCH_PATHS)
        selected = SAM_AUDIO_DEFAULT_MODEL
        checks: list[Check] = [self._model_check(selected, models)]

        package = package_check(
            check_id="package.sam_audio",
            module="sam_audio",
            label="SAM-Audio",
            distribution="sam-audio",
            extra_paths=extra_paths,
            deep=probed_module(probe, "sam_audio"),
            remediation=install_remediation(SAM_AUDIO_PROFILE_ID),
        )
        checks.append(python_version_check((3, 11)))
        checks.append(package)
        device, device_report = device_check(
            check_id="device.requested",
            requested=SAM_AUDIO_DEVICE,
            probe=device_probe(deep_probe=deep_probe),
            env_var="SAM_AUDIO_DEVICE",
            label="SAM-Audio",
        )
        checks.append(device)
        checks.append(
            directory_check(
                check_id="cache.directory",
                path=SAM_AUDIO_CACHE_DIR,
                label="The SAM-Audio cache directory",
            )
        )
        # Only present when the installer recorded this profile as having
        # failed *and* the package is still missing — the soft
        # warn-and-continue that otherwise leaves no trace. Gating on the live
        # check matters: repairing the install by hand does not rewrite the
        # marker, and a check that fired on the marker alone would keep a
        # working capability blocked.
        install_failure = failed_install_check(
            CAPABILITY_ID, package_failing=package.failed
        )
        if install_failure is not None:
            checks.append(install_failure)

        return ProviderReport(
            checks=tuple(checks),
            # An optional feature nobody installed is "unavailable", not
            # "blocked": the capability counts as wanted once either half of it
            # (package or model) is on the machine. A package that is installed
            # but fails to import is wanted-and-broken, not deliberately absent.
            # The installer's marker adds the third way to be wanted: asked for
            # at install time and never successfully installed.
            expected=(
                bool(models)
                or package.code is not FailureCode.PACKAGE_MISSING
                or capability_was_requested(CAPABILITY_ID)
            ),
            device=device_report,
            selected_model=selected,
            models=tuple(models.values()),
        )

    def _model_check(self, selected: str, models: dict[str, dict[str, Any]]) -> Check:
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
                remediation=DOWNLOAD_REMEDIATION,
            )

        return Check(
            id="model.default",
            status=CheckStatus.FAIL,
            stage=VerificationStage.DISCOVERED,
            code=FailureCode.MODEL_MISSING,
            summary=f"No local {selected} model was found",
            remediation=DOWNLOAD_REMEDIATION,
        )
