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

from .failures import sanitize_message
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

#: Packages worth reporting a version for. Versions come from installed
#: distribution metadata, so listing one here never imports it.
REPORTED_PACKAGES: tuple[str, ...] = (
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
    "beat-this",
    "madmom",
    "sam2",
    "sam-audio",
    "xformers",
)

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


def describe_environment(*, refresh: bool = False) -> dict[str, Any]:
    from config import (
        BEATTHIS_CACHE_DIR,
        PROJECTS_ROOT,
        SAM2_CACHE_DIR,
        SAM2_SEARCH_PATHS,
        SAM_AUDIO_CACHE_DIR,
        SAM_AUDIO_MODEL_DIR,
        SAM_AUDIO_SEARCH_PATHS,
    )

    probe = environment_probe(refresh=refresh)
    device = probe.device
    torch_snapshot = device.to_json() if device is not None else None
    if torch_snapshot is not None:
        torch_snapshot["error"] = sanitize_message(torch_snapshot.get("error")) or None

    directories = [
        describe_directory("projects", PROJECTS_ROOT),
        describe_directory("sam2.cache", SAM2_CACHE_DIR),
        describe_directory("samAudio.cache", SAM_AUDIO_CACHE_DIR),
        describe_directory("samAudio.models", SAM_AUDIO_MODEL_DIR),
        describe_directory("beatThis.cache", BEATTHIS_CACHE_DIR),
    ]

    return {
        "python": {
            "executable": display_path(sys.executable),
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
            "prefix": display_path(sys.prefix),
            "virtualEnv": sys.prefix != getattr(sys, "base_prefix", sys.prefix),
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
        "packages": _package_versions(REPORTED_PACKAGES),
        "directories": directories,
        "searchPaths": {
            "sam2": [display_path(path) for path in SAM2_SEARCH_PATHS],
            "samAudio": [display_path(path) for path in SAM_AUDIO_SEARCH_PATHS],
        },
        "huggingFace": _hugging_face_snapshot(),
        "offline": _offline_snapshot(),
    }
