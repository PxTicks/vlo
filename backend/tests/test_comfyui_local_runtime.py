import re
import shutil
import subprocess
from pathlib import Path

import pytest

from services import runtime_settings
from services.comfyui import local_runtime
from services.hardware import VramInfo
from services.comfyui.local_runtime import (
    COMFYUI_REPOSITORY_URL,
    MANAGED_CUSTOM_NODE_REPOSITORY_URLS,
    ComfyuiPythonEnvironmentRequired,
    ComfyuiLocalRuntime,
    DirectoryPickerBusyError,
    _environment_python,
    verify_comfyui_install,
)


@pytest.fixture(autouse=True)
def _git_on_path(monkeypatch):
    """Keep the git preflight deterministic regardless of the host machine."""

    real_which = shutil.which
    monkeypatch.setattr(
        local_runtime.shutil,
        "which",
        lambda cmd, *args, **kwargs: (
            "/usr/bin/git" if cmd == "git" else real_which(cmd, *args, **kwargs)
        ),
    )


def _without_git(monkeypatch) -> None:
    monkeypatch.setattr(
        local_runtime.shutil,
        "which",
        lambda cmd, *args, **kwargs: None if cmd == "git" else shutil.which(cmd),
    )


def _write_comfyui_checkout(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "comfy").mkdir(exist_ok=True)
    (path / "main.py").write_text(
        "import comfy.options\n"
        "from comfy.cli_args import args\n"
        "import execution\n"
        "server.PromptServer()\n",
        encoding="utf-8",
    )
    for filename in ("nodes.py", "server.py", "folder_paths.py"):
        (path / filename).write_text("", encoding="utf-8")
    (path / "requirements.txt").write_text("aiohttp\n", encoding="utf-8")


def test_managed_custom_nodes_match_readme_except_wan_video_wrapper() -> None:
    readme = (Path(__file__).parents[2] / "README.md").read_text(encoding="utf-8")
    custom_nodes_block = readme.split(
        "<!-- comfyui-custom-nodes:start -->",
        1,
    )[1].split("<!-- comfyui-custom-nodes:end -->", 1)[0]
    readme_urls = re.findall(
        r"^- (https://github\.com/\S+)$",
        custom_nodes_block,
        re.MULTILINE,
    )

    expected_urls = [
        url for url in readme_urls if not url.endswith("/ComfyUI-WanVideoWrapper")
    ]
    assert list(MANAGED_CUSTOM_NODE_REPOSITORY_URLS) == expected_urls


def test_verification_accepts_nested_portable_layout(tmp_path: Path) -> None:
    checkout = tmp_path / "ComfyUI_windows_portable" / "ComfyUI"
    _write_comfyui_checkout(checkout)

    verification = verify_comfyui_install(checkout.parent)

    assert verification["valid"] is True
    assert verification["installPath"] == str(checkout.resolve())
    assert "argument parser" in verification["sourceMarkers"]
    assert "nodes.py" in verification["layoutMarkers"]


