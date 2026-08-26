"""A whitelisted snapshot of the backend environment.

Served alongside the capabilities so a support export answers "what is this
machine" without anyone pasting environment variables around. The whitelist is
the security boundary: named packages, named directories, and the *presence* of
a Hugging Face token — never its value, never arbitrary environment variables,
never a signed URL.
"""

from __future__ import annotations

import importlib.metadata
import os
import platform
import sys
import tempfile
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from .catalogue import descriptor_packages, descriptors
from .contract import iso_timestamp, utc_now
from .failures import sanitize_message
from .profiles import describe_profiles
from .subprocess_probe import (
    DeviceProbe,
    ProbeModule,
    ProbeResult,
    ProbeSpec,
    cached_probe,
    probe_environment,
)


ENVIRONMENT_PROBE_KEY = "environment"

#: The one probe every capability shares: torch plus the device inventory.
_ENVIRONMENT_SPEC = ProbeSpec(modules=(ProbeModule("torch"),), device=True)

#: Packages every capability's environment rests on, whoever asked for them.
#: Versions come from installed distribution metadata, so listing one here
#: never imports it.
BASE_REPORTED_PACKAGES: tuple[str, ...] = (
    "torch",
    "torchaudio",
    "torchcodec",
    "numpy",
    "av",
    "soundfile",
    "einops",
    "huggingface-hub",
    "transformers",
    "hydra-core",
    "xformers",
)


def reported_packages() -> tuple[str, ...]:
    """The shared base, plus whatever the descriptors declare.

    Derived rather than hand-listed so a new capability's packages appear in a
    support export without anyone editing this module.
    """

    names = list(BASE_REPORTED_PACKAGES)
    for name in descriptor_packages():
        if name not in names:
            names.append(name)
    return tuple(names)

_HF_TOKEN_ENV_VARS = (
    "HF_TOKEN",
    "HUGGING_FACE_HUB_TOKEN",
    "HUGGINGFACE_HUB_TOKEN",
)


def environment_probe(*, refresh: bool = False) -> ProbeResult:
    """The one shared subprocess probe that reports torch and the devices.

    Capability providers reuse this instead of each asking for device info,
    so a cold cache costs one torch import rather than one per capability.
    """

    return probe_environment(ENVIRONMENT_PROBE_KEY, _ENVIRONMENT_SPEC, refresh=refresh)


def device_probe(*, deep_probe: bool = True) -> DeviceProbe | None:
    """The shared device report, or ``None`` when nothing is known cheaply."""

    if deep_probe:
        return environment_probe().device
    warm = cached_probe(ENVIRONMENT_PROBE_KEY, _ENVIRONMENT_SPEC)
    return warm.device if warm is not None else None


def _resolved(path: Path | str) -> Path | None:
    try:
        return Path(path).resolve()
    except OSError:
        return None


def _in_virtual_env() -> bool:
    """Is this interpreter isolated from a base system installation?

    ``sys.prefix != sys.base_prefix`` recognises PEP 405 venvs only: a conda
    environment is a full installation and reports the two as equal, so the
    card would label the very environment the backend runs in as a bare system
    Python. The environment variables are cross-checked against ``sys.prefix``
    rather than trusted on their own, because an activated shell exports them
    to every child process — including one launched from a different
    interpreter entirely, where they describe someone else's environment.
    """

    if sys.prefix != getattr(sys, "base_prefix", sys.prefix):
        return True

    prefix = _resolved(sys.prefix)
    if prefix is None:
        return False
    for name in ("VIRTUAL_ENV", "CONDA_PREFIX"):
        raw = os.environ.get(name, "").strip()
        if raw and _resolved(raw) == prefix:
            return True
    return False


def display_path(path: Path | str) -> str:
    return sanitize_message(str(path))


def is_writable(path: Path) -> bool:
    if not path.is_dir():
        return False
    try:
        handle = tempfile.NamedTemporaryFile(dir=path, prefix=".vlo-probe-")
        handle.close()
    except OSError:
        return False
    return True


