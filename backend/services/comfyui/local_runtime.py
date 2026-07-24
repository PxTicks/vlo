"""Discovery, installation, and launching for a local ComfyUI checkout."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Literal, TypedDict
from urllib.parse import urlparse

from config import RUNTIME_ROOT

COMFYUI_REPOSITORY_URL = "https://github.com/Comfy-Org/ComfyUI.git"
_MAIN_SOURCE_LIMIT_BYTES = 256 * 1024
_SOURCE_MARKERS = {
    "argument parser": re.compile(
        r"(?:from\s+comfy\.cli_args\s+import|comfy\.options\.enable_args_parsing)"
    ),
    "prompt server": re.compile(r"(?:server\.)?PromptServer"),
    "execution engine": re.compile(r"(?:import\s+execution|execution\.PromptExecutor)"),
}
_LAYOUT_MARKERS = ("comfy", "nodes.py", "server.py", "folder_paths.py")
_VERIFICATION_CACHE_LOCK = threading.Lock()
_VERIFICATION_CACHE: dict[str, ComfyuiInstallVerification] = {}
_DIRECTORY_PICKER_LOCK = threading.Lock()
_DIRECTORY_PICKER_TIMEOUT_SECONDS = 5 * 60

InstallPhase = Literal[
    "idle",
    "cloning",
    "creating_environment",
    "installing_requirements",
    "complete",
    "failed",
]


class ComfyuiInstallVerification(TypedDict):
    requestedPath: str
    installPath: str | None
    valid: bool
    mainPyPresent: bool
    sourceMarkers: list[str]
    layoutMarkers: list[str]
    warnings: list[str]


class ComfyuiInstallStatus(TypedDict):
    phase: InstallPhase
    running: bool
    targetPath: str | None
    message: str | None
    error: str | None


class DirectoryPickerBusyError(RuntimeError):
    """Raised when a second native picker is requested while one is open."""


class ComfyuiPythonEnvironmentRequired(ValueError):
    """Raised when launching would otherwise silently use vlo's interpreter."""


def _copy_verification(
    verification: ComfyuiInstallVerification,
) -> ComfyuiInstallVerification:
    return {
        **verification,
        "sourceMarkers": list(verification["sourceMarkers"]),
        "layoutMarkers": list(verification["layoutMarkers"]),
        "warnings": list(verification["warnings"]),
    }


def _cache_verification(
    verification: ComfyuiInstallVerification,
) -> ComfyuiInstallVerification:
    keys = [verification["requestedPath"]]
    if verification["installPath"]:
        keys.append(verification["installPath"])
    with _VERIFICATION_CACHE_LOCK:
        for key in keys:
            _VERIFICATION_CACHE[str(Path(key).expanduser())] = _copy_verification(
                verification
            )
    return verification


def get_cached_comfyui_install_verification(
    path: str | Path,
) -> ComfyuiInstallVerification | None:
    """Return prior verification metadata without touching the filesystem."""

    key = str(Path(path).expanduser())
    with _VERIFICATION_CACHE_LOCK:
        verification = _VERIFICATION_CACHE.get(key)
        return _copy_verification(verification) if verification else None


def _candidate_install_paths(path: Path) -> list[Path]:
    expanded = path.expanduser()
    candidates = [expanded]
    nested = expanded / "ComfyUI"
    if nested != expanded:
        candidates.append(nested)
    return candidates


def verify_comfyui_install(path: str | Path) -> ComfyuiInstallVerification:
    """Lightly identify an official-style checkout without importing its code."""

    requested = Path(path).expanduser()
    install_path = next(
        (
            candidate
            for candidate in _candidate_install_paths(requested)
            if (candidate / "main.py").is_file()
        ),
        None,
    )
    if install_path is None:
        return _cache_verification({
            "requestedPath": str(requested),
            "installPath": None,
            "valid": False,
            "mainPyPresent": False,
            "sourceMarkers": [],
            "layoutMarkers": [],
            "warnings": ["main.py was not found in this folder or its ComfyUI subfolder."],
        })

    layout_markers = [
        marker for marker in _LAYOUT_MARKERS if (install_path / marker).exists()
    ]
    source_markers: list[str] = []
    warnings: list[str] = []
    try:
        source = (install_path / "main.py").read_text(
            encoding="utf-8",
            errors="ignore",
        )[:_MAIN_SOURCE_LIMIT_BYTES]
        source_markers = [
            label for label, pattern in _SOURCE_MARKERS.items() if pattern.search(source)
        ]
    except OSError as exc:
        warnings.append(f"main.py could not be read: {exc}")

    valid = len(layout_markers) >= 3 and len(source_markers) >= 1
    if len(layout_markers) < 3:
        warnings.append(
            "Expected ComfyUI files such as nodes.py, server.py, and folder_paths.py were not found."
        )
    if not source_markers:
        warnings.append("main.py did not contain a recognized ComfyUI entry-point marker.")

    return _cache_verification({
        "requestedPath": str(requested),
        "installPath": str(install_path.resolve()),
        "valid": valid,
        "mainPyPresent": True,
        "sourceMarkers": source_markers,
        "layoutMarkers": layout_markers,
        "warnings": warnings,
    })


