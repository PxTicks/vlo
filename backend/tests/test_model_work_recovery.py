"""Failure paths that must not hand the GPU away on a guess.

Two rules, both about *not knowing*:

- a restore that failed leaves vlo ignorant of what ComfyUI is still executing,
  so admission stays closed rather than opening on an assumption;
- a submission whose outcome is ambiguous keeps its reservation until ComfyUI
  authoritatively says otherwise.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi import Response
from starlette.requests import Request

import main
from routers import comfyui_compat
from services.comfyui import comfyui_proxy
from services.generation_delivery import service as delivery_service_module
from services.generation_delivery.service import GenerationHoldingService
from services.model_work import (
    LOCAL_GPU_RESOURCE,
    TENANT_BACKEND,
    CoordinatorNotReadyError,
    ModelWorkCoordinator,
)
from services.model_work import locality


@pytest.fixture
def local_comfyui(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(locality, "get_comfyui_gpu_locality", lambda: "local")


def _reserve_backend(coordinator):
    return coordinator.try_reserve_sync(
        resource=LOCAL_GPU_RESOURCE,
        tenant=TENANT_BACKEND,
        source="sam2",
        label="mask video",
        owner="vlo.sam2",
    )


# ---------------------------------------------------------------------------
# Restart recovery
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_failed_restore_keeps_admission_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    coordinator = ModelWorkCoordinator()
    monkeypatch.setattr(main, "get_model_work_coordinator", lambda: coordinator)

    async def _explode() -> None:
        raise OSError("holding directory is unreadable")

    monkeypatch.setattr(
        main.generation_holding_service, "restore_in_flight_work", _explode
    )

    assert await main._try_restore_model_work_state() is False
    assert coordinator.ready() is False
    # Not "admit anyway": vlo does not know what ComfyUI is still running.
    with pytest.raises(CoordinatorNotReadyError):
        _reserve_backend(coordinator)


@pytest.mark.anyio
async def test_restore_retry_opens_admission_once_it_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    coordinator = ModelWorkCoordinator()
    monkeypatch.setattr(main, "get_model_work_coordinator", lambda: coordinator)
    monkeypatch.setattr(main, "MODEL_WORK_RESTORE_RETRY_BASE_SECONDS", 0)
    attempts = 0

    async def _flaky() -> None:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise OSError("still unreadable")

    monkeypatch.setattr(main.generation_holding_service, "restore_in_flight_work", _flaky)

    assert await main._try_restore_model_work_state() is False
    await asyncio.wait_for(main._retry_model_work_restore_forever(), 5)

    assert attempts == 3
    assert coordinator.ready() is True
    assert _reserve_backend(coordinator) is not None


@pytest.mark.anyio
async def test_a_partial_restore_is_retried_rather_than_marked_loaded(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """`_loaded` must not be set while occupancy restoration is unfinished, or
    the retry would short-circuit and leave the ledger permanently incomplete."""

    service = GenerationHoldingService(root=tmp_path / "holding")
    attempts = 0

    def _restore(manifests: list) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("coordinator rejected the restore")

    monkeypatch.setattr(service, "_restore_model_work_occupancy", _restore)

    with pytest.raises(RuntimeError):
        await service.restore_in_flight_work()
    assert service._loaded is False

    await service.restore_in_flight_work()
    assert attempts == 2
    assert service._loaded is True


# ---------------------------------------------------------------------------
# Ambiguous submissions
# ---------------------------------------------------------------------------


def _prompt_request(body: dict) -> Request:
    raw = json.dumps(body).encode("utf-8")

    async def receive():
        return {"type": "http.request", "body": raw, "more_body": False}

    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/comfyui-frame/api/prompt",
            "raw_path": b"/comfyui-frame/api/prompt",
            "query_string": b"",
            "headers": [(b"content-type", b"application/json")],
            "server": ("testserver", 80),
            "scheme": "http",
        },
        receive,
    )


@pytest.mark.anyio
async def test_iframe_transport_failure_retains_the_reservation(
    monkeypatch: pytest.MonkeyPatch,
    model_work_coordinator,
    local_comfyui: None,
) -> None:
    """A 502 the proxy synthesised means the request never completed — ComfyUI
    may still have queued the prompt, and the prompt id only ever arrives in the
    response that failed."""

    async def failing_proxy(_request: Request, _upstream_path: str) -> Response:
        return Response(
            status_code=502,
            content="ComfyUI proxy request failed: ConnectError",
            media_type="text/plain",
            headers={comfyui_proxy.PROXY_TRANSPORT_ERROR_HEADER: "transport"},
        )

    watched: list[object] = []

    async def fake_watch(lease: object) -> None:
        watched.append(lease)

    monkeypatch.setattr(comfyui_compat, "proxy_http_request", failing_proxy)
    monkeypatch.setattr(
        comfyui_compat.generation_holding_service,
        "watch_ambiguous_submission",
        fake_watch,
    )

    response = await comfyui_compat._proxy_with_prompt_adoption(
        _prompt_request({"prompt": {}, "client_id": "iframe-client"}),
        "/api/prompt",
    )
    await asyncio.sleep(0)

    assert response.status_code == 502
    # Still held: releasing here would be a guess, and the wrong guess puts two
    # tenants on one card.
    assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is not None
    assert len(watched) == 1
    assert watched[0].active is True


@pytest.mark.anyio
async def test_a_comfyui_rejection_still_releases_immediately(
    monkeypatch: pytest.MonkeyPatch,
    model_work_coordinator,
    local_comfyui: None,
) -> None:
    """A 502 *from ComfyUI itself* is an answer, not a lost connection."""

    async def rejecting_proxy(_request: Request, _upstream_path: str) -> Response:
        return Response(
            status_code=502,
            content=json.dumps({"error": "upstream said no"}),
            media_type="application/json",
        )

    monkeypatch.setattr(comfyui_compat, "proxy_http_request", rejecting_proxy)

    await comfyui_compat._proxy_with_prompt_adoption(
        _prompt_request({"prompt": {}, "client_id": "iframe-client"}),
        "/api/prompt",
    )

    assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is None


@pytest.mark.anyio
async def test_ambiguous_watchdog_releases_only_on_an_empty_comfyui_queue(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    model_work_coordinator,
    local_comfyui: None,
) -> None:
    monkeypatch.setattr(
        delivery_service_module, "MONITOR_BACKSTOP_ONLY_INITIAL_DELAY_SECONDS", 0
    )
    monkeypatch.setattr(delivery_service_module, "MONITOR_BACKSTOP_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(delivery_service_module, "MONITOR_UNREACHABLE_STALE_THRESHOLD", 1)
    monkeypatch.setattr(
        delivery_service_module, "AMBIGUOUS_SUBMISSION_IDLE_THRESHOLD", 2
    )
    service = GenerationHoldingService(root=tmp_path / "holding")

    lease = model_work_coordinator.try_reserve_sync(
        resource=LOCAL_GPU_RESOURCE,
        tenant="comfyui-process",
        source="comfyui-iframe",
        label="ComfyUI (in-editor)",
        owner="vlo.comfyui",
        sharing="tenant",
    )
    assert lease is not None

    activity = iter(["unknown", "busy", "idle", "idle"])
    seen: list[str] = []

    async def fake_probe() -> str:
        verdict = next(activity)
        seen.append(verdict)
        if verdict in ("unknown", "busy"):
            # Neither answer frees the card: unknown is unknown, and busy means
            # ComfyUI is using it whoever's prompt that is.
            assert lease.active is True
        return verdict

    monkeypatch.setattr(service, "probe_comfyui_activity", fake_probe)

    await asyncio.wait_for(service.watch_ambiguous_submission(lease), 5)

    assert seen == ["unknown", "busy", "idle", "idle"]
    assert lease.active is False
    assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is None


@pytest.mark.anyio
async def test_probe_reports_unknown_when_comfyui_cannot_be_queried(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")

    async def broken_client():
        raise httpx.ConnectError("no route")

    monkeypatch.setattr(delivery_service_module, "get_http_client", broken_client)

    assert await service.probe_comfyui_activity() == "unknown"
