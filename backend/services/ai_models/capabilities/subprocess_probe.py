"""Out-of-process import and device probing, with a short-lived cache.

Two rules shape this module:

* **Never import an optional ML package in the serving process.** Such an
  import can hang, abort the interpreter, or claim global CUDA state, and a
  status request is the last place that should happen. The probe therefore
  runs in a throwaway subprocess with a hard timeout.
* **Probe the backend venv, not the ambient interpreter.** The subprocess
  reuses ``sys.executable``, matching the interpreter targeted by remediation
  commands such as ``uv pip install --python backend/.venv/bin/python ...``.

Results are cached per key with a short TTL so repeated status polls do not
spawn a process each time; a real load attempt or an explicit recheck
invalidates them.
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .probe_worker import RESULT_MARKER


DEFAULT_TIMEOUT_SECONDS = 20.0
PROBE_CACHE_TTL_SECONDS = 60.0

_WORKER_PATH = Path(__file__).with_name("probe_worker.py")


@dataclass(frozen=True)
class ProbeModule:
    name: str
    distribution: str | None = None


@dataclass(frozen=True)
class ProbeSpec:
    modules: tuple[ProbeModule, ...] = ()
    extra_sys_path: tuple[str, ...] = ()
    stub_modules: tuple[str, ...] = ()
    device: bool = False

    def to_payload(self) -> dict[str, Any]:
        return {
            "modules": [
                {"name": module.name, "distribution": module.distribution}
                for module in self.modules
            ],
            "extraSysPath": list(self.extra_sys_path),
            "stubModules": list(self.stub_modules),
            "device": self.device,
        }

    def fingerprint(self) -> str:
        return json.dumps(self.to_payload(), sort_keys=True)


@dataclass(frozen=True)
class ModuleProbe:
    name: str
    imported: bool = False
    version: str | None = None
    error: str | None = None
    error_type: str | None = None
    missing_module: str | None = None


@dataclass(frozen=True)
class DeviceProbe:
    torch_version: str | None = None
    cuda_available: bool = False
    cuda_build_version: str | None = None
    mps_available: bool = False
    devices: tuple[Mapping[str, Any], ...] = ()
    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "torchVersion": self.torch_version,
            "cudaAvailable": self.cuda_available,
            "cudaBuildVersion": self.cuda_build_version,
            "mpsAvailable": self.mps_available,
            "devices": [dict(device) for device in self.devices],
            "error": self.error,
        }


@dataclass(frozen=True)
class ProbeResult:
    ok: bool = True
    timed_out: bool = False
    error: str | None = None
    python: Mapping[str, Any] = field(default_factory=dict)
    modules: Mapping[str, ModuleProbe] = field(default_factory=dict)
    device: DeviceProbe | None = None

    def module(self, name: str) -> ModuleProbe:
        """The result for ``name``, or a synthesised failure.

        A probe that never ran is not evidence that a package is fine, so the
        caller gets an unimported result carrying the probe's own error rather
        than ``None`` to special-case.
        """

        found = self.modules.get(name)
        if found is not None:
            return found
        return ModuleProbe(
            name=name,
            imported=False,
            error=self.error or "The import probe did not report on this module",
            error_type="ProbeUnavailable",
        )


def _decode_result(stdout: str) -> dict[str, Any] | None:
    """Pull our JSON line out of whatever the imports printed around it."""

    marker_at = stdout.rfind(RESULT_MARKER)
    if marker_at < 0:
        return None
    raw = stdout[marker_at + len(RESULT_MARKER) :].strip().splitlines()
    if not raw:
        return None
    try:
        decoded = json.loads(raw[0])
    except json.JSONDecodeError:
        return None
    return decoded if isinstance(decoded, dict) else None


def _module_from_payload(payload: Mapping[str, Any]) -> ModuleProbe:
    return ModuleProbe(
        name=str(payload.get("name", "")),
        imported=bool(payload.get("imported")),
        version=payload.get("version") or None,
        error=payload.get("error") or None,
        error_type=payload.get("errorType") or None,
        missing_module=payload.get("missingModule") or None,
    )


def _device_from_payload(payload: Mapping[str, Any]) -> DeviceProbe:
    devices = payload.get("devices")
    return DeviceProbe(
        torch_version=payload.get("torchVersion") or None,
        cuda_available=bool(payload.get("cudaAvailable")),
        cuda_build_version=payload.get("cudaBuildVersion") or None,
        mps_available=bool(payload.get("mpsAvailable")),
        devices=tuple(devices) if isinstance(devices, Sequence) else (),
        error=payload.get("error") or None,
    )


def run_probe(
    spec: ProbeSpec,
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> ProbeResult:
    """Run one probe subprocess. Never raises; failures come back as data."""

    executable = sys.executable
    if not executable:
        return ProbeResult(
            ok=False, error="No Python interpreter is available for probing"
        )

    try:
        completed = subprocess.run(
            # No -E/-I: the probe must see the same PYTHONPATH the serving
            # process was started with, or it reports imports as broken that
            # the real load path resolves fine.
            [executable, "-B", str(_WORKER_PATH)],
            input=json.dumps(spec.to_payload()),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return ProbeResult(
            ok=False,
            timed_out=True,
            error=f"The import probe timed out after {timeout:.0f}s",
        )
    except OSError as exc:
        return ProbeResult(ok=False, error=f"The import probe could not start ({exc})")

    payload = _decode_result(completed.stdout or "")
    if payload is None:
        detail = (completed.stderr or "").strip().splitlines()
        summary = detail[-1] if detail else f"exit code {completed.returncode}"
        return ProbeResult(
            ok=False,
            error=f"The import probe produced no result ({summary})",
        )

    modules_payload = payload.get("modules")
    modules: dict[str, ModuleProbe] = {}
    if isinstance(modules_payload, Mapping):
        for name, module_payload in modules_payload.items():
            if isinstance(module_payload, Mapping):
                modules[str(name)] = _module_from_payload(module_payload)

    device_payload = payload.get("device")
    device = (
        _device_from_payload(device_payload)
        if isinstance(device_payload, Mapping)
        else None
    )
    python = payload.get("python")

    return ProbeResult(
        ok=True,
        python=dict(python) if isinstance(python, Mapping) else {},
        modules=modules,
        device=device,
    )


_CACHE: dict[str, tuple[float, str, ProbeResult]] = {}
_CACHE_LOCK = threading.Lock()
_KEY_LOCKS: dict[str, threading.Lock] = {}


def _key_lock(cache_key: str) -> threading.Lock:
    with _CACHE_LOCK:
        return _KEY_LOCKS.setdefault(cache_key, threading.Lock())


def probe_environment(
    cache_key: str,
    spec: ProbeSpec,
    *,
    refresh: bool = False,
    ttl: float = PROBE_CACHE_TTL_SECONDS,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> ProbeResult:
    """Cached :func:`run_probe`, keyed by caller plus the spec it asked for."""

    fingerprint = spec.fingerprint()

    def cached_result() -> ProbeResult | None:
        with _CACHE_LOCK:
            cached = _CACHE.get(cache_key)
        if cached is None or cached[1] != fingerprint:
            return None
        if time.monotonic() - cached[0] >= ttl:
            return None
        return cached[2]

    if not refresh:
        hit = cached_result()
        if hit is not None:
            return hit

    # Single-flight per key: concurrent callers (four capability cards
    # rendering at once) must join one subprocess, not spawn four.
    with _key_lock(cache_key):
        if not refresh:
            hit = cached_result()
            if hit is not None:
                return hit
        result = run_probe(spec, timeout=timeout)
        with _CACHE_LOCK:
            _CACHE[cache_key] = (time.monotonic(), fingerprint, result)
        return result


def cached_probe(cache_key: str, spec: ProbeSpec) -> ProbeResult | None:
    """The last probe result for this key, or ``None`` — never a subprocess.

    For callers that must stay cheap no matter what. ``/app/status`` is polled
    on startup and cannot afford to spawn interpreters, but it can honestly use
    an answer the diagnostics view already paid for.

    Age deliberately does not disqualify a result. The TTL means "this is worth
    re-running", not "forget what was observed": expiring the evidence would
    make an installed-but-unimportable package flip back to looking fine every
    sixty seconds. Only a spec change discards a result, because then the
    cached answer is to a different question.
    """

    fingerprint = spec.fingerprint()
    with _CACHE_LOCK:
        cached = _CACHE.get(cache_key)
    if cached is None or cached[1] != fingerprint:
        return None
    return cached[2]


def invalidate_probe_cache(cache_key: str | None = None) -> None:
    with _CACHE_LOCK:
        if cache_key is None:
            _CACHE.clear()
        else:
            _CACHE.pop(cache_key, None)