def pick_directory(title: str) -> str | None:
    """Show the host OS directory picker used by the local-only desktop workflow."""

    if not _DIRECTORY_PICKER_LOCK.acquire(blocking=False):
        raise DirectoryPickerBusyError("A directory picker is already open")
    try:
        try:
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).with_name("directory_picker.py")),
                    title,
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=_DIRECTORY_PICKER_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(
                "The native directory picker timed out and was closed."
            ) from exc
        if result.returncode != 0:
            reason = result.stderr.strip()
            raise RuntimeError(
                "The native directory picker could not open. "
                "Enter the path manually in Runtime Settings."
                + (f" ({reason})" if reason else "")
            )
        try:
            selected = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                "The native directory picker returned an invalid result."
            ) from exc
        if selected is None:
            return None
        if not isinstance(selected, str):
            raise RuntimeError("The native directory picker returned an invalid path.")
        return str(Path(selected).resolve())
    finally:
        _DIRECTORY_PICKER_LOCK.release()


def _environment_python(
    install_path: Path,
    *,
    platform_name: str | None = None,
) -> Path | None:
    resolved_platform = platform_name or os.name
    binary = (
        Path("Scripts") / "python.exe"
        if resolved_platform == "nt"
        else Path("bin") / "python"
    )
    candidates = [
        install_path / environment / binary
        for environment in (".venv", "venv", "env")
    ]
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def _managed_venv_python(install_path: Path) -> Path:
    binary = (
        Path("Scripts") / "python.exe"
        if os.name == "nt"
        else Path("bin") / "python"
    )
    return install_path / ".venv" / binary


def _portable_python(install_path: Path) -> Path | None:
    candidates = [
        install_path.parent / "python_embeded" / "python.exe",
        install_path / "python_embeded" / "python.exe",
    ]
    return next((candidate for candidate in candidates if candidate.is_file()), None)


