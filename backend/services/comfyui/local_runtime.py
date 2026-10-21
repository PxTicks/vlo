"""Discovery, installation, and launching for a local ComfyUI checkout."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, TypedDict
from urllib.parse import urlparse

import httpx

from config import RUNTIME_ROOT
from services.comfyui.frontend_settings import seed_managed_frontend_settings
from services.comfyui.install_layout import resolve_comfyui_install_path
from services.comfyui.install_output import InstallOutputTracker
from services.comfyui.managed_install import (
    find_managed_node_pack,
    record_managed_node_pack,
)
from services.comfyui.node_pack_versions import inspect_comfyui_vlo

logger = logging.getLogger(__name__)

COMFYUI_REPOSITORY_URL = "https://github.com/Comfy-Org/ComfyUI.git"
# WanVideoWrapper remains documented for legacy workflows but is intentionally
# omitted because those workflows are being replaced.
MANAGED_CUSTOM_NODE_REPOSITORY_URLS = (
    "https://github.com/Lightricks/ComfyUI-LTXVideo",
    "https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3",
    "https://github.com/PxTicks/ComfyUI-vlo",
    "https://github.com/Fannovel16/comfyui_controlnet_aux",
    "https://github.com/kijai/ComfyUI-GIMM-VFI",
    "https://github.com/kosinkadink/ComfyUI-VideoHelperSuite",
    "https://github.com/kijai/ComfyUI-KJNodes",
)
# ComfyUI's requirements.txt takes torch from PyPI, whose Windows wheels are
# CPU-only, and ComfyUI does not fall back to the CPU: without a CUDA build it
# dies at import with "Torch not compiled with CUDA enabled". Windows installs
# therefore always take torch from the dedicated index. Linux PyPI wheels
# already bundle CUDA, and macOS has no CUDA builds at all.
TORCH_CUDA_INDEX_URL = "https://download.pytorch.org/whl/cu130"
TORCH_CUDA_PACKAGES = ("torch", "torchvision", "torchaudio")
# Extras vlo passes when it launches ComfyUI itself: the bundled manager, and
# latent2rgb previews so sampling streams useful progress frames without an
# additional preview model.
# `--enable-manager` is recent, so each flag is only passed when the checkout's
# parser advertises it — argparse aborts startup on an unknown argument.
MANAGER_REQUIREMENTS_FILENAME = "manager_requirements.txt"
OPTIONAL_LAUNCH_ARGUMENTS: tuple[tuple[str, ...], ...] = (
    ("--enable-manager",),
    ("--preview-method", "latent2rgb"),
)
_CLI_ARGS_SOURCE_LIMIT_BYTES = 128 * 1024
_GIT_REQUIRED_MESSAGE = (
    "git is required to install ComfyUI and its custom nodes. Install it from "
    "https://git-scm.com/downloads, then restart vlo so it picks up the new PATH."
)
_TORCH_CUDA_CHECK_SOURCE = (
    "import sys, torch; sys.exit(0 if torch.version.cuda else 1)"
)
# Importing torch cold on Windows can take a while; this only bounds a hang.
_TORCH_CUDA_CHECK_TIMEOUT_SECONDS = 5 * 60
_CPU_TORCH_ERROR = (
    "The ComfyUI environment ended up with a PyTorch build without CUDA, and "
    f"reinstalling torch, torchvision and torchaudio from {TORCH_CUDA_INDEX_URL} "
    "did not fix it. ComfyUI cannot start without a CUDA build."
)
_MAIN_SOURCE_LIMIT_BYTES = 256 * 1024
_SOURCE_MARKERS = {
    "argument parser": re.compile(
        r"(?:from\s+comfy\.cli_args\s+import|comfy\.options\.enable_args_parsing)"
    ),
    "prompt server": re.compile(r"(?:server\.)?PromptServer"),
    "execution engine": re.compile(r"(?:import\s+execution|execution\.PromptExecutor)"),
}
_LAYOUT_MARKERS = ("comfy", "nodes.py", "server.py", "folder_paths.py")
# Enough of the log to show why a launch died (the traceback tail) without
# shipping a large custom-node import dump on every status poll.
_LAUNCH_LOG_TAIL_BYTES = 16 * 1024
_LAUNCH_LOG_TAIL_LINES = 20
# How long ComfyUI gets to exit after SIGTERM before it is killed. It holds no
# state worth a long wait: queued prompts are lost either way.
_COMFYUI_STOP_TIMEOUT_SECONDS = 15
_GIT_QUERY_TIMEOUT_SECONDS = 60
# ComfyUI colours its log levels even when writing to a file.
_ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_VERIFICATION_CACHE_LOCK = threading.Lock()
_VERIFICATION_CACHE: dict[str, ComfyuiInstallVerification] = {}
_DIRECTORY_PICKER_LOCK = threading.Lock()
_DIRECTORY_PICKER_TIMEOUT_SECONDS = 5 * 60
# `--progress-bar raw` arrived in pip 24.1. Older pips reject the value, even
# from the environment, and fail the whole command.
_PIP_RAW_PROGRESS_MIN_VERSION = (24, 1)
_PIP_VERSION_CHECK_TIMEOUT_SECONDS = 60

InstallPhase = Literal[
    "idle",
    "cloning",
    "creating_environment",
    "installing_requirements",
    "updating_nodes",
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


LaunchState = Literal["idle", "running", "exited"]


class ComfyuiLaunchStatus(TypedDict):
    state: LaunchState
    pid: int | None
    exitCode: int | None
    logPath: str | None
    logTail: list[str]


class ComfyuiInstallStatus(TypedDict):
    phase: InstallPhase
    running: bool
    targetPath: str | None
    message: str | None
    error: str | None
    # The latest line the running install command printed, so a long step
    # visibly moves.
    logLine: str | None


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


def verify_comfyui_install(path: str | Path) -> ComfyuiInstallVerification:
    """Lightly identify an official-style checkout without importing its code."""

    requested = Path(path).expanduser()
    install_path = resolve_comfyui_install_path(requested)
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


def _supported_launch_arguments(install_path: Path) -> list[str]:
    """Keep only the extra launch flags this checkout's parser understands."""

    try:
        source = (install_path / "comfy" / "cli_args.py").read_text(
            encoding="utf-8",
            errors="ignore",
        )[:_CLI_ARGS_SOURCE_LIMIT_BYTES]
    except OSError:
        return []

    arguments: list[str] = []
    for flag, *values in OPTIONAL_LAUNCH_ARGUMENTS:
        if f'"{flag}"' in source or f"'{flag}'" in source:
            arguments.append(flag)
            arguments.extend(values)
    return arguments


