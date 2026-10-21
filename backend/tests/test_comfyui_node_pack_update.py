"""Updating a ComfyUI-vlo that vlo cloned, and only that.

The git tests run real git against a local origin, because the behaviour that
matters — a fast-forward of the shallow clone vlo's installer makes, refusing
local changes — lives in git rather than in vlo.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from routers import app_settings
from services.comfyui import local_runtime
from services.comfyui.local_runtime import ComfyuiLocalRuntime
from services.comfyui.managed_install import (
    MANAGED_MARKER_FILENAME,
    find_managed_node_pack,
    read_managed_node_packs,
    record_managed_node_pack,
)
from services.comfyui.node_pack_versions import (
    COMFYUI_VLO_MINIMUM_VERSION,
    inspect_comfyui_vlo,
)

OLD_VERSION = "0.1.0"
GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "vlo tests",
    "GIT_AUTHOR_EMAIL": "tests@vlo.invalid",
    "GIT_COMMITTER_NAME": "vlo tests",
    "GIT_COMMITTER_EMAIL": "tests@vlo.invalid",
    "GIT_CONFIG_NOSYSTEM": "1",
}


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        env=GIT_ENV,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def write_pyproject(repo: Path, version: str) -> None:
    (repo / "pyproject.toml").write_text(
        f'[project]\nname = "comfyui-vlo"\nversion = "{version}"\n',
        encoding="utf-8",
    )


def commit_version(repo: Path, version: str) -> None:
    write_pyproject(repo, version)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", f"release {version}")


@pytest.fixture(autouse=True)
def _isolated_launch_log(tmp_path_factory, monkeypatch):
    monkeypatch.setattr(local_runtime, "RUNTIME_ROOT", tmp_path_factory.mktemp("runtime"))


@pytest.fixture
def origin(tmp_path: Path) -> Path:
    repo = tmp_path / "origin" / "ComfyUI-vlo"
    repo.mkdir(parents=True)
    git(repo, "init", "-q", "-b", "main")
    commit_version(repo, OLD_VERSION)
    return repo


@pytest.fixture
def checkout(tmp_path: Path) -> Path:
    comfyui = tmp_path / "ComfyUI"
    (comfyui / "custom_nodes").mkdir(parents=True)
    (comfyui / "main.py").write_text("", encoding="utf-8")
    return comfyui


def clone_managed(checkout: Path, origin: Path) -> tuple[Path, str]:
    """Clone the pack the way vlo's installer does, and record it."""

    repository = origin.as_uri()
    pack_dir = checkout / "custom_nodes" / "ComfyUI-vlo"
    git(checkout, "clone", "-q", "--depth", "1", repository, str(pack_dir))
    record_managed_node_pack(checkout, "ComfyUI-vlo", repository)
    return pack_dir, repository


def installed_version(pack_dir: Path) -> str | None:
    return inspect_comfyui_vlo(pack_dir.parent.parent)["installedVersion"]


# -- Ownership record --------------------------------------------------------


def test_the_record_lists_what_vlo_cloned(checkout: Path):
    record_managed_node_pack(checkout, "ComfyUI-vlo", "https://example.invalid/a")
    record_managed_node_pack(checkout, "ComfyUI-KJNodes", "https://example.invalid/b")
    # Re-recording replaces rather than duplicates.
    record_managed_node_pack(checkout, "ComfyUI-vlo", "https://example.invalid/c")

    packs = read_managed_node_packs(checkout)

    assert [(pack["directory"], pack["repository"]) for pack in packs] == [
        ("ComfyUI-KJNodes", "https://example.invalid/b"),
        ("ComfyUI-vlo", "https://example.invalid/c"),
    ]
    assert json.loads((checkout / MANAGED_MARKER_FILENAME).read_text())["version"] == 1


def test_an_unreadable_record_owns_nothing(checkout: Path):
    (checkout / MANAGED_MARKER_FILENAME).write_text("{not json", encoding="utf-8")

    assert read_managed_node_packs(checkout) == []


def test_ownership_is_tied_to_this_checkouts_custom_nodes(checkout: Path, tmp_path: Path):
    record_managed_node_pack(checkout, "ComfyUI-vlo", "https://example.invalid/a")

    assert find_managed_node_pack(checkout, checkout / "custom_nodes" / "ComfyUI-vlo")
    assert find_managed_node_pack(checkout, tmp_path / "elsewhere" / "ComfyUI-vlo") is None


