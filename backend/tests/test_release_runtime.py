import asyncio
import json
from pathlib import Path

import httpx
from starlette.datastructures import FormData

import main
from routers import comfyui
from services.ai_models import health
from services.ai_models.capabilities import (
    Capability,
    CapabilityState,
    Check,
    CheckStatus,
    FailureCode,
    VerificationStage,
)
from services.ai_models.capabilities.contract import utc_now
from services.hardware import VramInfo


class DummyRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


class DummyFormRequest:
    def __init__(self, payload):
        self._payload = payload

    async def form(self):
        return self._payload


class DummyClient:
    async def get(self, _path, timeout=None):
        return {"ok": True, "timeout": timeout}


class FailingClient:
    async def get(self, _path, timeout=None):
        raise httpx.RequestError(
            "ComfyUI offline",
            request=httpx.Request("GET", "http://127.0.0.1:8188/system_stats"),
        )


def fake_capability(
    capability_id: str,
    *,
    state: CapabilityState,
    checks: tuple[Check, ...] = (),
) -> Capability:
    return Capability(
        id=capability_id,
        label=capability_id,
        state=state,
        checked_at=utc_now(),
        checks=checks,
    )


def stub_capabilities(monkeypatch, capabilities: dict[str, Capability]) -> None:
    """Answer /app/status from a fixed capability set.

    The status fields are derived from the capability registry now, so the seam
    a status test stubs is the registry lookup — not each service's health.
    """

    monkeypatch.setattr(
        health,
        "get_capability",
        lambda capability_id, **_kwargs: capabilities.get(capability_id),
    )


def fake_settings_payload(_vram_info=None):
    return {
        "settings": {
            "workflowMode": "default",
            "comfyuiUrl": "http://127.0.0.1:8188",
            "comfyuiInstallDir": "/tmp/comfy",
            "highVramPromptStatus": None,
            "comfyuiInstallDirPromptStatus": None,
        },
        "hardware": {
            "vram": {
                "totalMb": None,
                "source": None,
                "meetsHighVramThreshold": False,
            },
            "highVramThresholdMb": 49152,
        },
        "recommendations": {
            "shouldPromptForHighVram": False,
            "shouldPromptForComfyuiInstallDir": False,
        },
    }


def test_backend_extension_runtime_follows_application_lifespan(monkeypatch):
    events: list[str] = []

    class Runtime:
        async def start(self, app):
            assert app is main.app
            events.append("extensions-start")

        async def stop(self):
            events.append("extensions-stop")

    class Services:
        backend_runtime = Runtime()

    async def fake_close_http_client():
        events.append("http-close")

    async def fake_shutdown_sam_audio_jobs():
        events.append("sam-audio-stop")

    monkeypatch.setattr(main, "get_extension_services", lambda: Services())
    monkeypatch.setattr(main, "close_http_client", fake_close_http_client)
    monkeypatch.setattr(
        main.sam_audio_service,
        "shutdown_jobs",
        fake_shutdown_sam_audio_jobs,
    )

    async def run_lifespan():
        async with main.application_lifespan(main.app):
            events.append("application-running")

    asyncio.run(run_lifespan())

    assert events == [
        "extensions-start",
        "application-running",
        "sam-audio-stop",
        "extensions-stop",
        "http-close",
    ]


