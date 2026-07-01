"""Inert Python dependency preflight for extension manifests.

This module answers one question for the extension manager UI: are the Python
imports an extension declares actually present in the backend virtual environment?
It never installs, upgrades, or imports extension code. Probing a declared
top-level module locates its import spec without executing the module body, so the
check is safe to run for unapproved packages during ordinary inventory scans.
"""

from __future__ import annotations

import importlib.util
import shlex
import sys
from dataclasses import dataclass
from collections.abc import Iterable, Sequence

from services.extensions.manifest import PythonDependency


def _interpreter() -> str:
    """Absolute path of the interpreter running the backend, or a safe fallback."""

    return sys.executable or "python"


def _is_isolated_environment() -> bool:
    """True when the backend runs inside a venv/uv environment rather than base."""

    return sys.prefix != sys.base_prefix


@dataclass(frozen=True)
class PythonDependencyStatus:
    module: str
    distribution: str | None
    purpose: str | None
    satisfied: bool
    detail: str


@dataclass(frozen=True)
class PreflightReport:
    satisfied: bool
    dependencies: tuple[PythonDependencyStatus, ...]
    install_hints: tuple[str, ...]
    # The environment the probe actually resolved against — the backend's own
    # interpreter prefix, which is authoritative regardless of shell activation.
    environment: str
    isolated: bool


def _probe_module(module: str) -> tuple[bool, str]:
    """Locate a top-level module spec without importing the module body."""

    try:
        spec = importlib.util.find_spec(module)
    except ModuleNotFoundError:
        return False, "Not installed in the backend environment."
    except Exception as exc:  # pragma: no cover - broken/partial installs
        # A finder can raise for a half-installed distribution. Report it as
        # unsatisfied rather than letting inventory scanning fail.
        return False, f"Could not be resolved: {exc}"
    if spec is None:
        return False, "Not installed in the backend environment."
    return True, "Installed."


def _install_target(dependency: PythonDependency) -> str:
    return dependency.distribution or dependency.module


def _install_hints(missing: Sequence[PythonDependency]) -> tuple[str, ...]:
    if not missing:
        return ()
    targets = " ".join(_install_target(dependency) for dependency in missing)
    # Both commands target the backend's live interpreter by absolute path, so
    # they are correct whether the environment is a plain venv or a uv-managed
    # one, and whether or not it is currently activated in a shell.
    python = shlex.quote(_interpreter())
    return (
        f"{python} -m pip install {targets}",
        f"uv pip install --python {python} {targets}",
    )


def check_python_dependencies(
    dependencies: Iterable[PythonDependency],
) -> PreflightReport:
    """Build a preflight report for declared Python dependencies."""

    statuses: list[PythonDependencyStatus] = []
    missing: list[PythonDependency] = []
    for dependency in dependencies:
        satisfied, detail = _probe_module(dependency.module)
        if not satisfied:
            missing.append(dependency)
        statuses.append(
            PythonDependencyStatus(
                module=dependency.module,
                distribution=dependency.distribution,
                purpose=dependency.purpose,
                satisfied=satisfied,
                detail=detail,
            )
        )
    return PreflightReport(
        satisfied=not missing,
        dependencies=tuple(statuses),
        install_hints=_install_hints(missing),
        environment=sys.prefix,
        isolated=_is_isolated_environment(),
    )