def describe_directory(directory_id: str, path: Path) -> dict[str, Any]:
    exists = path.exists()
    return {
        "id": directory_id,
        "path": display_path(path),
        "exists": exists,
        "readable": exists and os.access(path, os.R_OK),
        "writable": is_writable(path) if exists else False,
    }


def _package_versions(names: Iterable[str]) -> dict[str, str | None]:
    versions: dict[str, str | None] = {}
    for name in names:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
        except Exception:  # pragma: no cover - defensive: broken dist metadata
            versions[name] = None
    return versions


def _hugging_face_snapshot() -> dict[str, Any]:
    env_token = any(os.environ.get(name, "").strip() for name in _HF_TOKEN_ENV_VARS)
    token_file = Path.home() / ".cache" / "huggingface" / "token"
    return {
        # Presence only. The token itself must never leave the process.
        "tokenPresent": bool(env_token or token_file.is_file()),
        "tokenSource": "environment" if env_token else ("file" if token_file.is_file() else None),
    }


def _offline_snapshot() -> dict[str, bool]:
    def flag(name: str) -> bool:
        return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}

    return {
        "hfHubOffline": flag("HF_HUB_OFFLINE"),
        "transformersOffline": flag("TRANSFORMERS_OFFLINE"),
    }


def config_value(attribute: str, default: Any = None) -> Any:
    """Read a ``config`` attribute at call time.

    Deliberately not ``from config import NAME`` at module scope: the
    directories and search paths a descriptor names are resolved every time the
    snapshot is built, so a test (or a reconfiguration) that rebinds one of
    them is seen rather than baked in at import.
    """

    import config

    return getattr(config, attribute, default)


def _descriptor_directories() -> list[dict[str, Any]]:
    """Every cache and model directory the descriptors declare."""

    return [
        describe_directory(spec.id, Path(config_value(spec.config_attr)))
        for descriptor in descriptors()
        for spec in descriptor.cache_dirs
        if config_value(spec.config_attr) is not None
    ]


def _descriptor_search_paths() -> dict[str, list[str]]:
    """Where each capability looks for its models.

    This used to be hardcoded to ``sam2``/``samAudio``, which meant a new
    capability's search paths were simply invisible in a support export.
    """

    paths: dict[str, list[str]] = {}
    for descriptor in descriptors():
        listed: list[str] = []
        for attribute in descriptor.search_paths:
            listed.extend(
                display_path(path) for path in config_value(attribute, ()) or ()
            )
        if descriptor.search_paths:
            paths[descriptor.snapshot_key] = listed
    return paths


def describe_environment(*, refresh: bool = False) -> dict[str, Any]:
    probe = environment_probe(refresh=refresh)
    device = probe.device
    torch_snapshot = device.to_json() if device is not None else None
    if torch_snapshot is not None:
        torch_snapshot["error"] = sanitize_message(torch_snapshot.get("error")) or None

    directories = [
        # Not owned by any capability: the projects root is where everything
        # this backend writes ends up.
        describe_directory("projects", Path(config_value("PROJECTS_ROOT"))),
        *_descriptor_directories(),
    ]

    return {
        # The snapshot carries its own time. A single top-level timestamp
        # would be a lie the moment one capability is rechecked on its own.
        "checkedAt": iso_timestamp(utc_now()),
        "python": {
            "executable": display_path(sys.executable),
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
            "prefix": display_path(sys.prefix),
            "virtualEnv": _in_virtual_env(),
        },
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "torch": torch_snapshot,
        "probe": {
            "ok": probe.ok,
            "timedOut": probe.timed_out,
            "error": sanitize_message(probe.error) or None,
        },
        "packages": _package_versions(reported_packages()),
        "directories": directories,
        "searchPaths": _descriptor_search_paths(),
        "huggingFace": _hugging_face_snapshot(),
        "offline": _offline_snapshot(),
        # What the installer was asked for and what it managed to do. Without
        # this, a support export cannot tell "never installed" from "install
        # failed and warned into a scrollback nobody kept".
        "installProfiles": describe_profiles(),
    }
