import json
from pathlib import Path

import pytest

from services import runtime_settings, workflow_modes
from services.hardware import VramInfo
from routers import app_settings


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