def test_app_status_reports_connected_comfyui_and_available_sam2(
    monkeypatch,
    tmp_path: Path,
    reset_hardware_probe_cache,
):
    index_file = tmp_path / "index.html"
    index_file.write_text("<!doctype html><html></html>", encoding="utf-8")

    async def fake_get_http_client():
        return DummyClient()

    monkeypatch.setattr(main, "detect_local_vram", lambda: VramInfo(total_mb=24576))
    monkeypatch.setattr(main, "FRONTEND_DIST_DIR", tmp_path)
    monkeypatch.setattr(main, "FRONTEND_INDEX_FILE", index_file)
    monkeypatch.setattr(main, "get_comfyui_url", lambda: "http://127.0.0.1:8188")
    monkeypatch.setattr(main, "get_comfyui_url_error", lambda: None)
    monkeypatch.setattr(main, "get_http_client", fake_get_http_client)
    monkeypatch.setattr(main, "is_comfyui_model_downloads_enabled", lambda: True)
    monkeypatch.setattr(main, "build_public_settings_payload", fake_settings_payload)
    stub_capabilities(
        monkeypatch,
        {
            "sam2": fake_capability(
                "sam2", state=CapabilityState.AVAILABLE_UNVERIFIED
            ),
            "sam-audio": fake_capability("sam-audio", state=CapabilityState.READY),
            "beat-this": fake_capability(
                "beat-this", state=CapabilityState.AVAILABLE_UNVERIFIED
            ),
        },
    )

    status = asyncio.run(main.get_app_status())

    assert status == {
        "backend": {
            "status": "ok",
            "mode": "production",
            "frontendBuildPresent": True,
        },
        "comfyui": {
            "status": "connected",
            "url": "http://127.0.0.1:8188",
            "error": None,
            "modelDownloadsEnabled": True,
        },
        "settings": fake_settings_payload()["settings"],
        "hardware": fake_settings_payload()["hardware"],
        "recommendations": fake_settings_payload()["recommendations"],
        "sam2": {
            "status": "available",
            "error": None,
        },
        "sam_audio": {
            "status": "available",
            "error": None,
        },
        "beat_this": {
            "status": "available",
            "error": None,
        },
    }


def test_app_status_reports_disconnected_comfyui_and_unavailable_sam2(
    monkeypatch,
    reset_hardware_probe_cache,
):
    async def fake_get_http_client():
        return FailingClient()

    monkeypatch.setattr(main, "detect_local_vram", lambda: VramInfo(total_mb=24576))
    monkeypatch.setattr(main, "get_comfyui_url", lambda: "http://127.0.0.1:8188")
    monkeypatch.setattr(main, "get_comfyui_url_error", lambda: None)
    monkeypatch.setattr(main, "get_http_client", fake_get_http_client)
    monkeypatch.setattr(main, "is_comfyui_model_downloads_enabled", lambda: True)
    monkeypatch.setattr(main, "build_public_settings_payload", fake_settings_payload)
    stub_capabilities(
        monkeypatch,
        {
            # No failing check: the field falls back to the legacy message.
            "sam2": fake_capability("sam2", state=CapabilityState.UNAVAILABLE),
            "sam-audio": fake_capability("sam-audio", state=CapabilityState.READY),
            "beat-this": fake_capability(
                "beat-this",
                state=CapabilityState.BLOCKED,
                checks=(
                    Check(
                        id="package.beat_this",
                        status=CheckStatus.FAIL,
                        code=FailureCode.PACKAGE_MISSING,
                        summary="The beat_this package is not installed",
                    ),
                ),
            ),
        },
    )

    status = asyncio.run(main.get_app_status())

    assert status["backend"]["status"] == "ok"
    assert status["comfyui"]["status"] == "disconnected"
    assert "ComfyUI offline" in (status["comfyui"]["error"] or "")
    assert status["comfyui"]["modelDownloadsEnabled"] is True
    assert status["sam2"] == {
        "status": "unavailable",
        "error": "No SAM2 models discovered",
    }
    # The reason comes from the failing check, not from a static string that
    # was the same regardless of what actually went wrong.
    assert status["beat_this"] == {
        "status": "unavailable",
        "error": "The beat_this package is not installed",
    }