def test_the_installer_records_only_the_packs_it_clones(checkout: Path, monkeypatch):
    # A pack that was already there belongs to whoever put it there.
    (checkout / "custom_nodes" / "ComfyUI-vlo").mkdir()
    manager = ComfyuiLocalRuntime()

    def fake_run(command: list[str], cwd: Path | None = None) -> None:
        del cwd
        if command[:2] == ["git", "clone"]:
            Path(command[-1]).mkdir(parents=True)

    monkeypatch.setattr(manager, "_run_install_command", fake_run)

    manager._install_custom_nodes(checkout, checkout / ".venv" / "bin" / "python")

    recorded = {pack["directory"] for pack in read_managed_node_packs(checkout)}
    assert "ComfyUI-vlo" not in recorded
    assert recorded == {
        url.rsplit("/", 1)[-1]
        for url in local_runtime.MANAGED_CUSTOM_NODE_REPOSITORY_URLS
        if not url.endswith("/ComfyUI-vlo")
    }


def test_the_report_marks_a_cloned_pack_as_managed(checkout: Path, origin: Path):
    clone_managed(checkout, origin)

    report = inspect_comfyui_vlo(checkout)

    assert report["status"] == "outdated"
    assert report["managed"] is True


def test_a_pack_the_user_cloned_is_not_managed(checkout: Path, origin: Path):
    git(checkout, "clone", "-q", origin.as_uri(), str(checkout / "custom_nodes" / "ComfyUI-vlo"))

    assert inspect_comfyui_vlo(checkout)["managed"] is False


# -- Starting an update --------------------------------------------------------


@pytest.fixture
def no_comfyui_running(monkeypatch):
    monkeypatch.setattr(local_runtime, "_comfyui_responds", lambda _url: False)


def test_an_unmanaged_pack_is_refused(checkout: Path, origin: Path, no_comfyui_running):
    git(checkout, "clone", "-q", origin.as_uri(), str(checkout / "custom_nodes" / "ComfyUI-vlo"))

    with pytest.raises(ValueError, match="did not install this copy"):
        ComfyuiLocalRuntime().start_node_pack_update(checkout, "http://127.0.0.1:8188")


def test_a_missing_pack_is_refused(checkout: Path, no_comfyui_running):
    with pytest.raises(ValueError, match="did not install this copy"):
        ComfyuiLocalRuntime().start_node_pack_update(checkout, "http://127.0.0.1:8188")


def test_an_up_to_date_pack_is_refused(checkout: Path, origin: Path, no_comfyui_running):
    commit_version(origin, COMFYUI_VLO_MINIMUM_VERSION)
    clone_managed(checkout, origin)

    with pytest.raises(ValueError, match="already up to date"):
        ComfyuiLocalRuntime().start_node_pack_update(checkout, "http://127.0.0.1:8188")


def test_a_comfyui_vlo_did_not_start_blocks_the_update(
    checkout: Path, origin: Path, monkeypatch
):
    clone_managed(checkout, origin)
    monkeypatch.setattr(local_runtime, "_comfyui_responds", lambda _url: True)
    manager = ComfyuiLocalRuntime()

    with pytest.raises(RuntimeError, match="vlo cannot stop"):
        manager.start_node_pack_update(checkout, "http://127.0.0.1:8188")

    assert manager.get_install_status()["phase"] == "idle"


def test_the_update_route_refuses_a_remote_comfyui(monkeypatch):
    monkeypatch.setattr(
        app_settings, "get_runtime_settings", lambda: {"comfyui_install_dir": "/comfy"}
    )
    monkeypatch.setattr(app_settings, "is_comfyui_local", lambda: False)

    response = asyncio.run(app_settings.update_comfyui_vlo_node_pack())

    assert response.status_code == 409
    assert b"comfyui_install_not_local" in response.body


# -- The update itself ---------------------------------------------------------


def test_a_shallow_clone_fast_forwards_to_the_required_release(
    checkout: Path, origin: Path
):
    pack_dir, repository = clone_managed(checkout, origin)
    commit_version(origin, COMFYUI_VLO_MINIMUM_VERSION)
    manager = ComfyuiLocalRuntime()

    manager._node_pack_update_worker(checkout, pack_dir, repository)

    status = manager.get_install_status()
    assert status["error"] is None
    assert status["phase"] == "complete"
    assert status["message"] == (
        f"ComfyUI-vlo is now {COMFYUI_VLO_MINIMUM_VERSION}. "
        "It loads the next time ComfyUI starts."
    )
    assert installed_version(pack_dir) == COMFYUI_VLO_MINIMUM_VERSION


