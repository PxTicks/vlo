import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
from starlette.datastructures import FormData

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main  # noqa: E402
from routers import comfyui  # noqa: E402


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


def test_app_status_reports_connected_comfyui_and_available_sam2(
    monkeypatch,
    tmp_path: Path,
):
    index_file = tmp_path / "index.html"
    index_file.write_text("<!doctype html><html></html>", encoding="utf-8")

    async def fake_get_http_client():
        return DummyClient()

    monkeypatch.setattr(main, "FRONTEND_DIST_DIR", tmp_path)
    monkeypatch.setattr(main, "FRONTEND_INDEX_FILE", index_file)
    monkeypatch.setattr(main, "get_comfyui_url", lambda: "http://127.0.0.1:8188")
    monkeypatch.setattr(main, "get_comfyui_url_error", lambda: None)
    monkeypatch.setattr(main, "get_http_client", fake_get_http_client)
    monkeypatch.setattr(
        main.sam2_service,
        "get_health",
        lambda: {"runtime": {"ready": True}},
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
        },
        "sam2": {
            "status": "available",
            "error": None,
        },
    }


def test_app_status_reports_disconnected_comfyui_and_unavailable_sam2(
    monkeypatch,
):
    async def fake_get_http_client():
        return FailingClient()

    monkeypatch.setattr(main, "get_comfyui_url", lambda: "http://127.0.0.1:8188")
    monkeypatch.setattr(main, "get_comfyui_url_error", lambda: None)
    monkeypatch.setattr(main, "get_http_client", fake_get_http_client)
    monkeypatch.setattr(
        main.sam2_service,
        "get_health",
        lambda: {"runtime": {"ready": False}},
    )

    status = asyncio.run(main.get_app_status())

    assert status["backend"]["status"] == "ok"
    assert status["comfyui"]["status"] == "disconnected"
    assert "ComfyUI offline" in (status["comfyui"]["error"] or "")
    assert status["sam2"] == {
        "status": "unavailable",
        "error": "No SAM2 models discovered",
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
                        "workflow_id": "wf.json",
                        "workflow": json.dumps({"1": {"class_type": "LoadImage", "inputs": {}}}),
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