def _require_git() -> None:
    """Fail before any long-running work when git cannot be executed.

    Both install paths clone with git, and the exec failure would otherwise
    surface as a bare "No such file or directory: 'git'" once the worker is
    already underway — after a venv and ComfyUI's requirements in the
    existing-checkout case.
    """

    if shutil.which("git") is None:
        raise ValueError(_GIT_REQUIRED_MESSAGE)


def _installs_cuda_torch_first(platform_name: str | None = None) -> bool:
    """Report whether PyPI's torch would be CPU-only, so the index goes first.

    Deliberately not gated on detecting a GPU: a CPU build cannot start
    ComfyUI at all, so a missed `nvidia-smi` must not decide the build.
    """

    return (platform_name or os.name) == "nt"


def _requires_cuda_torch(platform_name: str | None = None) -> bool:
    """Report whether the finished environment must hold a CUDA torch build."""

    return (platform_name or sys.platform) != "darwin"


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


def _launch_environment() -> dict[str, str]:
    """Environment for a Python child whose output goes to a file or a pipe.

    With stdout redirected, Windows Python encodes output with the ANSI code
    page, and ComfyUI's log interceptor uses strict error handling, so a
    single non-cp1252 character printed by a custom node can raise
    mid-startup. Unbuffered output keeps the log current, so the line shown in
    the UI is what the process is doing now rather than what it last flushed.
    The installer's pip commands want both for the same reasons.
    """

    return {
        **os.environ,
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUNBUFFERED": "1",
    }


