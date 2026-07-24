from pathlib import Path

import pytest

from services import runtime_settings
from services.comfyui import local_runtime
from services.comfyui.local_runtime import (
    COMFYUI_REPOSITORY_URL,
    ComfyuiPythonEnvironmentRequired,
    ComfyuiLocalRuntime,
    DirectoryPickerBusyError,
    _environment_python,
    verify_comfyui_install,
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
            _write_comfyui_checkout(target)
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
    assert commands[-1][0][-2:] == ["-r", "requirements.txt"]
    assert persisted == [
        {
            "comfyui_install_dir": str(target.resolve()),
            "comfyui_install_dir_prompt_status": "accepted",
        }
    ]


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

    monkeypatch.setattr(manager, "_run_install_command", fake_run)
    monkeypatch.setattr(runtime_settings, "update_runtime_settings", lambda **_kwargs: None)

    manager._install_worker(
        checkout,
        clone_checkout=False,
        completion_message="Environment ready.",
    )

    assert all(command[0] != "git" for command in commands)
    assert commands[0][1:3] == ["-m", "venv"]
    assert manager.get_install_status()["message"] == "Environment ready."


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
