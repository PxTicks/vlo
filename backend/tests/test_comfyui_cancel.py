"""Cancelling generations must be recorded as a cancellation, not inferred.

ComfyUI reports only that a prompt is gone, so every cancelled item used to
settle as a failure. These cover the two entry points that now say what
happened: vlo's own cancel endpoint, and the proxy that carries a queue
mutation issued by the in-editor ComfyUI. The ordering those depend on lives in
the delivery service and is covered by its own tests.
"""

import asyncio
import json

import pytest
from fastapi import Response
from starlette.requests import Request

from routers import comfyui, comfyui_compat
from services.generation_delivery import GenerationCancelError


def _request(path: str, method: str = "GET", *, body: bytes = b"") -> Request:
    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        {
            "type": "http",
            "method": method,
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": [(b"content-type", b"application/json")],
            "server": ("testserver", 80),
            "scheme": "http",
        },
        receive,
    )


def _cancel(body: object) -> Response:
    return asyncio.run(
        comfyui.cancel_generations(
            _request(
                "/comfy/generations/cancel",
                "POST",
                body=json.dumps(body).encode(),
            )
        )
    )


class _RecordingService:
    def __init__(self, *, raises: bool = False) -> None:
        self.cancelled: list[str] = []
        self.noted: list[object] = []
        self._raises = raises

    async def cancel_prompts(self, prompt_ids):
        if self._raises:
            raise GenerationCancelError("comfyui is down")
        self.cancelled.extend(prompt_ids)
        return {
            "requested": list(prompt_ids),
            "cancelled": list(prompt_ids),
            "interrupt_failures": [],
        }

    async def note_queue_mutation(self, payload) -> None:
        self.noted.append(payload)


def test_cancel_endpoint_delegates_the_whole_sequence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = _RecordingService()
    monkeypatch.setattr(comfyui, "generation_holding_service", service)

    response = _cancel({"prompt_ids": ["a", "b", 7, ""]})

    assert response.status_code == 200
    assert json.loads(bytes(response.body))["cancelled"] == ["a", "b"]
    assert service.cancelled == ["a", "b"]


def test_cancel_endpoint_reports_a_refusal_as_retryable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        comfyui, "generation_holding_service", _RecordingService(raises=True)
    )

    response = _cancel({"prompt_ids": ["a"]})

    assert response.status_code == 502
    payload = json.loads(bytes(response.body))
    assert payload["error"]["retryable"] is True


def test_cancel_endpoint_rejects_an_empty_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = _RecordingService()
    monkeypatch.setattr(comfyui, "generation_holding_service", service)

    assert _cancel({"prompt_ids": []}).status_code == 400
    assert service.cancelled == []


@pytest.mark.parametrize(
    ("route", "path", "raw_path"),
    [
        ("proxy_queue_root", "", "/queue"),
        ("proxy_api_root", "queue", "/api/queue"),
    ],
)
def test_proxy_records_queue_mutations_the_in_editor_comfyui_accepted(
    monkeypatch: pytest.MonkeyPatch,
    route: str,
    path: str,
    raw_path: str,
) -> None:
    service = _RecordingService()
    forwarded: list[str] = []
    status_codes = [200, 200, 200, 400]

    async def fake_proxy(_request: Request, upstream_path: str) -> Response:
        forwarded.append(upstream_path)
        return Response(
            content=b"{}",
            status_code=status_codes.pop(0),
            media_type="application/json",
        )

    monkeypatch.setattr(comfyui_compat, "generation_holding_service", service)
    monkeypatch.setattr(comfyui_compat, "proxy_http_request", fake_proxy)
    handler = getattr(comfyui_compat, route)

    def _call(method: str = "POST", body: object | None = None) -> None:
        asyncio.run(
            handler(
                _request(
                    raw_path,
                    method,
                    body=b"" if body is None else json.dumps(body).encode(),
                ),
                path,
            )
        )

    _call(body={"delete": ["prompt-1"]})
    _call(body={"clear": True})
    _call("GET")  # a read says nothing about anyone's intent
    _call(body={"delete": ["prompt-2"]})  # rejected upstream

    # Only what ComfyUI accepted. A note for a rejected mutation would outlive
    # its own request and relabel a later, genuine failure as a cancellation.
    assert service.noted == [{"delete": ["prompt-1"]}, {"clear": True}]
    assert forwarded == [raw_path] * 4