def _pip_supports_raw_progress(python: Path, cwd: Path) -> bool:
    try:
        result = subprocess.run(
            [str(python), "-c", "import pip; print(pip.__version__)"],
            cwd=cwd,
            check=True,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=_PIP_VERSION_CHECK_TIMEOUT_SECONDS,
        )
        version = tuple(int(part) for part in result.stdout.strip().split(".")[:2])
    except (OSError, subprocess.SubprocessError, ValueError):
        return False
    return version >= _PIP_RAW_PROGRESS_MIN_VERSION


def _write_to_terminal(text: str) -> None:
    if not text:
        return
    try:
        sys.stdout.write(text)
        sys.stdout.flush()
    except (AttributeError, OSError, ValueError):
        # No usable console (a windowless launch); the UI still gets the line.
        pass


def _read_log_tail(log_path: Path, offset: int) -> list[str]:
    try:
        with log_path.open("rb") as handle:
            size = handle.seek(0, os.SEEK_END)
            start = max(offset, size - _LAUNCH_LOG_TAIL_BYTES)
            handle.seek(start)
            data = handle.read()
    except OSError:
        return []
    lines = _ANSI_ESCAPE.sub("", data.decode("utf-8", errors="replace")).splitlines()
    if start > offset and lines:
        # The read began mid-line.
        lines = lines[1:]
    return [line for line in lines if line.strip()][-_LAUNCH_LOG_TAIL_LINES:]