def test_app_status_ignores_installed_model_inventory(
    monkeypatch,
    reset_hardware_probe_cache,
):
    """Installed model files must not, on their own, mean "available".

    This is the false positive the capability registry exists to remove: the
    old adapter reported ``available`` whenever the registry listed an
    installed model, which is the same file-existence signal as discovery —
    ``or``-ing it with readiness could only widen the lie.
    """

    async def fake_get_http_client():
        return DummyClient()

    monkeypatch.setattr(main, "detect_local_vram", lambda: VramInfo(total_mb=24576))
    monkeypatch.setattr(main, "get_comfyui_url", lambda: "http://127.0.0.1:8188")
    monkeypatch.setattr(main, "get_comfyui_url_error", lambda: None)
    monkeypatch.setattr(main, "get_http_client", fake_get_http_client)
    monkeypatch.setattr(main, "is_comfyui_model_downloads_enabled", lambda: True)
    monkeypatch.setattr(main, "build_public_settings_payload", fake_settings_payload)
    stub_capabilities(
        monkeypatch,
        {
            "sam2": fake_capability(
                "sam2",
                state=CapabilityState.BLOCKED,
                checks=(
                    Check(
                        id="model.checkpoint",
                        status=CheckStatus.PASS,
                        stage=VerificationStage.DISCOVERED,
                        summary="1 SAM2 checkpoint found",
                    ),
                    Check(
                        id="package.sam2",
                        status=CheckStatus.FAIL,
                        code=FailureCode.PACKAGE_MISSING,
                        summary="The sam2 package is not installed",
                    ),
                ),
            ),
            "sam-audio": fake_capability("sam-audio", state=CapabilityState.READY),
            "beat-this": fake_capability("beat-this", state=CapabilityState.READY),
        },
    )

    status = asyncio.run(main.get_app_status())

    assert status["sam2"] == {
        "status": "unavailable",
        "error": "The sam2 package is not installed",
    }


def test_update_comfyui_config_rejects_invalid_urls():
    response = asyncio.run(
        comfyui.update_comfyui_config(
            DummyRequest({"comfyui_url": "ftp://example.com"})
        )
    )

    assert response.status_code == 400
    payload = json.loads(response.body.decode("utf-8"))
    assert payload == {
        "error": {
            "code": "invalid_comfyui_url",
            "message": "ComfyUI URL must use http or https",
            "retryable": False,
        }
    }


def test_generate_returns_structured_error_when_comfyui_is_unreachable(
    monkeypatch,
    fast_delivery_timings,
):
    async def fake_get_http_client():
        return object()

    async def fake_execute_generation(*_args, **_kwargs):
        raise httpx.RequestError(
            "ComfyUI offline",
            request=httpx.Request("POST", "http://127.0.0.1:8188/prompt"),
        )

    monkeypatch.setattr(comfyui, "get_http_client", fake_get_http_client)
    monkeypatch.setattr(comfyui, "execute_generation", fake_execute_generation)

    response = asyncio.run(
        comfyui.generate(
            DummyFormRequest(
                FormData(
                    {
                        "client_id": "client-1",
                        "project_id": "project-1",
                        "workflow_id": "wf.json",
                        "workflow": json.dumps({"1": {"class_type": "LoadImage", "inputs": {}}}),
                        "delivery_context": json.dumps(
                            {
                                "plan_id": "plan-1",
                                "workflow_name": "Workflow",
                                "workflow_source_id": "wf.json",
                                "generation_metadata": {
                                    "source": "generated",
                                    "workflowName": "Workflow",
                                    "inputs": [],
                                },
                                "postprocess_config": {
                                    "mode": "auto",
                                    "panel_preview": "raw_outputs",
                                    "on_failure": "fallback_raw",
                                },
                                "auto_family_request_key": None,
                                "uses_save_image_websocket_outputs": False,
                                "save_image_websocket_node_ids": [],
                                "replay_inputs": None,
                            }
                        ),
                        "target_aspect_ratio": "16:9",
                        "target_resolution": "1080",
                    }
                )
            )
        )
    )

    assert response.status_code == 503
    payload = json.loads(response.body.decode("utf-8"))
    assert payload == {
        "error": {
            "code": "comfyui_unreachable",
            "message": "Generation failed because ComfyUI is unavailable",
            "retryable": True,
            "details": {"reason": "ComfyUI offline"},
        }
    }
