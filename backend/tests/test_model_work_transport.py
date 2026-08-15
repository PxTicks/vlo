"""The ledger's own transport (plan §8).

The generation-delivery websocket hard-requires a ``projectId``; GPU activity is
machine-global, so it is the wrong channel. This one is project-agnostic.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import app_settings
from services.model_work import LOCAL_GPU_RESOURCE, TENANT_BACKEND, TENANT_COMFYUI


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(app_settings.router)
    return app


def _reserve(coordinator, *, tenant: str = TENANT_BACKEND, label: str = "beat detection"):
    lease = coordinator.try_reserve_sync(
        resource=LOCAL_GPU_RESOURCE,
        tenant=tenant,
        source="beats" if tenant == TENANT_BACKEND else "comfyui-vlo",
        label=label,
        owner="vlo.beats" if tenant == TENANT_BACKEND else "vlo.comfyui",
        sharing="exclusive" if tenant == TENANT_BACKEND else "tenant",
    )
    assert lease is not None
    return lease


@pytest.mark.anyio
async def test_model_work_snapshot_endpoint(model_work_coordinator) -> None:
    lease = _reserve(model_work_coordinator)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app()),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/app/model-work")

    payload = response.json()
    assert response.status_code == 200
    assert payload["ready"] is True
    assert [entry["label"] for entry in payload["entries"]] == ["beat detection"]
    assert payload["entries"][0]["occupancy"] == "occupied"
    assert payload["entries"][0]["jobStatus"] == "running"
    gpu = next(view for view in payload["resources"] if view["resource"] == LOCAL_GPU_RESOURCE)
    assert gpu["tenant"] == TENANT_BACKEND
    assert gpu["holderCount"] == 1
    lease.release()


def test_model_work_websocket_sends_snapshot_then_deltas(model_work_coordinator) -> None:
    lease = _reserve(model_work_coordinator, label="before connect")

    with TestClient(_app()).websocket_connect("/app/model-work/ws") as websocket:
        first = websocket.receive_json()
        assert first["type"] == "snapshot"
        assert [entry["label"] for entry in first["data"]["entries"]] == ["before connect"]
        base_revision = first["data"]["revision"]

        lease.release()
        second = _reserve(model_work_coordinator, tenant=TENANT_COMFYUI, label="flux render")

        release_event = websocket.receive_json()
        added_event = websocket.receive_json()

        assert release_event["type"] == "event"
        assert release_event["data"]["revision"] == base_revision + 1
        assert release_event["data"]["entry"]["occupancy"] == "released"
        assert added_event["data"]["revision"] == base_revision + 2
        assert added_event["data"]["entry"]["label"] == "flux render"
        assert added_event["data"]["resources"][0]["tenant"] == TENANT_COMFYUI

    second.release()


@pytest.mark.anyio
async def test_unsafe_release_is_explicit_and_reports_unknown_entries(
    model_work_coordinator,
) -> None:
    lease = _reserve(model_work_coordinator, tenant=TENANT_COMFYUI, label="flux render")
    token = lease.transfer("prompt-1")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app()),
        base_url="http://testserver",
    ) as client:
        missing = await client.post("/app/model-work/nope/unsafe-release")
        released = await client.post(f"/app/model-work/{token.entry_id}/unsafe-release")

    assert missing.status_code == 404
    assert released.status_code == 200
    assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is None
