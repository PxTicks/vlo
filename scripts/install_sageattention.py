#!/usr/bin/env python3
"""Build and install pinned SageAttention into an explicit Python environment."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SAGE_REPOSITORY_URL = "https://github.com/thu-ml/SageAttention.git"
SAGE_TAG = "v2.2.0"
SAGE_COMMIT = "eb615cf6cf4d221338033340ee2de1c37fbdba4a"
BUILD_REQUIREMENTS = (
    "setuptools>=62,<75",
    "wheel>=0.38,<0.44",
    "packaging>=21,<24",
    "ninja",
)


def run(
    command: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        env=env,
        check=False,
        text=True,
        capture_output=capture,
    )


def parse_protocol(output: str) -> dict[str, list[str]]:
    values: dict[str, list[str]] = {}
    for line in output.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            values.setdefault(key, []).append(value)
    return values


def clone_verified_source(source_dir: Path) -> bool:
    if source_dir.exists():
        if not (source_dir / ".git").is_dir():
            print(f"FAIL: {source_dir} exists but is not a git checkout")
            return False
        result = run(
            ["git", "-C", str(source_dir), "rev-parse", "HEAD"], capture=True
        )
        if result.returncode != 0 or result.stdout.strip() != SAGE_COMMIT:
            print(
                f"FAIL: existing SageAttention checkout is not pinned commit {SAGE_COMMIT}; "
                "it was left unchanged"
            )
            return False
        print(f"Reusing verified SageAttention {SAGE_TAG} source.")
        return True

    source_dir.parent.mkdir(parents=True, exist_ok=True)
    temporary = source_dir.with_name(f".{source_dir.name}.cloning-{os.getpid()}")
    if temporary.exists():
        print(f"FAIL: temporary clone path already exists: {temporary}")
        return False
    result = run(
        [
            "git",
            "clone",
            "--depth",
            "1",
            "--branch",
            SAGE_TAG,
            SAGE_REPOSITORY_URL,
            str(temporary),
        ]
    )
    if result.returncode != 0:
        shutil.rmtree(temporary, ignore_errors=True)
        print("FAIL: could not clone SageAttention")
        return False
    head = run(
        ["git", "-C", str(temporary), "rev-parse", "HEAD"], capture=True
    ).stdout.strip()
    if head != SAGE_COMMIT:
        shutil.rmtree(temporary, ignore_errors=True)
        print(f"FAIL: tag resolved to {head or 'unknown'}, expected {SAGE_COMMIT}")
        return False
    temporary.rename(source_dir)
    print(f"Verified SageAttention commit {SAGE_COMMIT}.")
    return True


def build_python_path(venv: Path) -> Path:
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def target_python_path(value: str) -> Path:
    """Return an absolute path without dereferencing a virtualenv symlink."""
    return Path(os.path.abspath(os.path.expanduser(value)))


def query_site_packages(python: Path) -> list[str]:
    result = run(
        [
            str(python),
            "-c",
            "import json, site; print(json.dumps(site.getsitepackages()))",
        ],
        capture=True,
    )
    if result.returncode != 0:
        raise RuntimeError("could not resolve target environment site-packages")
    payload = json.loads(result.stdout)
    if not isinstance(payload, list) or not all(isinstance(item, str) for item in payload):
        raise RuntimeError("target environment returned invalid site-packages")
    return payload


def create_build_environment(target_python: Path, directory: Path) -> Path:
    result = run([str(target_python), "-m", "venv", str(directory)])
    if result.returncode != 0:
        raise RuntimeError("could not create the temporary build environment")
    python = build_python_path(directory)
    install = run([str(python), "-m", "pip", "install", *BUILD_REQUIREMENTS])
    if install.returncode != 0:
        raise RuntimeError("could not install pinned SageAttention build dependencies")

    build_sites = query_site_packages(python)
    target_sites = query_site_packages(target_python)
    Path(build_sites[0], "vlo-sageattention-target.pth").write_text(
        "".join(f"{path}\n" for path in target_sites), encoding="utf-8"
    )
    return python


def installed_version(target_python: Path, distribution: str) -> str | None:
    result = run(
        [
            str(target_python),
            "-c",
            "from importlib.metadata import version; print(version(" + repr(distribution) + "))",
        ],
        capture=True,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def cleanup_target(target_python: Path, *, triton_package: str | None) -> None:
    run([str(target_python), "-m", "pip", "uninstall", "-y", "sageattention"])
    if triton_package:
        run(
            [
                str(target_python),
                "-m",
                "pip",
                "uninstall",
                "-y",
                triton_package,
            ]
        )


def install(args: argparse.Namespace) -> int:
    root = Path(__file__).resolve().parents[1]
    # Keep a venv's interpreter path intact. Resolving its `python` symlink to
    # the base interpreter silently drops the target environment's packages.
    target_python = target_python_path(args.python)
    if not target_python.is_file():
        print(f"FAIL: Python executable does not exist: {target_python}")
        return 1
    if sys.platform == "win32" and not args.allow_unsupported_windows:
        print("SKIP: upstream SageAttention does not support Windows source builds")
        return 2
    if shutil.which("git") is None:
        print("SKIP: git is required to fetch SageAttention")
        return 2

    preflight = run(
        [str(target_python), str(root / "scripts/sageattention_preflight.py")],
        capture=True,
    )
    sys.stdout.write(preflight.stdout)
    if preflight.stderr:
        sys.stderr.write(preflight.stderr)
    if preflight.returncode != 0:
        return preflight.returncode
    protocol = parse_protocol(preflight.stdout)
    required = ("ARCH_LIST", "CUDA_HOME", "TRITON_PRESENT")
    if any(not protocol.get(key) for key in required):
        print("FAIL: SageAttention preflight returned incomplete build information")
        return 1

    existing_sageattention = installed_version(target_python, "sageattention")
    if existing_sageattention == "2.2.0":
        smoke = run(
            [str(target_python), str(root / "scripts/sageattention_smoketest.py")]
        )
        if smoke.returncode == 0:
            print(f"SageAttention {SAGE_TAG} is already installed and verified.")
            return 0
        print("Existing SageAttention 2.2.0 failed verification; rebuilding it.")
    elif existing_sageattention is not None:
        print(
            f"FAIL: SageAttention {existing_sageattention} is already installed; "
            "leaving it unchanged"
        )
        return 1

    source_dir = (
        Path(args.source_dir).expanduser().resolve()
        if args.source_dir
        else root / "backend/sageattention-src" / SAGE_COMMIT
    )
    if not clone_verified_source(source_dir):
        return 1

    installed_triton_package: str | None = None
    triton_present = protocol["TRITON_PRESENT"][-1] == "1"
    triton_specs = protocol.get("TRITON_SPEC", [])
    if not triton_present:
        if not triton_specs:
            print("FAIL: preflight did not provide a compatible Triton package")
            return 1
        result = run(
            [
                str(target_python),
                "-m",
                "pip",
                "install",
                "--no-deps",
                triton_specs[-1],
            ]
        )
        if result.returncode != 0:
            print("FAIL: compatible Triton installation failed")
            return 1
        installed_triton_package = triton_specs[-1].partition("~=")[0]

    build_env = os.environ.copy()
    build_env.update(
        {
            "CUDA_HOME": protocol["CUDA_HOME"][-1],
            "TORCH_CUDA_ARCH_LIST": protocol["ARCH_LIST"][-1],
            "EXT_PARALLEL": os.environ.get("EXT_PARALLEL", "1"),
            "MAX_JOBS": os.environ.get(
                "MAX_JOBS", str(max(1, min(4, os.cpu_count() or 1)))
            ),
        }
    )

    try:
        with tempfile.TemporaryDirectory(prefix="vlo-sageattention-build-") as temp:
            temporary = Path(temp)
            build_python = create_build_environment(
                target_python, temporary / "build-venv"
            )
            wheel_dir = temporary / "wheel"
            wheel_dir.mkdir()
            build = run(
                [
                    str(build_python),
                    "-m",
                    "pip",
                    "wheel",
                    "--no-deps",
                    "--no-build-isolation",
                    "--wheel-dir",
                    str(wheel_dir),
                    str(source_dir),
                ],
                env=build_env,
            )
            if build.returncode != 0:
                raise RuntimeError("SageAttention wheel build failed")
            wheels = sorted(wheel_dir.glob("sageattention-*.whl"))
            if len(wheels) != 1:
                raise RuntimeError("the build did not produce exactly one SageAttention wheel")
            installed = run(
                [
                    str(target_python),
                    "-m",
                    "pip",
                    "install",
                    "--no-deps",
                    "--force-reinstall",
                    str(wheels[0]),
                ]
            )
            if installed.returncode != 0:
                raise RuntimeError("the SageAttention wheel could not be installed")

        smoke = run(
            [str(target_python), str(root / "scripts/sageattention_smoketest.py")]
        )
        if smoke.returncode != 0:
            raise RuntimeError("SageAttention failed its GPU smoke test")
    except (OSError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"FAIL: {exc}")
        cleanup_target(target_python, triton_package=installed_triton_package)
        return 1

    print(f"SageAttention {SAGE_TAG} installed into {target_python}.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True, help="target ComfyUI Python")
    parser.add_argument("--source-dir")
    parser.add_argument("--allow-unsupported-windows", action="store_true")
    return install(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