def test_local_changes_are_left_alone(checkout: Path, origin: Path, monkeypatch):
    pack_dir, repository = clone_managed(checkout, origin)
    commit_version(origin, COMFYUI_VLO_MINIMUM_VERSION)
    write_pyproject(pack_dir, "0.1.1")
    manager = ComfyuiLocalRuntime()
    stops: list[bool] = []
    monkeypatch.setattr(
        manager, "_stop_launched_comfyui", lambda _process: stops.append(True)
    )

    manager._node_pack_update_worker(checkout, pack_dir, repository)

    status = manager.get_install_status()
    assert status["phase"] == "failed"
    assert "local changes" in (status["error"] or "")
    assert installed_version(pack_dir) == "0.1.1"
    # Refused before ComfyUI was touched.
    assert stops == []


def test_a_pack_repointed_at_another_repository_is_left_alone(
    checkout: Path, origin: Path
):
    pack_dir, _repository = clone_managed(checkout, origin)
    manager = ComfyuiLocalRuntime()

    manager._node_pack_update_worker(
        checkout, pack_dir, "https://github.com/PxTicks/ComfyUI-vlo"
    )

    status = manager.get_install_status()
    assert status["phase"] == "failed"
    assert "rather than https://github.com/PxTicks/ComfyUI-vlo" in (status["error"] or "")


def test_an_unpublished_minimum_is_reported_honestly(checkout: Path, origin: Path):
    pack_dir, repository = clone_managed(checkout, origin)
    commit_version(origin, "0.2.0")
    manager = ComfyuiLocalRuntime()

    manager._node_pack_update_worker(checkout, pack_dir, repository)

    status = manager.get_install_status()
    assert status["phase"] == "failed"
    assert status["message"] == (
        "ComfyUI-vlo was updated to 0.2.0. It loads the next time ComfyUI starts."
    )
    assert status["error"] == (
        f"vlo needs {COMFYUI_VLO_MINIMUM_VERSION}, which the ComfyUI-vlo "
        "repository does not have yet."
    )


def test_requirements_go_into_the_managed_environment(
    checkout: Path, origin: Path, monkeypatch
):
    pack_dir, repository = clone_managed(checkout, origin)
    (origin / "requirements.txt").write_text("einops\n", encoding="utf-8")
    commit_version(origin, COMFYUI_VLO_MINIMUM_VERSION)
    python = checkout / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")
    monkeypatch.setattr(local_runtime, "_managed_venv_python", lambda _target: python)
    monkeypatch.setattr(local_runtime, "_requires_cuda_torch", lambda: True)
    manager = ComfyuiLocalRuntime()
    real_run = manager._run_install_command
    pip_commands: list[list[str]] = []
    cuda_checks: list[Path] = []

    def run(command: list[str], cwd: Path | None = None) -> None:
        if command[0] == "git":
            real_run(command, cwd)
        else:
            pip_commands.append(command)

    monkeypatch.setattr(manager, "_run_install_command", run)
    monkeypatch.setattr(
        manager, "_ensure_cuda_torch", lambda target, _python: cuda_checks.append(target)
    )

    manager._node_pack_update_worker(checkout, pack_dir, repository)

    assert manager.get_install_status()["phase"] == "complete"
    assert pip_commands == [
        [str(python), "-m", "pip", "install", "-r", str(pack_dir / "requirements.txt")]
    ]
    assert cuda_checks == [checkout]


def test_comfyui_is_restarted_even_when_the_pull_fails(
    checkout: Path, origin: Path, monkeypatch
):
    pack_dir, repository = clone_managed(checkout, origin)
    manager = ComfyuiLocalRuntime()
    launch = (["comfyui"], checkout)
    spawned: list[tuple[list[str], Path]] = []
    monkeypatch.setattr(manager, "_stop_launched_comfyui", lambda _process: launch)
    monkeypatch.setattr(
        manager, "_spawn_launch", lambda command, cwd: spawned.append((command, cwd))
    )

    def failing_pull(command: list[str], cwd: Path | None = None) -> None:
        # What `git pull --ff-only` does when upstream history was rewritten.
        raise subprocess.CalledProcessError(128, command)

    monkeypatch.setattr(manager, "_run_install_command", failing_pull)

    manager._node_pack_update_worker(checkout, pack_dir, repository)

    assert manager.get_install_status()["phase"] == "failed"
    assert spawned == [launch]
    assert installed_version(pack_dir) == OLD_VERSION


