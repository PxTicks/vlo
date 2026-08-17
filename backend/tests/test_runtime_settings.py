import asyncio
import json
from pathlib import Path

import pytest

from services import runtime_settings, workflow_modes
from services.hardware import VramInfo
from routers import app_settings


class _JsonRequest:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    async def json(self):
        return self._payload


class _EmptyBodyRequest:
    async def body(self) -> bytes:
        return b""

    async def json(self):
        raise AssertionError("json() should not be called for an empty body")


class _BodyRequest:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    async def body(self) -> bytes:
        return json.dumps(self._payload).encode()

    async def json(self):
        return self._payload


def test_runtime_settings_persist_workflow_mode_and_prompt_status(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings_path = tmp_path / "app_settings.json"
    monkeypatch.setattr(runtime_settings, "SETTINGS_PATH", settings_path)

    settings = runtime_settings.update_runtime_settings(
        workflow_mode="high_vram",
    )

    assert settings["workflow_mode"] == "high_vram"
    assert settings["high_vram_prompt_status"] == "accepted"
    assert json.loads(settings_path.read_text(encoding="utf-8")) == {
        "workflow_mode": "high_vram",
        "high_vram_prompt_status": "accepted",
    }


def test_declining_high_vram_suppresses_future_prompt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime_settings, "SETTINGS_PATH", tmp_path / "settings.json")
    assert runtime_settings.should_prompt_for_high_vram(49 * 1024)

    runtime_settings.update_runtime_settings(high_vram_prompt_status="declined")

    assert not runtime_settings.should_prompt_for_high_vram(49 * 1024)


def test_declining_generative_ai_suppresses_future_comfyui_prompt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime_settings, "SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(runtime_settings, "ENV_COMFYUI_INSTALL_DIR", None)

    assert runtime_settings.should_prompt_for_comfyui_install_dir()

    runtime_settings.update_runtime_settings(
        comfyui_install_dir_prompt_status="declined",
    )

    assert not runtime_settings.should_prompt_for_comfyui_install_dir()


def test_workflow_mode_resolves_high_vram_packaged_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    high_vram_dir = tmp_path / "high"
    monkeypatch.setattr(runtime_settings, "SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(workflow_modes, "HIGH_VRAM_WORKFLOWS_DIR", high_vram_dir)

    runtime_settings.update_runtime_settings(workflow_mode="high_vram")

    assert workflow_modes.get_packaged_workflows_dir() == high_vram_dir


def test_public_settings_payload_marks_high_vram_recommendation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime_settings, "SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(app_settings, "get_comfyui_url", lambda: "http://comfy")

    payload = app_settings.build_public_settings_payload(
        VramInfo(total_mb=48 * 1024, source="nvidia_smi"),
    )

    assert payload["settings"]["workflowMode"] == "default"
    assert payload["hardware"]["vram"]["meetsHighVramThreshold"] is True
    assert payload["recommendations"]["shouldPromptForHighVram"] is True


def test_status_payload_uses_cached_install_verification_without_rechecking(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_dir = tmp_path / "ComfyUI"
    cached = {
        "requestedPath": str(install_dir),
        "installPath": str(install_dir),
        "valid": True,
        "mainPyPresent": True,
        "sourceMarkers": ["argument parser"],
        "layoutMarkers": ["comfy", "nodes.py", "server.py"],
        "warnings": [],
    }
    monkeypatch.setattr(
        app_settings,
        "get_runtime_settings",
        lambda: {
            "workflow_mode": "default",
            "comfyui_install_dir": str(install_dir),
        },
    )
    monkeypatch.setattr(
        app_settings,
        "get_cached_comfyui_install_verification",
        lambda _path: cached,
    )
    monkeypatch.setattr(
        app_settings,
        "verify_comfyui_install",
        lambda _path: pytest.fail("status payload must not verify the filesystem"),
    )
    monkeypatch.setattr(app_settings, "get_comfyui_url", lambda: "http://comfy")

    payload = app_settings.build_public_settings_payload(VramInfo(total_mb=None))

    assert payload["settings"]["comfyuiInstallVerification"] == cached


def test_patch_can_explicitly_accept_an_unverified_checkout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    checkout = tmp_path / "UnusualComfyUI"
    checkout.mkdir()
    (checkout / "main.py").write_text("print('custom entry point')", encoding="utf-8")
    monkeypatch.setattr(runtime_settings, "SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(app_settings, "get_comfyui_url", lambda: "http://comfy")

    response = asyncio.run(
        app_settings.patch_app_settings(
            _JsonRequest(
                {
                    "comfyuiInstallDir": str(checkout),
                    "allowUnverifiedComfyuiInstallDir": True,
                }
            )
        )
    )

    assert not hasattr(response, "status_code")
    assert response["settings"]["comfyuiInstallDir"] == str(checkout)
    assert response["settings"]["comfyuiInstallVerification"]["valid"] is False


def test_new_post_routes_handle_empty_bodies_without_500(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    verify_response = asyncio.run(
        app_settings.verify_comfyui_install_route(_EmptyBodyRequest())
    )
    install_response = asyncio.run(app_settings.install_comfyui(_EmptyBodyRequest()))
    monkeypatch.setattr(
        app_settings,
        "get_runtime_settings",
        lambda: {"comfyui_install_dir": None},
    )
    launch_response = asyncio.run(app_settings.launch_comfyui(_EmptyBodyRequest()))

    assert verify_response.status_code == 400
    assert install_response.status_code == 400
    assert launch_response.status_code == 409


def test_environment_route_forwards_sageattention_opt_in(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[tuple[str, bool]] = []
    monkeypatch.setattr(
        app_settings,
        "get_runtime_settings",
        lambda: {"comfyui_install_dir": str(tmp_path)},
    )
    monkeypatch.setattr(
        app_settings.comfyui_local_runtime,
        "start_environment_setup",
        lambda path, *, install_sageattention: captured.append(
            (path, install_sageattention)
        )
        or {"phase": "creating_environment"},
    )

    response = asyncio.run(
        app_settings.prepare_comfyui_environment(
            _BodyRequest({"installSageAttention": True})
        )
    )

    assert response == {"phase": "creating_environment"}
    assert captured == [(str(tmp_path), True)]