class ComfyuiLocalRuntime:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._install_status: ComfyuiInstallStatus = {
            "phase": "idle",
            "running": False,
            "targetPath": None,
            "message": None,
            "error": None,
        }
        self._process: subprocess.Popen[bytes] | None = None

    def get_install_status(self) -> ComfyuiInstallStatus:
        with self._lock:
            return dict(self._install_status)

    def _set_install_status(
        self,
        *,
        phase: InstallPhase,
        running: bool,
        target_path: Path,
        message: str | None = None,
        error: str | None = None,
    ) -> None:
        with self._lock:
            self._install_status = {
                "phase": phase,
                "running": running,
                "targetPath": str(target_path),
                "message": message,
                "error": error,
            }

    def start_install(self, parent_path: str | Path) -> ComfyuiInstallStatus:
        parent = Path(parent_path).expanduser().resolve()
        if not parent.is_dir():
            raise ValueError("The selected installation parent directory does not exist")

        target = parent if parent.name.casefold() == "comfyui" else parent / "ComfyUI"
        if target.exists() and not target.is_dir():
            raise ValueError("The ComfyUI destination exists and is not a directory")
        if target.exists() and any(target.iterdir()):
            verification = verify_comfyui_install(target)
            if verification["valid"]:
                raise ValueError(
                    "ComfyUI is already installed there. Choose it as an existing install instead."
                )
            raise ValueError("The ComfyUI destination exists and is not empty")

        with self._lock:
            if self._install_status["running"]:
                raise RuntimeError("A ComfyUI installation is already running")
            self._install_status = {
                "phase": "cloning",
                "running": True,
                "targetPath": str(target),
                "message": "Cloning ComfyUI…",
                "error": None,
            }

        thread = threading.Thread(
            target=self._install_worker,
            args=(target,),
            name="vlo-comfyui-installer",
            daemon=True,
        )
        thread.start()
        return self.get_install_status()

    def start_environment_setup(
        self,
        install_path: str | Path,
    ) -> ComfyuiInstallStatus:
        verification = verify_comfyui_install(install_path)
        if not verification["valid"] or not verification["installPath"]:
            raise ValueError("A verified ComfyUI checkout is required")
        target = Path(verification["installPath"])

        with self._lock:
            if self._install_status["running"]:
                raise RuntimeError("A ComfyUI installation task is already running")
            self._install_status = {
                "phase": "creating_environment",
                "running": True,
                "targetPath": str(target),
                "message": "Creating a managed environment for the existing checkout…",
                "error": None,
            }

        thread = threading.Thread(
            target=self._install_worker,
            args=(target, False, "The managed ComfyUI environment is ready."),
            name="vlo-comfyui-environment-installer",
            daemon=True,
        )
        thread.start()
        return self.get_install_status()

    def _run_install_command(self, command: list[str], cwd: Path | None = None) -> None:
        subprocess.run(
            command,
            cwd=cwd,
            check=True,
            stdin=subprocess.DEVNULL,
        )

    def _install_worker(
        self,
        target: Path,
        clone_checkout: bool = True,
        completion_message: str = "ComfyUI is installed and ready to launch.",
    ) -> None:
        try:
            if clone_checkout:
                self._run_install_command(
                    [
                        "git",
                        "clone",
                        "--depth",
                        "1",
                        COMFYUI_REPOSITORY_URL,
                        str(target),
                    ]
                )
            self._set_install_status(
                phase="creating_environment",
                running=True,
                target_path=target,
                message="Creating a dedicated Python environment…",
            )
            self._run_install_command([sys.executable, "-m", "venv", str(target / ".venv")])
            python = _managed_venv_python(target)
            self._set_install_status(
                phase="installing_requirements",
                running=True,
                target_path=target,
                message="Installing ComfyUI requirements…",
            )
            self._run_install_command(
                [str(python), "-m", "pip", "install", "--upgrade", "pip"],
                cwd=target,
            )
            self._run_install_command(
                [str(python), "-m", "pip", "install", "-r", "requirements.txt"],
                cwd=target,
            )

            verification = verify_comfyui_install(target)
            if not verification["valid"]:
                raise RuntimeError("The installed checkout did not pass ComfyUI verification")

            from services.runtime_settings import update_runtime_settings

            update_runtime_settings(
                comfyui_install_dir=verification["installPath"],
                comfyui_install_dir_prompt_status="accepted",
            )
            self._set_install_status(
                phase="complete",
                running=False,
                target_path=target,
                message=completion_message,
            )
        except (OSError, subprocess.SubprocessError, RuntimeError, ValueError) as exc:
            self._set_install_status(
                phase="failed",
                running=False,
                target_path=target,
                error=str(exc),
                message="ComfyUI installation failed.",
            )

    def launch(
        self,
        install_path: str | Path,
        comfyui_url: str,
        *,
        python_path: str | Path | None = None,
        use_system_python: bool = False,
    ) -> dict[str, Any]:
        verification = verify_comfyui_install(install_path)
        if not verification["valid"] or not verification["installPath"]:
            raise ValueError("The configured directory is not a recognized ComfyUI install")
        resolved = Path(verification["installPath"])

        with self._lock:
            if self._process is not None and self._process.poll() is None:
                return {"started": False, "alreadyRunning": True, "pid": self._process.pid}

        parsed_url = urlparse(comfyui_url)
        if parsed_url.scheme != "http":
            raise ValueError("Launching local ComfyUI requires an http URL")
        if parsed_url.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("A local ComfyUI install can only be launched for a local URL")
        port = parsed_url.port or 8188

        if python_path is not None and use_system_python:
            raise ValueError("Choose either a Python executable or the system Python")

        portable_python = _portable_python(resolved)
        if python_path is not None:
            python = Path(python_path).expanduser()
            if not python.is_file():
                raise ValueError("The selected Python executable does not exist")
            python = python.resolve()
        elif use_system_python:
            python = Path(sys.executable)
        else:
            python = _environment_python(resolved) or portable_python
            if python is None:
                raise ComfyuiPythonEnvironmentRequired(
                    "No ComfyUI Python environment was found"
                )

        command = [str(python)]
        uses_portable_python = portable_python is not None and python == portable_python
        if uses_portable_python:
            command.append("-s")
        command.extend(
            [
                str(resolved / "main.py"),
                "--port",
                str(port),
                "--disable-auto-launch",
            ]
        )
        if uses_portable_python:
            command.append("--windows-standalone-build")
        log_path = RUNTIME_ROOT / "comfyui.log"
        log_handle = log_path.open("ab")
        popen_kwargs: dict[str, Any] = {
            "cwd": resolved,
            "stdin": subprocess.DEVNULL,
            "stdout": log_handle,
            "stderr": subprocess.STDOUT,
        }
        if os.name == "nt":
            popen_kwargs["creationflags"] = (
                subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
            )
        else:
            popen_kwargs["start_new_session"] = True

        try:
            process = subprocess.Popen(command, **popen_kwargs)
        finally:
            log_handle.close()
        with self._lock:
            self._process = process
        return {
            "started": True,
            "alreadyRunning": False,
            "pid": process.pid,
            "logPath": str(log_path),
        }


comfyui_local_runtime = ComfyuiLocalRuntime()