def test_verification_rejects_unrelated_main_py(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("print('not ComfyUI')", encoding="utf-8")

    verification = verify_comfyui_install(tmp_path)

    assert verification["valid"] is False
    assert verification["mainPyPresent"] is True
    assert verification["sourceMarkers"] == []


def test_installer_clones_creates_venv_installs_and_persists(
    tmp_path: Path,
    monkeypatch,
) -> None:
    manager = ComfyuiLocalRuntime()
    target = tmp_path / "ComfyUI"
    commands: list[tuple[list[str], Path | None]] = []
    persisted: list[dict[str, object]] = []

    def fake_run(command: list[str], cwd: Path | None = None) -> None:
        commands.append((command, cwd))
        if command[:4] == ["git", "clone", "--depth", "1"]:
            clone_target = Path(command[-1])
            if clone_target == target:
                _write_comfyui_checkout(target)
            else:
                clone_target.mkdir(parents=True)
                (clone_target / "requirements.txt").write_text(
                    f"{clone_target.name}-dependency\n",
                    encoding="utf-8",
                )
        if command[1:3] == ["-m", "venv"]:
            python = target / ".venv" / "bin" / "python"
            python.parent.mkdir(parents=True)
            python.write_text("", encoding="utf-8")

    monkeypatch.setattr(manager, "_run_install_command", fake_run)
    monkeypatch.setattr(
        runtime_settings,
        "update_runtime_settings",
        lambda **kwargs: persisted.append(kwargs),
    )

    manager._install_worker(target)

    status = manager.get_install_status()
    assert status["phase"] == "complete"
    assert status["running"] is False
    assert commands[0][0] == [
        "git",
        "clone",
        "--depth",
        "1",
        COMFYUI_REPOSITORY_URL,
        str(target),
    ]
    custom_node_clone_urls = [
        command[0][4]
        for command in commands
        if command[0][:4] == ["git", "clone", "--depth", "1"]
        and command[0][4] != COMFYUI_REPOSITORY_URL
    ]
    assert custom_node_clone_urls == list(MANAGED_CUSTOM_NODE_REPOSITORY_URLS)
    assert all("WanVideoWrapper" not in url for url in custom_node_clone_urls)
    custom_node_requirement_installs = [
        command
        for command, _cwd in commands
        if command[:4] == [
            str(target / ".venv" / "bin" / "python"),
            "-m",
            "pip",
            "install",
        ]
        and Path(command[-1]).parent.parent.name == "custom_nodes"
    ]
    assert len(custom_node_requirement_installs) == len(
        MANAGED_CUSTOM_NODE_REPOSITORY_URLS
    )
    assert persisted == [
        {
            "comfyui_install_dir": str(target.resolve()),
            "comfyui_install_dir_prompt_status": "accepted",
        }
    ]


def test_install_reports_a_missing_git_before_starting_work(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _without_git(monkeypatch)
    manager = ComfyuiLocalRuntime()

    with pytest.raises(ValueError, match="git is required"):
        manager.start_install(tmp_path)

    assert manager.get_install_status()["phase"] == "idle"
    assert manager.get_install_status()["running"] is False
    assert list(tmp_path.iterdir()) == []


def test_environment_setup_reports_a_missing_git_before_starting_work(
    tmp_path: Path,
    monkeypatch,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    _without_git(monkeypatch)
    manager = ComfyuiLocalRuntime()

    with pytest.raises(ValueError, match="git is required"):
        manager.start_environment_setup(checkout)

    assert manager.get_install_status()["running"] is False
    assert not (checkout / ".venv").exists()


def test_install_refuses_to_mutate_an_existing_checkout(tmp_path: Path) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    manager = ComfyuiLocalRuntime()

    with pytest.raises(ValueError, match="already installed"):
        manager.start_install(tmp_path)


def test_environment_setup_skips_clone_for_existing_checkout(
    tmp_path: Path,
    monkeypatch,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    commands: list[list[str]] = []
    manager = ComfyuiLocalRuntime()

    def fake_run(command: list[str], cwd: Path | None = None) -> None:
        del cwd
        commands.append(command)
        if command[1:3] == ["-m", "venv"]:
            python = checkout / ".venv" / "bin" / "python"
            python.parent.mkdir(parents=True)
            python.write_text("", encoding="utf-8")
        if command[:4] == ["git", "clone", "--depth", "1"]:
            Path(command[-1]).mkdir(parents=True)

    monkeypatch.setattr(manager, "_run_install_command", fake_run)
    monkeypatch.setattr(runtime_settings, "update_runtime_settings", lambda **_kwargs: None)

    manager._install_worker(
        checkout,
        clone_checkout=False,
        completion_message="Environment ready.",
    )

    assert all(
        command[:5]
        != ["git", "clone", "--depth", "1", COMFYUI_REPOSITORY_URL]
        for command in commands
    )
    assert [
        command[4]
        for command in commands
        if command[:4] == ["git", "clone", "--depth", "1"]
    ] == list(MANAGED_CUSTOM_NODE_REPOSITORY_URLS)
    assert commands[0][1:3] == ["-m", "venv"]
    assert manager.get_install_status()["message"] == "Environment ready."


def _install_with_stubbed_commands(
    manager: ComfyuiLocalRuntime,
    target: Path,
    monkeypatch,
    *,
    fail_cuda_torch: bool = False,
) -> list[list[str]]:
    commands: list[list[str]] = []

    def fake_run(command: list[str], cwd: Path | None = None) -> None:
        del cwd
        commands.append(command)
        if command[:4] == ["git", "clone", "--depth", "1"]:
            clone_target = Path(command[-1])
            if clone_target == target:
                _write_comfyui_checkout(target)
            else:
                clone_target.mkdir(parents=True)
        if command[1:3] == ["-m", "venv"]:
            python = target / ".venv" / "bin" / "python"
            python.parent.mkdir(parents=True)
            python.write_text("", encoding="utf-8")
        if fail_cuda_torch and local_runtime.TORCH_CUDA_INDEX_URL in command:
            raise subprocess.CalledProcessError(1, command)

    monkeypatch.setattr(manager, "_run_install_command", fake_run)
    monkeypatch.setattr(runtime_settings, "update_runtime_settings", lambda **_kwargs: None)
    manager._install_worker(target)
    return commands


def test_cuda_torch_index_is_used_only_for_windows_nvidia_hosts(monkeypatch) -> None:
    monkeypatch.setattr(
        local_runtime,
        "detect_local_vram",
        lambda: VramInfo(total_mb=24576, source="nvidia_smi"),
    )
    assert local_runtime._needs_cuda_torch_index(platform_name="nt") is True
    assert local_runtime._needs_cuda_torch_index(platform_name="posix") is False

    monkeypatch.setattr(
        local_runtime,
        "detect_local_vram",
        lambda: VramInfo(total_mb=None, source=None),
    )
    assert local_runtime._needs_cuda_torch_index(platform_name="nt") is False


def test_installer_installs_cuda_torch_before_comfyui_requirements(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(local_runtime, "_needs_cuda_torch_index", lambda: True)
    manager = ComfyuiLocalRuntime()
    target = tmp_path / "ComfyUI"

    commands = _install_with_stubbed_commands(manager, target, monkeypatch)

    cuda_index = next(
        index
        for index, command in enumerate(commands)
        if local_runtime.TORCH_CUDA_INDEX_URL in command
    )
    requirements_index = next(
        index
        for index, command in enumerate(commands)
        if command[-2:] == ["-r", "requirements.txt"]
    )
    assert cuda_index < requirements_index
    assert commands[cuda_index][2:] == [
        "pip",
        "install",
        *local_runtime.TORCH_CUDA_PACKAGES,
        "--index-url",
        local_runtime.TORCH_CUDA_INDEX_URL,
    ]
    assert manager.get_install_status()["phase"] == "complete"


def test_failed_cuda_torch_install_completes_with_a_cpu_warning(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(local_runtime, "_needs_cuda_torch_index", lambda: True)
    manager = ComfyuiLocalRuntime()
    target = tmp_path / "ComfyUI"

    commands = _install_with_stubbed_commands(
        manager,
        target,
        monkeypatch,
        fail_cuda_torch=True,
    )

    assert any(command[-2:] == ["-r", "requirements.txt"] for command in commands)
    status = manager.get_install_status()
    assert status["phase"] == "complete"
    assert "may run on the CPU" in (status["message"] or "")


def test_installer_skips_the_cuda_index_when_not_needed(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(local_runtime, "_needs_cuda_torch_index", lambda: False)
    manager = ComfyuiLocalRuntime()
    target = tmp_path / "ComfyUI"

    commands = _install_with_stubbed_commands(manager, target, monkeypatch)

    assert all(
        local_runtime.TORCH_CUDA_INDEX_URL not in command for command in commands
    )


def test_windows_environment_discovery_uses_scripts_python(tmp_path: Path) -> None:
    python = tmp_path / "ComfyUI" / "venv" / "Scripts" / "python.exe"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")

    assert _environment_python(
        tmp_path / "ComfyUI",
        platform_name="nt",
    ) == python


def test_launch_requires_an_explicit_choice_without_a_python_environment(
    tmp_path: Path,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)

    with pytest.raises(ComfyuiPythonEnvironmentRequired):
        ComfyuiLocalRuntime().launch(checkout, "http://127.0.0.1:8188")


def test_launch_uses_system_python_only_when_explicitly_requested(
    tmp_path: Path,
    monkeypatch,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 4320

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        captured["command"] = command
        return FakeProcess()

    monkeypatch.setattr(local_runtime.subprocess, "Popen", fake_popen)

    ComfyuiLocalRuntime().launch(
        checkout,
        "http://127.0.0.1:8188",
        use_system_python=True,
    )

    assert captured["command"][0] == local_runtime.sys.executable


def test_launch_uses_install_venv_and_requested_local_port(
    tmp_path: Path,
    monkeypatch,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    python = checkout / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 4321

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return FakeProcess()

    monkeypatch.setattr("services.comfyui.local_runtime.subprocess.Popen", fake_popen)
    manager = ComfyuiLocalRuntime()

    result = manager.launch(checkout, "http://127.0.0.1:8299")

    assert result["started"] is True
    assert captured["command"] == [
        str(python),
        str(checkout / "main.py"),
        "--port",
        "8299",
        "--disable-auto-launch",
    ]
    assert captured["kwargs"]["start_new_session"] is True
    assert captured["kwargs"]["stdout"].closed is True


def _write_cli_args(checkout: Path, flags: tuple[str, ...]) -> None:
    parser_source = "\n".join(
        f'parser.add_argument("{flag}", action="store_true")' for flag in flags
    )
    (checkout / "comfy").mkdir(parents=True, exist_ok=True)
    (checkout / "comfy" / "cli_args.py").write_text(parser_source, encoding="utf-8")


def test_launch_passes_manager_and_taesd_previews_when_supported(
    tmp_path: Path,
    monkeypatch,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    _write_cli_args(checkout, ("--enable-manager", "--preview-method"))
    python = checkout / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 4322

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        del kwargs
        captured["command"] = command
        return FakeProcess()

    monkeypatch.setattr(local_runtime.subprocess, "Popen", fake_popen)

    ComfyuiLocalRuntime().launch(checkout, "http://127.0.0.1:8188")

    assert captured["command"] == [
        str(python),
        str(checkout / "main.py"),
        "--port",
        "8188",
        "--disable-auto-launch",
        "--enable-manager",
        "--preview-method",
        "taesd",
    ]


def test_launch_omits_arguments_an_older_checkout_would_reject(
    tmp_path: Path,
    monkeypatch,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)
    _write_cli_args(checkout, ("--preview-method",))
    python = checkout / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 4323

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        del kwargs
        captured["command"] = command
        return FakeProcess()

    monkeypatch.setattr(local_runtime.subprocess, "Popen", fake_popen)

    ComfyuiLocalRuntime().launch(checkout, "http://127.0.0.1:8188")

    assert "--enable-manager" not in captured["command"]
    assert captured["command"][-2:] == ["--preview-method", "taesd"]


def test_launch_arguments_are_dropped_without_a_readable_cli_args(
    tmp_path: Path,
) -> None:
    checkout = tmp_path / "ComfyUI"
    _write_comfyui_checkout(checkout)

    assert local_runtime._supported_launch_arguments(checkout) == []


def test_launch_uses_windows_portable_python_flags(
    tmp_path: Path,
    monkeypatch,
) -> None:
    portable_root = tmp_path / "ComfyUI_windows_portable"
    checkout = portable_root / "ComfyUI"
    _write_comfyui_checkout(checkout)
    python = portable_root / "python_embeded" / "python.exe"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 4322

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return FakeProcess()

    monkeypatch.setattr(local_runtime.subprocess, "Popen", fake_popen)

    result = ComfyuiLocalRuntime().launch(
        checkout,
        "http://127.0.0.1:8188",
    )

    assert result["started"] is True
    assert captured["command"] == [
        str(python),
        "-s",
        str(checkout / "main.py"),
        "--port",
        "8188",
        "--disable-auto-launch",
        "--windows-standalone-build",
    ]
    assert captured["kwargs"]["stdout"].closed is True


def test_directory_picker_is_single_flight() -> None:
    local_runtime._DIRECTORY_PICKER_LOCK.acquire()
    try:
        with pytest.raises(DirectoryPickerBusyError):
            local_runtime.pick_directory("Choose ComfyUI")
    finally:
        local_runtime._DIRECTORY_PICKER_LOCK.release()
