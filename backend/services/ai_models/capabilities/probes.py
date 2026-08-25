"""Cheap, side-effect-free checks shared by every capability provider.

Everything in here is safe to run inside a status request: filesystem stats,
``importlib`` metadata lookups, and interpretation of a device probe that was
gathered out-of-process. Nothing here imports an optional ML package — the only
module that does that lives in a subprocess.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import os
import sys
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from .contract import (
    Check,
    CheckStatus,
    DeviceReport,
    FailureCode,
    Remediation,
    RemediationKind,
    VerificationStage,
)
from .failures import sanitize_message
from .subprocess_probe import DeviceProbe, ModuleProbe


#: The backend package root. The serving process runs with this on ``sys.path``
#: (it is where ``config`` and ``services`` live), so an import probe that does
#: not add it would miss packages installed as sibling checkouts — SAM2's
#: installer clones one into ``backend/sam2``.
BACKEND_ROOT = Path(__file__).resolve().parents[3]


def parse_version(raw: str | None) -> tuple[int, ...]:
    """Numeric release prefix of a version string; ``2.4.0+cu121`` → (2, 4, 0)."""

    if not raw:
        return ()
    parts: list[int] = []
    for chunk in str(raw).split("."):
        digits = ""
        for character in chunk:
            if character.isdigit():
                digits += character
            else:
                break
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts)


@dataclass(frozen=True)
class PackagePresence:
    found: bool
    origin: str | None = None
    version: str | None = None


def _distribution_version(distribution: str | None) -> str | None:
    if not distribution:
        return None
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return None
    except Exception:  # pragma: no cover - defensive: broken dist metadata
        return None


def find_package(
    module: str,
    *,
    distribution: str | None = None,
    extra_paths: Sequence[str] = (),
) -> PackagePresence:
    """Is ``module`` importable, without importing it?

    ``find_spec`` locates a top-level module without executing it. Extra paths
    cover the services that extend ``sys.path`` at load time (``SAM2_PYTHONPATH``,
    ``SAM_AUDIO_PYTHONPATH``, a sibling source checkout) — without them the
    probe would report a package as missing that the real load path resolves.
    """

    version = _distribution_version(distribution or module)
    try:
        spec = importlib.util.find_spec(module)
    except (ImportError, ValueError):  # pragma: no cover - broken parent package
        spec = None
    if spec is not None:
        return PackagePresence(True, getattr(spec, "origin", None), version)

    for raw_path in extra_paths:
        if not raw_path:
            continue
        root = Path(raw_path).expanduser()
        for candidate in (root / module / "__init__.py", root / f"{module}.py"):
            if candidate.is_file():
                return PackagePresence(True, str(candidate), version)

    return PackagePresence(False, None, version)


def python_version_check(
    minimum: tuple[int, int],
    *,
    check_id: str = "python.version",
    stage: VerificationStage = VerificationStage.ENVIRONMENT,
) -> Check:
    current = sys.version_info[:3]
    summary = f"Python {'.'.join(str(part) for part in current)}"
    if current[: len(minimum)] < minimum:
        wanted = ".".join(str(part) for part in minimum)
        return Check(
            id=check_id,
            status=CheckStatus.FAIL,
            stage=stage,
            code=FailureCode.PYTHON_VERSION_UNSUPPORTED,
            summary=f"{summary} is below the required Python {wanted}",
            remediation=Remediation(
                kind=RemediationKind.DOCS,
                summary=(
                    f"Recreate the backend virtual environment on Python {wanted} "
                    "or newer"
                ),
                requires_restart=True,
            ),
        )
    return Check(id=check_id, status=CheckStatus.PASS, stage=stage, summary=summary)


def package_check(
    *,
    check_id: str,
    module: str,
    label: str,
    remediation: Remediation | None = None,
    distribution: str | None = None,
    minimum_version: str | None = None,
    extra_paths: Sequence[str] = (),
    deep: ModuleProbe | None = None,
    stage: VerificationStage = VerificationStage.ENVIRONMENT,
) -> Check:
    """Presence, importability, and version of one package.

    ``deep`` is the out-of-process import result when one was gathered. It can
    only ever *add* information: a package that ``find_spec`` cannot see but the
    subprocess imported is present (some other path resolved it), and a package
    that is present but does not import is a different, more specific failure
    than one that was never installed.
    """

    presence = find_package(module, distribution=distribution, extra_paths=extra_paths)
    imported = deep.imported if deep is not None else None

    if not presence.found and not imported:
        return Check(
            id=check_id,
            status=CheckStatus.FAIL,
            stage=stage,
            code=FailureCode.PACKAGE_MISSING,
            summary=f"The {module} package is not installed",
            detail=f"{label} cannot run without it.",
            remediation=remediation,
        )

    if deep is not None and not deep.imported:
        missing = deep.missing_module
        detail = sanitize_message(deep.error) or None
        summary = f"The {module} package is installed but failed to import"
        if missing and missing != module:
            summary = (
                f"The {module} package is installed but failed to import "
                f"(missing dependency: {missing})"
            )
        return Check(
            id=check_id,
            status=CheckStatus.FAIL,
            stage=stage,
            code=FailureCode.PACKAGE_IMPORT_FAILED,
            summary=summary,
            detail=detail,
            remediation=remediation,
        )

    version = presence.version or (deep.version if deep is not None else None)

    if minimum_version and version and parse_version(version) < parse_version(
        minimum_version
    ):
        return Check(
            id=check_id,
            status=CheckStatus.FAIL,
            stage=stage,
            code=FailureCode.DEPENDENCY_INCOMPATIBLE,
            summary=(
                f"{module} {version} is older than the required {minimum_version}"
            ),
            remediation=remediation,
        )

    installed = f"{module} {version}" if version else f"{module} is installed"

    if deep is None:
        # Presence is not importability. Claiming a pass here would let a
        # capability whose package is installed-but-broken read as fine
        # whenever no probe has run, so this reports only what was actually
        # established: it is on disk, and nothing has tried to import it.
        return Check(
            id=check_id,
            status=CheckStatus.SKIPPED,
            stage=stage,
            summary=f"{installed}; import not verified",
            detail="No out-of-process import probe has run for this capability.",
        )

    return Check(
        id=check_id,
        status=CheckStatus.PASS,
        stage=stage,
        summary=installed,
    )


def directory_check(
    *,
    check_id: str,
    path: Path,
    label: str,
    stage: VerificationStage = VerificationStage.ENVIRONMENT,
    require_writable: bool = True,
) -> Check:
    """Does ``path`` exist and can we actually write in it?

    Writability is tested by creating a temporary file rather than by
    consulting ``os.access``, which lies under containers, ACLs, and
    read-only mounts.
    """

    if not path.exists():
        return Check(
            id=check_id,
            status=CheckStatus.FAIL if require_writable else CheckStatus.WARN,
            stage=stage,
            code=FailureCode.CACHE_UNWRITABLE,
            summary=f"{label} does not exist",
            detail=sanitize_message(str(path)),
            remediation=Remediation(
                kind=RemediationKind.COMMAND,
                summary=f"Create {label.lower()}",
                command=f"mkdir -p {path}",
            ),
        )

    if not path.is_dir():
        return Check(
            id=check_id,
            status=CheckStatus.FAIL,
            stage=stage,
            code=FailureCode.CACHE_UNWRITABLE,
            summary=f"{label} is not a directory",
            detail=sanitize_message(str(path)),
        )

    if require_writable:
        try:
            handle = tempfile.NamedTemporaryFile(dir=path, prefix=".vlo-probe-")
            handle.close()
        except OSError as exc:
            return Check(
                id=check_id,
                status=CheckStatus.FAIL,
                stage=stage,
                code=FailureCode.CACHE_UNWRITABLE,
                summary=f"{label} is not writable",
                detail=sanitize_message(f"{path}: {exc.strerror or exc}"),
                remediation=Remediation(
                    kind=RemediationKind.COMMAND,
                    summary=f"Grant write access to {label.lower()}",
                    command=f"chmod u+w {path}",
                ),
            )

    return Check(
        id=check_id,
        status=CheckStatus.PASS,
        stage=stage,
        summary=f"{label} is writable" if require_writable else f"{label} exists",
        detail=sanitize_message(str(path)),
    )


def device_check(
    *,
    check_id: str,
    requested: str,
    probe: DeviceProbe | None,
    env_var: str,
    label: str,
    cpu_fallback: bool = False,
    resolved: str | None = None,
    stage: VerificationStage = VerificationStage.ENVIRONMENT,
) -> tuple[Check, DeviceReport]:
    """Reconcile the requested device with what torch reports.

    ``resolved`` is the device the runtime actually landed on, when it has
    loaded; otherwise the report carries the device this configuration is
    expected to resolve to and marks it unproven.
    """

    normalized = (requested or "auto").strip().lower() or "auto"

    def report(expected: str | None, *, fallback: bool = False) -> DeviceReport:
        return DeviceReport(
            requested=requested or "auto",
            resolved=resolved or expected,
            proven=resolved is not None,
            fallback=fallback,
        )

    if probe is None:
        # Nothing was asked, so nothing is known — including whether an
        # explicitly requested CUDA device exists on this machine.
        return (
            Check(
                id=check_id,
                status=CheckStatus.SKIPPED,
                stage=stage,
                summary=f"Device {requested} was not checked",
                detail="No out-of-process device probe has run.",
            ),
            report(None),
        )

    if probe.torch_version is None and probe.error:
        # The probe ran and torch itself would not load: evaluated, but with
        # nothing conclusive to say about individual devices.
        return (
            Check(
                id=check_id,
                status=CheckStatus.WARN,
                stage=stage,
                summary="Could not determine which compute devices are available",
                detail=sanitize_message(probe.error) or None,
            ),
            report(None),
        )

    wants_cuda = normalized.startswith("cuda")
    wants_mps = normalized.startswith("mps")
    available = probe.cuda_available if wants_cuda else probe.mps_available

    if normalized == "auto":
        expected = "cuda" if probe.cuda_available else "cpu"
        return (
            Check(
                id=check_id,
                status=CheckStatus.PASS,
                stage=stage,
                summary=f"Device auto resolves to {expected}",
                detail=_device_detail(probe),
            ),
            report(expected),
        )

    if (wants_cuda or wants_mps) and not available:
        accelerator = "CUDA" if wants_cuda else "MPS"
        if cpu_fallback:
            return (
                Check(
                    id=check_id,
                    status=CheckStatus.WARN,
                    stage=stage,
                    code=FailureCode.DEVICE_UNAVAILABLE,
                    summary=(
                        f"{env_var} requests {requested}, but {accelerator} is "
                        "unavailable — falling back to CPU"
                    ),
                    detail=_device_detail(probe),
                ),
                report("cpu", fallback=True),
            )
        return (
            Check(
                id=check_id,
                status=CheckStatus.FAIL,
                stage=stage,
                code=FailureCode.DEVICE_UNAVAILABLE,
                summary=(
                    f"{env_var} is set to {requested}, but {accelerator} is not "
                    "available in this environment"
                ),
                detail=_device_detail(probe),
                remediation=Remediation(
                    kind=RemediationKind.SETTINGS,
                    summary=(
                        f"Set {env_var}=auto to let {label} pick an available device"
                    ),
                    command=f"{env_var}=auto",
                    requires_restart=True,
                ),
            ),
            report(None),
        )

    return (
        Check(
            id=check_id,
            status=CheckStatus.PASS,
            stage=stage,
            summary=f"Device {requested} is available",
            detail=_device_detail(probe),
        ),
        report(normalized),
    )


def _device_detail(probe: DeviceProbe) -> str | None:
    parts: list[str] = []
    if probe.torch_version:
        parts.append(f"torch {probe.torch_version}")
    if probe.cuda_build_version:
        parts.append(f"CUDA build {probe.cuda_build_version}")
    names = [str(device.get("name")) for device in probe.devices if device.get("name")]
    if names:
        parts.append(", ".join(names))
    elif not probe.cuda_available:
        parts.append("no CUDA device")
    return "; ".join(parts) or None


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}