class ComfyuiLocalRuntime:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._install_status: ComfyuiInstallStatus = {
            "phase": "idle",
            "running": False,
            "targetPath": None,
            "message": None,
            "error": None,
            "logLine": None,
        }
        # Set once the managed venv's pip can report download progress.
        self._install_environment: dict[str, str] | None = None
        self._process: subprocess.Popen[bytes] | None = None
        # What started the current process, so a node-pack update can stop it
        # and start it again the same way.
        self._launch_command: list[str] | None = None
        self._launch_cwd: Path | None = None
        self._launch_port: int | None = None
        # Set while launch() is between its checks and storing the process
        # handle. Launches and node-pack updates each refuse to start while the
        # other is underway, so an update never changes files beneath a server
        # that starts mid-update, and never overwrites that server's handle.
        self._launch_in_progress = False
        self._launch_log_path: Path | None = None
        # Byte offset where the current launch's output starts, so the tail
        # never shows a previous launch's traceback as this one's.
        self._launch_log_offset = 0
        self._reported_exit_pid: int | None = None

    def get_launch_status(self) -> ComfyuiLaunchStatus:
        """Describe the ComfyUI process this backend launched, if any.

        The process is detached with its output redirected to a file, so an
        early exit (a missing dependency, a CUDA mismatch) is otherwise
        invisible: the UI would wait for a server that is never coming.
        """

        with self._lock:
            process = self._process
            log_path = self._launch_log_path
            log_offset = self._launch_log_offset
        if process is None:
            return {
                "state": "idle",
                "pid": None,
                "exitCode": None,
                "logPath": None,
                "logTail": [],
            }
        exit_code = process.poll()
        log_tail = _read_log_tail(log_path, log_offset) if log_path else []
        if exit_code is not None and self._reported_exit_pid != process.pid:
            self._reported_exit_pid = process.pid
            logger.warning(
                "ComfyUI (pid %s) exited with code %s; see %s",
                process.pid,
                exit_code,
                log_path,
            )
        return {
            "state": "running" if exit_code is None else "exited",
            "pid": process.pid,
            "exitCode": exit_code,
            "logPath": str(log_path) if log_path else None,
            "logTail": log_tail,
        }

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
                # Kept across steps, like a terminal: on failure it is often
                # the line that says why.
                "logLine": self._install_status["logLine"],
            }

    def start_install(self, parent_path: str | Path) -> ComfyuiInstallStatus:
        _require_git()
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
                "logLine": None,
            }
            self._install_environment = None

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
        _require_git()
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
                "logLine": None,
            }
            self._install_environment = None

        thread = threading.Thread(
            target=self._install_worker,
            args=(target, False, "The managed ComfyUI environment is ready."),
            name="vlo-comfyui-environment-installer",
            daemon=True,
        )
        thread.start()
        return self.get_install_status()

    def _run_install_command(self, command: list[str], cwd: Path | None = None) -> None:
        # Piped rather than inherited so the latest line can reach the UI. It
        # is echoed as it arrives, so the backend terminal keeps the full log.
        tracker = InstallOutputTracker()
        with subprocess.Popen(
            command,
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=self._install_environment or _launch_environment(),
        ) as process:
            assert process.stdout is not None
            while chunk := process.stdout.read1(64 * 1024):
                _write_to_terminal(tracker.feed(chunk))
                self._publish_install_log_line(tracker.latest)
            _write_to_terminal(tracker.feed(b"", final=True))
            self._publish_install_log_line(tracker.latest)
            returncode = process.wait()
        if returncode:
            raise subprocess.CalledProcessError(returncode, command)

    def _publish_install_log_line(self, line: str | None) -> None:
        if line is None:
            return
        with self._lock:
            self._install_status["logLine"] = line

    def _enable_pip_download_progress(self, python: Path, cwd: Path) -> None:
        # Into a pipe, pip draws its download bar only once the download is
        # done, so a multi-gigabyte torch wheel would sit on one line for
        # minutes. Raw progress lines let the tracker show a percentage.
        if _pip_supports_raw_progress(python, cwd):
            self._install_environment = {
                **_launch_environment(),
                "PIP_PROGRESS_BAR": "raw",
            }

    def _torch_has_cuda(self, python: Path, cwd: Path) -> bool:
        try:
            result = subprocess.run(
                [str(python), "-c", _TORCH_CUDA_CHECK_SOURCE],
                cwd=cwd,
                check=False,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=_TORCH_CUDA_CHECK_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            logger.warning("Could not check the ComfyUI torch build: %s", exc)
            return False
        return result.returncode == 0

    def _install_cuda_torch(self, target: Path, python: Path) -> None:
        """Install CUDA torch first so requirements.txt keeps it."""

        self._set_install_status(
            phase="installing_requirements",
            running=True,
            target_path=target,
            message="Installing PyTorch with CUDA support…",
        )
        try:
            self._run_install_command(
                [
                    str(python),
                    "-m",
                    "pip",
                    "install",
                    *TORCH_CUDA_PACKAGES,
                    "--index-url",
                    TORCH_CUDA_INDEX_URL,
                ],
                cwd=target,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise RuntimeError(
                f"CUDA PyTorch could not be installed from {TORCH_CUDA_INDEX_URL}: {exc}"
            ) from exc

    def _ensure_cuda_torch(self, target: Path, python: Path) -> None:
        """Fail the install rather than hand back a ComfyUI that cannot start.

        Checked after every requirements file, since a custom node's
        requirements can still replace the CUDA build with PyPI's.
        """

        self._set_install_status(
            phase="installing_requirements",
            running=True,
            target_path=target,
            message="Checking that PyTorch has CUDA support…",
        )
        if self._torch_has_cuda(python, target):
            return
        self._set_install_status(
            phase="installing_requirements",
            running=True,
            target_path=target,
            message="Reinstalling PyTorch with CUDA support…",
        )
        # Uninstalling first, rather than --force-reinstall, keeps the CUDA
        # dependency wheels that are already present instead of re-fetching them.
        self._run_install_command(
            [str(python), "-m", "pip", "uninstall", "-y", *TORCH_CUDA_PACKAGES],
            cwd=target,
        )
        self._install_cuda_torch(target, python)
        if not self._torch_has_cuda(python, target):
            raise RuntimeError(_CPU_TORCH_ERROR)

    def _install_custom_nodes(self, target: Path, python: Path) -> None:
        custom_nodes_dir = target / "custom_nodes"
        custom_nodes_dir.mkdir(exist_ok=True)

        for repository_url in MANAGED_CUSTOM_NODE_REPOSITORY_URLS:
            repository_name = repository_url.rsplit("/", 1)[-1]
            node_dir = custom_nodes_dir / repository_name
            if node_dir.exists() and not node_dir.is_dir():
                raise ValueError(
                    f"Custom-node destination exists and is not a directory: {node_dir}"
                )
            if not node_dir.exists():
                self._run_install_command(
                    [
                        "git",
                        "clone",
                        "--depth",
                        "1",
                        repository_url,
                        str(node_dir),
                    ]
                )
                # Only packs cloned here are vlo's to update later; one that
                # was already present belongs to whoever put it there.
                record_managed_node_pack(target, repository_name, repository_url)

            requirements_path = node_dir / "requirements.txt"
            if requirements_path.is_file():
                self._run_install_command(
                    [
                        str(python),
                        "-m",
                        "pip",
                        "install",
                        "-r",
                        str(requirements_path),
                    ],
                    cwd=node_dir,
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
            self._enable_pip_download_progress(python, target)
            if _installs_cuda_torch_first():
                self._install_cuda_torch(target, python)
            self._set_install_status(
                phase="installing_requirements",
                running=True,
                target_path=target,
                message="Installing ComfyUI requirements…",
            )
            self._run_install_command(
                [str(python), "-m", "pip", "install", "-r", "requirements.txt"],
                cwd=target,
            )
            # The bundled manager ships as its own package outside
            # requirements.txt. Without it `--enable-manager` only logs a
            # warning and ComfyUI starts with no manager UI.
            if (target / MANAGER_REQUIREMENTS_FILENAME).is_file():
                self._set_install_status(
                    phase="installing_requirements",
                    running=True,
                    target_path=target,
                    message="Installing ComfyUI-Manager…",
                )
                self._run_install_command(
                    [
                        str(python),
                        "-m",
                        "pip",
                        "install",
                        "-r",
                        MANAGER_REQUIREMENTS_FILENAME,
                    ],
                    cwd=target,
                )
            self._set_install_status(
                phase="installing_requirements",
                running=True,
                target_path=target,
                message="Installing vlo's recommended ComfyUI custom nodes…",
            )
            self._install_custom_nodes(target, python)
            if _requires_cuda_torch():
                self._ensure_cuda_torch(target, python)

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
            if self._install_status["running"]:
                raise ValueError(
                    "ComfyUI cannot be launched while vlo is installing or updating it"
                )
            if self._launch_in_progress:
                raise ValueError("ComfyUI is already being launched")
            self._launch_in_progress = True
        try:
            return self._launch_reserved(
                resolved,
                comfyui_url,
                python_path=python_path,
                use_system_python=use_system_python,
            )
        finally:
            with self._lock:
                self._launch_in_progress = False

    def _launch_reserved(
        self,
        resolved: Path,
        comfyui_url: str,
        *,
        python_path: str | Path | None,
        use_system_python: bool,
    ) -> dict[str, Any]:
        parsed_url = urlparse(comfyui_url)
        if parsed_url.scheme != "http":
            raise ValueError("Launching local ComfyUI requires an http URL")
        if parsed_url.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("A local ComfyUI install can only be launched for a local URL")
        port = _comfyui_url_port(comfyui_url)

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
                *_supported_launch_arguments(resolved),
            ]
        )
        if uses_portable_python:
            command.append("--windows-standalone-build")
        # The frontend reads its settings from disk on connect, so defaults are
        # seeded here rather than at install time: the checkout vlo launches is
        # the one it manages, and installs made before this existed still pick
        # the defaults up on their next launch.
        seed_managed_frontend_settings(resolved)
        process, log_path = self._spawn_launch(command, resolved)
        with self._lock:
            self._launch_port = port
        return {
            "started": True,
            "alreadyRunning": False,
            "pid": process.pid,
            "logPath": str(log_path),
        }

    def _spawn_launch(
        self, command: list[str], cwd: Path
    ) -> tuple[subprocess.Popen[bytes], Path]:
        log_path = RUNTIME_ROOT / "comfyui.log"
        log_handle = log_path.open("ab")
        log_offset = log_handle.tell()
        log_handle.write(
            (
                f"\n=== vlo launched ComfyUI at {datetime.now().isoformat(timespec='seconds')}"
                f" ===\n{subprocess.list2cmdline(command)}\n"
            ).encode("utf-8")
        )
        log_handle.flush()
        popen_kwargs: dict[str, Any] = {
            "cwd": cwd,
            "stdin": subprocess.DEVNULL,
            "stdout": log_handle,
            "stderr": subprocess.STDOUT,
            "env": _launch_environment(),
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
            self._launch_command = command
            self._launch_cwd = cwd
            self._launch_log_path = log_path
            self._launch_log_offset = log_offset
        return process, log_path

    def _launched_process_serving(
        self, checkout: Path, comfyui_url: str
    ) -> tuple[subprocess.Popen[bytes] | None, bool]:
        """The live process vlo launched from ``checkout``, and whether it is
        the one that answers at ``comfyui_url``.

        A process vlo launched from another checkout is none of an update's
        business: stopping it would take down an unrelated server while the
        target's own server, if any, kept running.
        """

        with self._lock:
            process = self._process
            cwd = self._launch_cwd
            port = self._launch_port
        if process is None or process.poll() is not None or cwd is None:
            return None, False
        if cwd.resolve() != checkout.resolve():
            return None, False
        return process, port == _comfyui_url_port(comfyui_url)

    def _stop_launched_comfyui(
        self, process: subprocess.Popen[bytes] | None
    ) -> tuple[list[str], Path] | None:
        """Stop ``process`` if it is still the ComfyUI this backend launched;
        return how to start it again.

        Only a process this backend holds a handle to can be stopped. One that
        outlived a vlo restart is detached and unknown here, which is why the
        node-pack update refuses to run while any other ComfyUI answers.
        """

        with self._lock:
            if process is None or self._process is not process:
                return None
            command = self._launch_command
            cwd = self._launch_cwd
        if process.poll() is not None or command is None or cwd is None:
            return None

        logger.info("Stopping ComfyUI (pid %s) to update its node packs", process.pid)
        self._signal_launched_process(process, kill=False)
        try:
            process.wait(timeout=_COMFYUI_STOP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            self._signal_launched_process(process, kill=True)
            process.wait(timeout=_COMFYUI_STOP_TIMEOUT_SECONDS)
        with self._lock:
            # A deliberate stop is not a crash: report the launch as idle
            # rather than as an exit with a log tail to diagnose.
            if self._process is process:
                self._process = None
        return command, cwd

    @staticmethod
    def _signal_launched_process(process: subprocess.Popen[bytes], *, kill: bool) -> None:
        if os.name == "nt":
            if kill:
                process.kill()
            else:
                process.terminate()
            return
        # start_new_session made ComfyUI a process-group leader; signalling
        # the group stops anything it spawned along with it.
        try:
            os.killpg(process.pid, signal.SIGKILL if kill else signal.SIGTERM)
        except ProcessLookupError:
            pass

    def start_node_pack_update(
        self, install_path: str | Path, comfyui_url: str
    ) -> ComfyuiInstallStatus:
        """Bring a ComfyUI-vlo that vlo cloned up to the version vlo needs.

        Refused for a pack vlo did not clone, and while a ComfyUI that vlo did
        not start is running: installing requirements under a live server is
        unsafe, and only a process vlo launched can be stopped and restarted.
        """

        _require_git()
        checkout = resolve_comfyui_install_path(install_path)
        if checkout is None:
            raise ValueError("The configured directory is not a recognized ComfyUI install")
        report = inspect_comfyui_vlo(checkout)
        if report["status"] == "ok":
            raise ValueError("ComfyUI-vlo is already up to date")
        pack_dir = Path(report["path"]) if report["path"] else None
        managed = find_managed_node_pack(checkout, pack_dir) if pack_dir else None
        if pack_dir is None or managed is None:
            raise ValueError(
                "vlo did not install this copy of ComfyUI-vlo, so it will not change it"
            )
        target_process, answers_at_url = self._launched_process_serving(
            checkout, comfyui_url
        )
        # Anything answering at the URL that is not the process vlo launched
        # from this checkout cannot be stopped here, and may be serving it.
        if not answers_at_url and _comfyui_responds(comfyui_url):
            raise RuntimeError(
                f"A ComfyUI that vlo cannot stop is running at {comfyui_url}. "
                "Stop it, then update."
            )

        with self._lock:
            if self._install_status["running"]:
                raise RuntimeError("A ComfyUI installation task is already running")
            current = self._process if self._process and self._process.poll() is None else None
            if self._launch_in_progress or current is not target_process:
                raise RuntimeError("ComfyUI is being launched. Try the update again shortly.")
            self._install_status = {
                "phase": "updating_nodes",
                "running": True,
                "targetPath": str(checkout),
                "message": "Updating ComfyUI-vlo…",
                "error": None,
                "logLine": None,
            }
            self._install_environment = None

        thread = threading.Thread(
            target=self._node_pack_update_worker,
            args=(checkout, pack_dir, managed["repository"], target_process),
            name="vlo-comfyui-node-pack-update",
            daemon=True,
        )
        thread.start()
        return self.get_install_status()

    def _node_pack_update_worker(
        self,
        checkout: Path,
        pack_dir: Path,
        repository: str,
        target_process: subprocess.Popen[bytes] | None = None,
    ) -> None:
        relaunch: tuple[list[str], Path] | None = None
        error: str | None = None
        message: str | None = None
        try:
            self._set_install_status(
                phase="updating_nodes",
                running=True,
                target_path=checkout,
                message="Checking ComfyUI-vlo for local changes…",
            )
            if _git_output(pack_dir, "status", "--porcelain", "--untracked-files=no"):
                raise RuntimeError(
                    "ComfyUI-vlo has local changes, so vlo left it alone. "
                    "Commit or discard them, then update."
                )
            origin = _git_output(pack_dir, "remote", "get-url", "origin")
            if _normalize_repository(origin) != _normalize_repository(repository):
                raise RuntimeError(
                    f"ComfyUI-vlo now pulls from {origin} rather than {repository}, "
                    "so vlo left it alone."
                )

            # Stopped only once the checks pass, so a refused update never
            # takes ComfyUI down.
            relaunch = self._stop_launched_comfyui(target_process)
            self._set_install_status(
                phase="updating_nodes",
                running=True,
                target_path=checkout,
                message="Updating ComfyUI-vlo…",
            )
            previous_head = _git_output(pack_dir, "rev-parse", "HEAD")
            self._run_install_command(["git", "-C", str(pack_dir), "pull", "--ff-only"])
            try:
                self._install_node_pack_requirements(checkout, pack_dir)
            except (OSError, subprocess.SubprocessError, RuntimeError, ValueError) as exc:
                # The pull already advanced pyproject.toml, so leaving it would
                # report the pack as current with its requirements missing,
                # and refuse the retry. Back to the commit that was working.
                raise RuntimeError(_roll_back_node_pack(pack_dir, previous_head, exc)) from exc

            report = inspect_comfyui_vlo(checkout)
            installed = report["installedVersion"] or "an unversioned commit"
            if report["status"] != "ok":
                message = f"ComfyUI-vlo was updated to {installed}."
                raise RuntimeError(
                    f"vlo needs {report['requiredVersion']}, which the ComfyUI-vlo "
                    "repository does not have yet."
                )
            message = f"ComfyUI-vlo is now {installed}."
        except (OSError, subprocess.SubprocessError, RuntimeError, ValueError) as exc:
            error = str(exc)

        if relaunch is not None:
            # Restarted whatever the outcome: the update stopped ComfyUI, and
            # a failed pull leaves the previous checkout intact and runnable.
            try:
                self._spawn_launch(*relaunch)
            except OSError as exc:
                error = f"{error + ' ' if error else ''}ComfyUI could not be restarted: {exc}"
            else:
                if message:
                    message += " ComfyUI was restarted to load it."
        elif message:
            message += " It loads the next time ComfyUI starts."

        self._set_install_status(
            phase="failed" if error else "complete",
            running=False,
            target_path=checkout,
            # What happened, kept on failure too: an update can succeed and
            # still fail to restart ComfyUI.
            message=message or "ComfyUI-vlo was not updated.",
            error=error,
        )

    def _install_node_pack_requirements(self, checkout: Path, pack_dir: Path) -> None:
        requirements = pack_dir / "requirements.txt"
        if not requirements.is_file():
            return
        python = _managed_venv_python(checkout)
        if not python.is_file():
            raise RuntimeError(
                "vlo's ComfyUI environment is missing, so ComfyUI-vlo's "
                "requirements could not be installed."
            )
        self._set_install_status(
            phase="updating_nodes",
            running=True,
            target_path=checkout,
            message="Installing ComfyUI-vlo requirements…",
        )
        self._run_install_command(
            [str(python), "-m", "pip", "install", "-r", str(requirements)],
            cwd=pack_dir,
        )
        # A pack's requirements can swap the CUDA torch build for PyPI's,
        # exactly as during the first install.
        if _requires_cuda_torch():
            self._ensure_cuda_torch(checkout, python)


def _git_output(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=True,
        timeout=_GIT_QUERY_TIMEOUT_SECONDS,
    )
    return result.stdout.strip()


def _roll_back_node_pack(pack_dir: Path, previous_head: str, cause: Exception) -> str:
    """Reset a pack to the commit it had before the update; describe the result.

    Safe because the update only starts on a checkout without tracked changes,
    and a hard reset leaves untracked files alone.
    """

    try:
        _git_output(pack_dir, "reset", "--hard", "--quiet", previous_head)
    except (OSError, subprocess.SubprocessError) as exc:
        return (
            f"{cause} Putting ComfyUI-vlo back also failed ({exc}). Run "
            f'git -C "{pack_dir}" reset --hard {previous_head}, then update again.'
        )
    return f"{cause} ComfyUI-vlo was put back to its previous version; try the update again."


def _comfyui_url_port(comfyui_url: str) -> int:
    return urlparse(comfyui_url).port or 8188


def _normalize_repository(url: str) -> str:
    return url.strip().rstrip("/").removesuffix(".git").casefold()


def _comfyui_responds(comfyui_url: str) -> bool:
    try:
        httpx.get(
            f"{comfyui_url.rstrip('/')}/system_stats",
            timeout=httpx.Timeout(3.0, connect=2.0),
        )
    except httpx.HTTPError:
        return False
    return True


comfyui_local_runtime = ComfyuiLocalRuntime()
