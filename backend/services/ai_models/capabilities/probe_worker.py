"""Standalone import/device probe, executed as a short-lived subprocess.

This file is deliberately self-contained: it is run as a script by
``subprocess_probe`` with the *backend interpreter* and must not import
anything from the backend, because the whole point is to find out what that
interpreter can and cannot import without dragging the answer into the serving
process. Optional ML packages hang, abort, or mutate global CUDA state on
import; here that only costs a throwaway process.

Protocol: a JSON spec on stdin, one result line on stdout prefixed with
``RESULT_MARKER``. The marker exists because imported libraries print banners
and warnings to stdout at will, so the parent cannot assume the whole stream is
ours.
"""

from __future__ import annotations

import json
import platform
import sys
import types
from importlib.machinery import ModuleSpec


RESULT_MARKER = "<<<VLO_PROBE_RESULT>>>"


def _stub_module(name: str) -> types.ModuleType:
    """A module that answers any attribute access with a dummy object.

    Used to stand in for optional accelerator shims (xformers, torchcodec) that
    the real load path also fakes. Without them ``import`` of a package that
    merely *references* those names would fail, and the probe would report a
    package as broken when the service imports it fine.
    """

    module = types.ModuleType(name)

    class _Dummy:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        def __call__(self, *_args: object, **_kwargs: object) -> "_Dummy":
            return self

    def __getattr__(attr: str) -> object:  # noqa: N807 - module protocol
        # Dunders must stay absent. Answering ``__file__`` with a dummy breaks
        # any code that introspects sys.modules — torch does exactly that while
        # registering fake ops, and inspect then calls ``.endswith`` on it.
        if attr.startswith("__") and attr.endswith("__"):
            raise AttributeError(attr)
        return _Dummy

    module.__getattr__ = __getattr__  # type: ignore[attr-defined]
    module.__spec__ = ModuleSpec(name, loader=None)
    module.__path__ = []  # type: ignore[attr-defined]
    return module


def _install_stubs(names: list[str]) -> list[str]:
    installed: list[str] = []
    for name in names:
        if name in sys.modules:
            continue
        try:
            __import__(name)
            continue
        except Exception:
            pass
        parts = name.split(".")
        for index in range(len(parts)):
            partial = ".".join(parts[: index + 1])
            if partial in sys.modules:
                continue
            module = _stub_module(partial)
            sys.modules[partial] = module
            if index > 0:
                parent = sys.modules[".".join(parts[:index])]
                setattr(parent, parts[index], module)
            installed.append(partial)
    return installed


def _distribution_version(distribution: str | None, module: object) -> str | None:
    if distribution:
        try:
            from importlib.metadata import version

            return version(distribution)
        except Exception:
            pass
    raw = getattr(module, "__version__", None)
    return str(raw) if isinstance(raw, str) else None


def _probe_module(spec: dict) -> dict:
    name = str(spec.get("name", ""))
    distribution = spec.get("distribution")
    result: dict = {
        "name": name,
        "imported": False,
        "version": None,
        "error": None,
        "errorType": None,
        "missingModule": None,
    }
    try:
        module = __import__(name)
    except BaseException as exc:  # noqa: BLE001 - a probe reports, never raises
        result["error"] = f"{exc}"
        result["errorType"] = type(exc).__name__
        # Only an ImportError's ``name`` is a module name. AttributeError also
        # carries ``name`` — the attribute that was missing — and reporting
        # that as "missing dependency: endswith" is worse than saying nothing.
        missing = getattr(exc, "name", None) if isinstance(exc, ImportError) else None
        result["missingModule"] = missing if isinstance(missing, str) else None
        return result

    result["imported"] = True
    result["version"] = _distribution_version(
        distribution if isinstance(distribution, str) else None, module
    )
    return result


def _probe_device() -> dict:
    device: dict = {
        "torchVersion": None,
        "cudaAvailable": False,
        "cudaBuildVersion": None,
        "mpsAvailable": False,
        "devices": [],
        "error": None,
    }
    try:
        import torch  # type: ignore
    except BaseException as exc:  # noqa: BLE001
        device["error"] = f"{exc}"
        return device

    device["torchVersion"] = str(getattr(torch, "__version__", "") or "") or None
    try:
        device["cudaBuildVersion"] = getattr(getattr(torch, "version", None), "cuda", None)
    except Exception:
        device["cudaBuildVersion"] = None

    try:
        device["cudaAvailable"] = bool(torch.cuda.is_available())
    except BaseException as exc:  # noqa: BLE001
        device["error"] = f"{exc}"

    if device["cudaAvailable"]:
        try:
            for index in range(torch.cuda.device_count()):
                properties = torch.cuda.get_device_properties(index)
                device["devices"].append(
                    {
                        "index": index,
                        "name": str(getattr(properties, "name", f"cuda:{index}")),
                        "totalMemoryMb": int(
                            getattr(properties, "total_memory", 0) // (1024 * 1024)
                        ),
                    }
                )
        except BaseException as exc:  # noqa: BLE001
            device["error"] = f"{exc}"

    try:
        backends = getattr(torch, "backends", None)
        mps = getattr(backends, "mps", None)
        device["mpsAvailable"] = bool(mps is not None and mps.is_available())
    except BaseException:  # noqa: BLE001
        device["mpsAvailable"] = False

    return device


def main() -> int:
    try:
        spec = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:  # pragma: no cover - malformed parent request
        sys.stdout.write(f"{RESULT_MARKER}{json.dumps({'error': str(exc)})}\n")
        return 2

    for entry in spec.get("extraSysPath") or []:
        if isinstance(entry, str) and entry and entry not in sys.path:
            sys.path.insert(0, entry)

    stubbed = _install_stubs(
        [name for name in (spec.get("stubModules") or []) if isinstance(name, str)]
    )

    payload = {
        "python": {
            "executable": sys.executable,
            "version": platform.python_version(),
            "versionInfo": list(sys.version_info[:3]),
            "prefix": sys.prefix,
            "basePrefix": getattr(sys, "base_prefix", sys.prefix),
            "implementation": platform.python_implementation(),
        },
        "stubbedModules": stubbed,
        "modules": {},
        "device": None,
    }

    for module_spec in spec.get("modules") or []:
        if not isinstance(module_spec, dict):
            continue
        result = _probe_module(module_spec)
        payload["modules"][result["name"]] = result

    if spec.get("device"):
        payload["device"] = _probe_device()

    sys.stdout.write(f"{RESULT_MARKER}{json.dumps(payload)}\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