def test_a_successful_update_restarts_the_comfyui_it_stopped(
    checkout: Path, origin: Path, monkeypatch
):
    pack_dir, repository = clone_managed(checkout, origin)
    commit_version(origin, COMFYUI_VLO_MINIMUM_VERSION)
    manager = ComfyuiLocalRuntime()
    spawned: list[list[str]] = []
    monkeypatch.setattr(
        manager, "_stop_launched_comfyui", lambda _process: (["comfyui"], checkout)
    )
    monkeypatch.setattr(
        manager, "_spawn_launch", lambda command, _cwd: spawned.append(command)
    )

    manager._node_pack_update_worker(checkout, pack_dir, repository)

    assert spawned == [["comfyui"]]
    assert manager.get_install_status()["message"] == (
        f"ComfyUI-vlo is now {COMFYUI_VLO_MINIMUM_VERSION}. "
        "ComfyUI was restarted to load it."
    )


# -- Stopping the ComfyUI vlo launched -----------------------------------------


def test_nothing_is_stopped_when_vlo_launched_nothing():
    assert ComfyuiLocalRuntime()._stop_launched_comfyui(None) is None


@pytest.mark.skipif(os.name == "nt", reason="exercises POSIX process groups")
def test_the_launched_comfyui_is_stopped_and_can_be_started_again(tmp_path: Path):
    manager = ComfyuiLocalRuntime()
    command = [sys.executable, "-c", "import time; time.sleep(60)"]
    process, _log_path = manager._spawn_launch(command, tmp_path)

    relaunch = manager._stop_launched_comfyui(process)

    assert relaunch == (command, tmp_path)
    assert process.poll() is not None
    # A deliberate stop reads as idle, not as a crash to diagnose.
    assert manager.get_launch_status()["state"] == "idle"

    restarted, _ = manager._spawn_launch(*relaunch)
    try:
        assert manager.get_launch_status()["state"] == "running"
    finally:
        restarted.kill()
        restarted.wait()


def test_a_process_vlo_no_longer_tracks_is_not_stopped(tmp_path: Path):
    class Replaced:
        def poll(self):
            return None

    manager = ComfyuiLocalRuntime()
    manager._process = Replaced()
    manager._launch_command = ["comfyui"]
    manager._launch_cwd = tmp_path

    assert manager._stop_launched_comfyui(Replaced()) is None


# -- Launches and updates exclude each other -----------------------------------


class AliveProcess:
    pid = 4242

    def poll(self):
        return None


def adopt_launch(manager: ComfyuiLocalRuntime, cwd: Path, port: int) -> AliveProcess:
    process = AliveProcess()
    manager._process = process
    manager._launch_command = ["comfyui"]
    manager._launch_cwd = cwd
    manager._launch_port = port
    return process


def test_comfyui_cannot_be_launched_during_an_update(checkout: Path, monkeypatch):
    monkeypatch.setattr(local_runtime, "verify_comfyui_install", lambda _path: {
        "valid": True, "installPath": str(checkout),
    })
    spawned: list[object] = []
    monkeypatch.setattr(local_runtime.subprocess, "Popen", lambda *a, **k: spawned.append(a))
    manager = ComfyuiLocalRuntime()
    manager._install_status = {**manager._install_status, "phase": "updating_nodes", "running": True}

    with pytest.raises(ValueError, match="while vlo is installing or updating it"):
        manager.launch(checkout, "http://127.0.0.1:8188")

    assert spawned == []
    assert manager._launch_in_progress is False


def test_a_failed_launch_releases_its_reservation(checkout: Path, monkeypatch):
    monkeypatch.setattr(local_runtime, "verify_comfyui_install", lambda _path: {
        "valid": True, "installPath": str(checkout),
    })
    manager = ComfyuiLocalRuntime()

    with pytest.raises(ValueError, match="local URL"):
        manager.launch(checkout, "http://192.0.2.1:8188")

    assert manager._launch_in_progress is False


def test_an_update_cannot_start_while_comfyui_is_being_launched(
    checkout: Path, origin: Path, no_comfyui_running
):
    clone_managed(checkout, origin)
    manager = ComfyuiLocalRuntime()
    manager._launch_in_progress = True

    with pytest.raises(RuntimeError, match="being launched"):
        manager.start_node_pack_update(checkout, "http://127.0.0.1:8188")

    assert manager.get_install_status()["running"] is False


# -- Which launched process an update may stop ---------------------------------


