"""Environment-stage checks, built from a descriptor rather than by hand.

Roughly five of every seven checks a local-runtime provider used to assemble
were mechanical — a Python floor, a package, a device, a cache directory, an
installer marker — and every one of them was driven entirely by data the
provider already knew statically. This module turns that data into the checks.

**Check order is load-bearing.** ``_first_failure`` reports the first failing
check as the cause on ``/app/status`` and on every feature's ``/health``, so the
order here reproduces what the providers emitted: the discovered stage first
(supplied by the caller), then the Python floor, packages, device, directories,
and finally the installer's own record. Reordering it makes those surfaces name
the wrong problem.
"""

from __future__ import annotations

from dataclasses import dataclass

from .contract import (
    Check,
    CheckStatus,
    DeviceReport,
    FailureCode,
    VerificationStage,
)
from .descriptors import CapabilityDescriptor, DeviceSpec, DirectorySpec
from .environment import (
    UNRESOLVED,
    device_probe,
    resolve_directory,
    resolve_source,
)
from .probes import (
    BACKEND_ROOT,
    device_check,
    directory_check,
    optional_package_check,
    package_check,
    python_version_check,
)
from .profiles import (
    failed_install_check,
    install_remediation,
    package_remediation,
)
from .subprocess_probe import ProbeModule, ProbeResult, ProbeSpec


@dataclass(frozen=True)
class EnvironmentChecks:
    checks: tuple[Check, ...]
    device: DeviceReport | None = None
    #: ``False`` only when the capability's own package is genuinely absent.
    #: Installed-but-broken counts as present: it proves someone installed it.
    package_present: bool = True
    #: Whether the capability's own package check failed, in any way. The
    #: installer marker is historical, so it only ever explains a failure the
    #: live check can still see.
    package_failing: bool = False


def extra_sys_paths(descriptor: CapabilityDescriptor) -> tuple[str, ...]:
    return descriptor.sys_path.resolve(BACKEND_ROOT)


def probe_spec_for(descriptor: CapabilityDescriptor) -> ProbeSpec | None:
    """The out-of-process import probe this capability needs, if any."""

    if not descriptor.packages:
        return None
    return ProbeSpec(
        modules=tuple(
            ProbeModule(package.probe_target, distribution=package.distribution)
            for package in descriptor.packages
        ),
        extra_sys_path=extra_sys_paths(descriptor),
        stub_modules=descriptor.import_stubs,
    )


def build_environment_checks(
    descriptor: CapabilityDescriptor,
    *,
    probe: ProbeResult | None = None,
    deep_probe: bool = True,
) -> EnvironmentChecks:
    """Every environment-stage check a descriptor implies, in reporting order."""

    checks: list[Check] = []
    if descriptor.python_min is not None:
        checks.append(python_version_check(descriptor.python_min))

    install = (
        install_remediation(descriptor.profile)
        if descriptor.profile is not None
        else None
    )
    paths = extra_sys_paths(descriptor)
    package_present = True
    package_failing = False

    for package in descriptor.packages:
        # ``None`` means the import was never attempted — neither a pass nor a
        # failure — which is what keeps an unexamined package from reading as
        # a healthy one.
        deep = probe.module(package.probe_target) if probe is not None else None

        if package.optional:
            checks.append(
                optional_package_check(
                    check_id=package.check_id,
                    module=package.module,
                    feature=package.feature or package.module,
                    deep=deep,
                    remediation=(
                        package_remediation(
                            package.install_summary
                            or f"Install {package.module}",
                            package.install_target,
                        )
                        if package.install_target
                        else None
                    ),
                )
            )
            continue

        check = package_check(
            check_id=package.check_id,
            module=package.module,
            label=descriptor.label,
            distribution=package.distribution,
            minimum_version=package.minimum_version,
            extra_paths=paths,
            deep=deep,
            remediation=install,
        )
        checks.append(check)
        package_failing = package_failing or check.failed
        package_present = (
            package_present and check.code is not FailureCode.PACKAGE_MISSING
        )

    device: DeviceReport | None = None
    if descriptor.device is not None:
        resolved = resolve_source(descriptor.device.requested)
        if resolved is UNRESOLVED:
            # Not "auto". Defaulting an unknown device to auto is the same
            # silent-health defect as a directory that quietly vanishes: the
            # check passes, the capability reads fine, and nothing established
            # which device this runtime would actually use.
            checks.append(_unresolved_device_check(descriptor.device))
        else:
            device_status, device = device_check(
                check_id="device.requested",
                requested=str(resolved) or "auto",
                probe=device_probe(deep_probe=deep_probe),
                env_var=descriptor.device.setting_name,
                label=descriptor.label,
            )
            checks.append(device_status)

    for directory in descriptor.cache_dirs:
        if directory.check_id is None:
            continue
        path = resolve_directory(directory)
        if path is None:
            checks.append(_unresolved_directory_check(directory))
            continue
        checks.append(
            directory_check(
                check_id=directory.check_id,
                path=path,
                label=directory.label,
                require_writable=directory.require_writable,
            )
        )

    # Only present when the installer recorded this profile as having failed
    # *and* the package is still missing — the soft warn-and-continue that
    # otherwise leaves no trace. Gating on the live check matters: repairing
    # the install by hand does not rewrite the marker, and a check that fired
    # on the marker alone would keep a working capability blocked.
    install_failure = failed_install_check(
        descriptor.id, package_failing=package_failing
    )
    if install_failure is not None:
        checks.append(install_failure)

    return EnvironmentChecks(
        checks=tuple(checks),
        device=device,
        package_present=package_present,
        package_failing=package_failing,
    )


def _unresolved_device_check(device: DeviceSpec) -> Check:
    """A declared device whose descriptor cannot say which one it is.

    ``device`` stays ``None`` on the report: the capability does run on a local
    device, we simply could not establish which, and inventing a placeholder
    would put an unproven guess where the payload promises a requested device.
    """

    return Check(
        id="device.requested",
        status=CheckStatus.FAIL,
        stage=VerificationStage.ENVIRONMENT,
        code=FailureCode.CONFIG_MISSING,
        summary=f"{device.setting_name} is not configured",
        detail=(
            "This capability declares a compute device but could not resolve "
            "a value for it, so no device could be checked."
        ),
    )


def _unresolved_directory_check(directory: DirectorySpec) -> Check:
    """A declared directory whose descriptor cannot say where it is.

    Reported rather than skipped. Silently dropping it was the sharpest edge in
    the descriptor system: the capability lost ``cache_unwritable`` detection
    entirely and nothing said so, which reads as a healthy capability with one
    fewer check than its neighbours.
    """

    assert directory.check_id is not None
    return Check(
        id=directory.check_id,
        status=CheckStatus.FAIL,
        stage=VerificationStage.ENVIRONMENT,
        code=FailureCode.CONFIG_MISSING,
        summary=f"{directory.label} is not configured",
        detail=(
            "This capability declares the directory but could not resolve a "
            "path for it, so nothing could be checked."
        ),
    )


__all__ = [
    "EnvironmentChecks",
    "build_environment_checks",
    "extra_sys_paths",
    "probe_spec_for",
]
