#!/usr/bin/env python3
"""Decide whether this machine may install SageAttention 2.x.

Run this with the selected ComfyUI environment's interpreter;
``install_sageattention.py`` consumes the ``KEY=VALUE`` lines on stdout.

Exit codes:
    0  supported -- the caller may build and install SageAttention
    2  unsupported -- a ``REASON`` line explains why (never a hard failure)
    1  internal error

The rules come from docs/sageattention-install-policy.md: SageAttention 2.x is
an NVIDIA-CUDA source package that only builds for compute capability 8.0+,
needs the CUDA Toolkit (``nvcc``), and is not supported upstream on AMD, Intel
or (as a stable contract) Windows.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

# PyTorch minor release -> Triton minor line. Taken from the triton-windows
# compatibility table; upstream Linux Triton shares the version numbering.
TORCH_TRITON_LINE = {
    (2, 4): "3.1",
    (2, 5): "3.1",
    (2, 6): "3.2",
    (2, 7): "3.3",
    (2, 8): "3.4",
    (2, 9): "3.5",
    (2, 10): "3.6",
    (2, 11): "3.6",
    (2, 12): "3.7",
    (2, 13): "3.7",
}

NVCC_RELEASE = re.compile(r"release (\d+)\.(\d+)")

# Compute capabilities SageAttention v2.2.0 emits `-gencode` flags for. This
# mirrors setup.py at the pinned commit, which declares the same set but never
# enforces it: an architecture outside it is silently skipped, so the build
# succeeds and then ships no kernels for the GPU. Gate on it here instead.
SUPPORTED_ARCHS = {(8, 0), (8, 6), (8, 9), (9, 0), (12, 0)}


def emit(key: str, value: object) -> None:
    print(f"{key}={value}", flush=True)


def unsupported(reason: str, hint: str | None = None) -> NoReturn:
    emit("REASON", reason)
    if hint:
        emit("HINT", hint)
    raise SystemExit(2)


def required_toolkit(major: int, minor: int) -> tuple[int, int]:
    """Minimum CUDA Toolkit per architecture, mirroring the pinned setup.py."""
    if (major, minor) == (12, 0):
        return (12, 8)  # Blackwell / SageAttention2++
    if (major, minor) == (9, 0):
        return (12, 3)  # Hopper FP8
    if (major, minor) == (8, 9):
        return (12, 4)  # Ada FP8
    return (12, 0)  # Ampere


def parse_version(text: str) -> tuple[int, ...]:
    parts: list[int] = []
    for chunk in text.split("."):
        match = re.match(r"\d+", chunk)
        if not match:
            break
        parts.append(int(match.group()))
    return tuple(parts)


def cuda_versions_are_compatible(
    toolkit: tuple[int, int], torch_cuda: str | None
) -> bool:
    """PyTorch rejects extension builds across CUDA major versions."""
    parsed_torch = parse_version(str(torch_cuda))[:2]
    return bool(parsed_torch) and toolkit[0] == parsed_torch[0]


def expected_triton_line(torch_version: str) -> str | None:
    return TORCH_TRITON_LINE.get(parse_version(torch_version)[:2])


def triton_matches_line(triton_version: str, line: str) -> bool:
    return parse_version(triton_version)[:2] == parse_version(line)


def find_nvcc() -> tuple[Path, Path] | None:
    """Resolve nvcc the same way SageAttention's build does (torch's CUDA_HOME)."""
    exe = "nvcc.exe" if os.name == "nt" else "nvcc"
    try:
        from torch.utils.cpp_extension import CUDA_HOME
    except Exception:
        CUDA_HOME = None
    if CUDA_HOME:
        candidate = Path(CUDA_HOME) / "bin" / exe
        if candidate.is_file():
            return candidate, Path(CUDA_HOME)
    found = shutil.which("nvcc")
    if not found:
        return None
    resolved = Path(found).resolve()
    return resolved, resolved.parent.parent


def nvcc_version(nvcc: Path) -> tuple[int, int] | None:
    try:
        output = subprocess.run(
            [str(nvcc), "-V"], capture_output=True, text=True, timeout=60
        ).stdout
    except Exception:
        return None
    match = NVCC_RELEASE.search(output)
    if not match:
        return None
    return (int(match.group(1)), int(match.group(2)))


def main() -> int:
    emit("PLATFORM", "windows" if sys.platform == "win32" else sys.platform)
    # Upstream still carries Windows/MSVC build fixes as open pull requests, so
    # Windows is not a stable source-build contract. The caller decides whether
    # to let the user opt in anyway.
    emit("UPSTREAM_SUPPORTED", 0 if sys.platform == "win32" else 1)

    try:
        import torch
    except Exception as exc:
        unsupported(
            f"PyTorch is not importable in the selected ComfyUI environment ({exc})",
            "Ensure the selected ComfyUI environment contains CUDA-enabled PyTorch.",
        )

    emit("TORCH_VERSION", torch.__version__)
    emit("TORCH_CUDA", torch.version.cuda)

    if getattr(torch.version, "hip", None):
        unsupported(
            "this is a ROCm/HIP PyTorch build and upstream SageAttention has no "
            "released AMD support"
        )
    if not torch.cuda.is_available():
        unsupported(
            "PyTorch cannot see a usable CUDA GPU",
            "Check the NVIDIA driver and ensure the selected ComfyUI environment "
            "contains CUDA-enabled PyTorch.",
        )

    count = torch.cuda.device_count()
    caps = [torch.cuda.get_device_capability(i) for i in range(count)]
    names = [torch.cuda.get_device_name(i) for i in range(count)]
    for name, (major, minor) in zip(names, caps):
        emit("GPU", f"{name} (compute capability {major}.{minor})")

    # Every visible GPU has to be a build target, not just the first one: a
    # machine that also holds an unbuildable card would run kernels that were
    # never compiled as soon as work was scheduled onto it.
    unbuildable = [
        f"{n} (CC {a}.{b})"
        for n, (a, b) in zip(names, caps)
        if (a, b) not in SUPPORTED_ARCHS
    ]
    if unbuildable:
        supported = ", ".join(f"{a}.{b}" for a, b in sorted(SUPPORTED_ARCHS))
        unsupported(
            "SageAttention 2.x builds only for compute capability "
            f"{supported}; cannot use " + ", ".join(unbuildable),
            "Set CUDA_VISIBLE_DEVICES to only the supported GPUs and re-run "
            "the installer if the machine has some.",
        )

    arch_list = ";".join(sorted({f"{a}.{b}" for a, b in caps}))
    emit("ARCH_LIST", arch_list)
    emit("MIN_CC", min(10 * a + b for a, b in caps))

    toolkit_min = max(required_toolkit(a, b) for a, b in caps)
    emit("CUDA_TOOLKIT_MIN", f"{toolkit_min[0]}.{toolkit_min[1]}")

    nvcc_result = find_nvcc()
    if nvcc_result is None:
        unsupported(
            "the CUDA Toolkit compiler (nvcc) was not found; SageAttention 2.x "
            "is built from source and needs it",
            "Install the CUDA Toolkit "
            f"{toolkit_min[0]}.{toolkit_min[1]} or newer, or set CUDA_HOME, "
            "then re-run the installer.",
        )
    nvcc, cuda_home = nvcc_result
    emit("NVCC", nvcc)
    # The source build consumes torch's CUDA_HOME rather than the PATH lookup.
    # The caller exports this value so a stale CUDA_HOME cannot pass preflight
    # with one nvcc and then build with another.
    emit("CUDA_HOME", cuda_home)

    version = nvcc_version(nvcc)
    if version is None:
        unsupported(f"could not read a CUDA release version from {nvcc} -V")
    emit("NVCC_VERSION", f"{version[0]}.{version[1]}")
    if version < toolkit_min:
        unsupported(
            f"CUDA Toolkit {version[0]}.{version[1]} is older than the "
            f"{toolkit_min[0]}.{toolkit_min[1]} these GPUs need",
            "Upgrade the CUDA Toolkit and re-run the installer.",
        )

    torch_cuda = parse_version(str(torch.version.cuda))[:2]
    if not torch_cuda:
        unsupported("this PyTorch build does not report a CUDA runtime version")
    if not cuda_versions_are_compatible(version, torch.version.cuda):
        unsupported(
            f"CUDA Toolkit {version[0]}.{version[1]} cannot build extensions "
            f"for PyTorch CUDA {torch.version.cuda}",
            "Install an nvcc toolkit with the same CUDA major version as "
            "PyTorch, or install a PyTorch build matching the toolkit.",
        )

    if sys.platform != "win32":
        configured_cxx = os.environ.get("CXX", "").strip()
        compiler = (
            shutil.which(configured_cxx)
            if configured_cxx
            else shutil.which("c++") or shutil.which("g++")
        )
        if compiler is None:
            unsupported(
                "no C++ compiler was found; SageAttention contains native CUDA extensions",
                "Install a CUDA-compatible C++ compiler and re-run the installer.",
            )
        emit("CXX", compiler)

    line = expected_triton_line(torch.__version__)
    if line is None:
        unsupported(
            f"no Triton version is known to match PyTorch {torch.__version__}",
            "Install a supported PyTorch/Triton pair, then re-run the installer.",
        )

    try:
        import triton

        # No TRITON_SPEC line: the callers treat "absent" as "nothing to install",
        # and an empty value would not survive batch parsing on Windows.
        emit("TRITON_PRESENT", 1)
        emit("TRITON_VERSION", triton.__version__)
        if not triton_matches_line(triton.__version__, line):
            unsupported(
                f"Triton {triton.__version__} does not match the {line}.x line "
                f"required by PyTorch {torch.__version__}",
                "Install a matching PyTorch/Triton pair and re-run the installer.",
            )
    except Exception:
        emit("TRITON_PRESENT", 0)
        package = "triton-windows" if sys.platform == "win32" else "triton"
        emit("TRITON_SPEC", f"{package}~={line}.0")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover - defensive
        emit("REASON", f"preflight failed unexpectedly ({exc})")
        raise SystemExit(1)