def test_a_launch_from_another_checkout_is_left_running(checkout: Path, tmp_path: Path):
    manager = ComfyuiLocalRuntime()
    adopt_launch(manager, tmp_path / "OtherComfyUI", 8188)

    assert manager._launched_process_serving(checkout, "http://127.0.0.1:8188") == (
        None,
        False,
    )


def test_the_launch_serving_this_checkout_and_url_is_the_target(checkout: Path):
    manager = ComfyuiLocalRuntime()
    process = adopt_launch(manager, checkout, 8188)

    assert manager._launched_process_serving(checkout, "http://127.0.0.1:8188") == (
        process,
        True,
    )


def test_another_server_at_the_url_blocks_the_update(
    checkout: Path, origin: Path, monkeypatch
):
    # vlo launched this checkout on 8190, but something else now answers at
    # the configured 8188 — it may be serving the same files.
    clone_managed(checkout, origin)
    manager = ComfyuiLocalRuntime()
    adopt_launch(manager, checkout, 8190)
    probed: list[str] = []
    monkeypatch.setattr(
        local_runtime, "_comfyui_responds", lambda url: probed.append(url) or True
    )

    with pytest.raises(RuntimeError, match="vlo cannot stop is running at"):
        manager.start_node_pack_update(checkout, "http://127.0.0.1:8188")

    assert probed == ["http://127.0.0.1:8188"]


def test_the_targets_own_server_does_not_block_the_update(
    checkout: Path, origin: Path, monkeypatch
):
    clone_managed(checkout, origin)
    manager = ComfyuiLocalRuntime()
    process = adopt_launch(manager, checkout, 8188)
    monkeypatch.setattr(local_runtime, "_comfyui_responds", lambda _url: True)
    started: list[tuple] = []
    monkeypatch.setattr(
        local_runtime.threading,
        "Thread",
        lambda target, args, **_kwargs: type(
            "T", (), {"start": lambda self: started.append(args)}
        )(),
    )

    manager.start_node_pack_update(checkout, "http://127.0.0.1:8188")

    assert started[0][-1] is process


# -- Recovering from a failed update -------------------------------------------


def test_failed_requirements_put_the_pack_back_so_the_update_can_be_retried(
    checkout: Path, origin: Path, monkeypatch
):
    pack_dir, repository = clone_managed(checkout, origin)
    (origin / "requirements.txt").write_text("einops\n", encoding="utf-8")
    commit_version(origin, COMFYUI_VLO_MINIMUM_VERSION)
    python = checkout / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")
    monkeypatch.setattr(local_runtime, "_managed_venv_python", lambda _target: python)
    manager = ComfyuiLocalRuntime()
    real_run = manager._run_install_command

    def run(command: list[str], cwd: Path | None = None) -> None:
        if command[0] == "git":
            real_run(command, cwd)
        else:
            raise subprocess.CalledProcessError(1, command)

    monkeypatch.setattr(manager, "_run_install_command", run)

    manager._node_pack_update_worker(checkout, pack_dir, repository)

    status = manager.get_install_status()
    assert status["phase"] == "failed"
    assert status["message"] == "ComfyUI-vlo was not updated."
    assert "put back to its previous version" in (status["error"] or "")
    assert installed_version(pack_dir) == OLD_VERSION
    assert not (pack_dir / "requirements.txt").exists()
    # Still outdated, so the update is offered and accepted again.
    assert inspect_comfyui_vlo(checkout)["status"] == "outdated"


def test_a_failed_restart_keeps_the_update_result(
    checkout: Path, origin: Path, monkeypatch
):
    pack_dir, repository = clone_managed(checkout, origin)
    commit_version(origin, COMFYUI_VLO_MINIMUM_VERSION)
    manager = ComfyuiLocalRuntime()
    monkeypatch.setattr(
        manager, "_stop_launched_comfyui", lambda _process: (["comfyui"], checkout)
    )

    def failing_spawn(command: list[str], cwd: Path):
        raise OSError("no such file")

    monkeypatch.setattr(manager, "_spawn_launch", failing_spawn)

    manager._node_pack_update_worker(checkout, pack_dir, repository)

    status = manager.get_install_status()
    assert status["phase"] == "failed"
    assert status["message"] == f"ComfyUI-vlo is now {COMFYUI_VLO_MINIMUM_VERSION}."
    assert status["error"] == "ComfyUI could not be restarted: no such file"
    assert installed_version(pack_dir) == COMFYUI_VLO_MINIMUM_VERSION
