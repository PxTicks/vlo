"""ComfyUI admission (plan §6).

Every prompt that passes through vlo — the generation panel's and the in-editor
iframe's — is reserved in the backend *before* it is forwarded. Observe-only
admission cannot exclude anything: by the time adoption runs, ComfyUI already
has the prompt.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI, Response
from starlette.requests import Request

from routers import comfyui as comfyui_router
from routers import comfyui_compat
from services.comfyui import comfyui_generate as comfyui_generate_service
from services.generation_delivery import service as delivery_service_module
from services.generation_delivery.service import GenerationHoldingService
from services.model_work import (
    LOCAL_GPU_RESOURCE,
    TENANT_BACKEND,
    TENANT_COMFYUI,
)
from services.model_work import comfyui_admission, locality
from services.model_work.comfyui_admission import (
    ComfyGpuBusyError,
    ComfyPromptAdmission,
)


@pytest.fixture
def local_comfyui(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(locality, "get_comfyui_gpu_locality", lambda: "local")


@pytest.fixture
def remote_comfyui(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(locality, "get_comfyui_gpu_locality", lambda: "remote")


def _hold_backend(coordinator, label: str = "mask video"):
    lease = coordinator.try_reserve_sync(
        resource=LOCAL_GPU_RESOURCE,
        tenant=TENANT_BACKEND,
        source="sam2",
        label=label,
        owner="vlo.sam2",
    )
    assert lease is not None
    return lease


def _prompt_app() -> FastAPI:
    app = FastAPI()
    app.include_router(comfyui_compat.compat_router)
    return app


async def _post_prompt(app: FastAPI, payload: dict) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        return await client.post("/comfyui-frame/api/prompt", json=payload)


# ---------------------------------------------------------------------------
# §6.2 — iframe fail-fast admission
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_model_work_iframe_policy_refuses_without_forwarding(
    monkeypatch: pytest.MonkeyPatch,
    model_work_coordinator,
    local_comfyui: None,
) -> None:
    forwarded: list[str] = []

    async def fake_proxy(_request: Request, upstream_path: str) -> Response:
        forwarded.append(upstream_path)
        return Response(
            content=json.dumps({"prompt_id": "prompt-1"}),
            media_type="application/json",
        )

    monkeypatch.setattr(comfyui_compat, "proxy_http_request", fake_proxy)
    _hold_backend(model_work_coordinator)

    response = await _post_prompt(
        _prompt_app(), {"prompt": {}, "client_id": "iframe-client"}
    )

    assert response.status_code == 429
    assert response.headers["Retry-After"] == "5"
    # The message has to be self-explanatory: ComfyUI shows it as a toast.
    assert "GPU" in response.json()["error"]["message"]
    assert forwarded == []  # Never forwarded, so the exclusion claim holds.


@pytest.mark.anyio
async def test_model_work_iframe_prompts_share_the_comfyui_tenant(
    monkeypatch: pytest.MonkeyPatch,
    model_work_coordinator,
    local_comfyui: None,
) -> None:
    prompt_ids = iter(["prompt-1", "prompt-2"])

    async def fake_proxy(_request: Request, _upstream_path: str) -> Response:
        return Response(
            content=json.dumps({"prompt_id": next(prompt_ids)}),
            media_type="application/json",
        )

    async def no_registered_project(_client_id: str) -> None:
        return None

    watched: list[str] = []

    async def fake_watch(prompt_id: str) -> None:
        watched.append(prompt_id)

    monkeypatch.setattr(comfyui_compat, "proxy_http_request", fake_proxy)
    monkeypatch.setattr(
        comfyui_compat.generation_holding_service,
        "get_iframe_client_project",
        no_registered_project,
    )
    monkeypatch.setattr(
        comfyui_compat.generation_holding_service,
        "watch_unadopted_prompt",
        fake_watch,
    )

    app = _prompt_app()
    first = await _post_prompt(app, {"prompt": {}, "client_id": "iframe-client"})
    second = await _post_prompt(app, {"prompt": {}, "client_id": "iframe-client"})
    await asyncio.sleep(0)  # Let the spawned watchdogs start.

    assert first.status_code == 200
    assert second.status_code == 200

    # Both prompts joined one ComfyUI occupancy, and local work stays excluded
    # until every child settles.
    assert model_work_coordinator.try_reserve_sync(
        resource=LOCAL_GPU_RESOURCE,
        tenant=TENANT_BACKEND,
        source="beats",
        label="beat detection",
        owner="vlo.beats",
    ) is None

    token_one = model_work_coordinator.token_for_prompt("prompt-1")
    token_two = model_work_coordinator.token_for_prompt("prompt-2")
    assert token_one is not None and token_two is not None
    token_one.settle_sync("succeeded")
    assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is not None
    token_two.settle_sync("succeeded")
    assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is None

    # A prompt no delivery monitor owns still gets a watchdog.
    assert watched == ["prompt-1", "prompt-2"]


@pytest.mark.anyio
async def test_model_work_iframe_child_releases_when_comfyui_rejects(
    monkeypatch: pytest.MonkeyPatch,
    model_work_coordinator,
    local_comfyui: None,
) -> None:
    async def fake_proxy(_request: Request, _upstream_path: str) -> Response:
        return Response(
            status_code=400,
            content=json.dumps({"error": "bad prompt", "node_errors": {"1": {}}}),
            media_type="application/json",
        )

    monkeypatch.setattr(comfyui_compat, "proxy_http_request", fake_proxy)

    response = await _post_prompt(
        _prompt_app(), {"prompt": {}, "client_id": "iframe-client"}
    )

    assert response.status_code == 400
    assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is None


@pytest.mark.anyio
async def test_model_work_remote_bypass(
    monkeypatch: pytest.MonkeyPatch,
    model_work_coordinator,
    remote_comfyui: None,
) -> None:
    """Remote ComfyUI resolves to no admission resource, not a second key."""

    async def fake_proxy(_request: Request, _upstream_path: str) -> Response:
        return Response(
            content=json.dumps({"prompt_id": "prompt-1"}),
            media_type="application/json",
        )

    async def no_registered_project(_client_id: str) -> None:
        return None

    async def fake_watch(_prompt_id: str) -> None:
        return None

    monkeypatch.setattr(comfyui_compat, "proxy_http_request", fake_proxy)
    monkeypatch.setattr(
        comfyui_compat.generation_holding_service,
        "get_iframe_client_project",
        no_registered_project,
    )
    monkeypatch.setattr(
        comfyui_compat.generation_holding_service,
        "watch_unadopted_prompt",
        fake_watch,
    )

    # Local inference owns the card; a remote ComfyUI is not a contender for it.
    _hold_backend(model_work_coordinator)
    response = await _post_prompt(
        _prompt_app(), {"prompt": {}, "client_id": "iframe-client"}
    )

    assert response.status_code == 200
    entries = [
        entry
        for entry in model_work_coordinator.snapshot().entries
        if entry.source == "comfyui-iframe"
    ]
    assert len(entries) == 1
    assert entries[0].resource is None and entries[0].tenant is None


# ---------------------------------------------------------------------------
# §6.1 — vlo-submitted prompts
# ---------------------------------------------------------------------------


def test_admission_transfers_before_any_fallible_persistence(
    model_work_coordinator,
    local_comfyui: None,
) -> None:
    admission = ComfyPromptAdmission(source="comfyui-vlo", label="flux render")
    admission.reserve()
    token = admission.accept("prompt-1")

    # Leaving the context after acceptance must not free the GPU: ComfyUI is
    # still sampling and only the monitor token may release it.
    admission.__exit__(None, None, None)
    assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is not None

    token.settle_sync("succeeded")
    assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is None


def test_admission_reports_the_occupant_when_local_work_owns_the_gpu(
    model_work_coordinator,
    local_comfyui: None,
) -> None:
    _hold_backend(model_work_coordinator, "SAM2 mask video")
    admission = ComfyPromptAdmission(source="comfyui-vlo", label="flux render")

    with pytest.raises(ComfyGpuBusyError) as excinfo:
        admission.reserve()

    assert "SAM2 mask video" in (excinfo.value.occupied_by or "")


@pytest.mark.parametrize(
    ("status_code", "payload", "expected"),
    [
        (200, {"prompt_id": "from-comfy"}, "from-comfy"),
        (200, {"node_errors": {"3": {"errors": []}}}, None),
        (400, {"error": "nope"}, None),
        (200, {}, "requested"),
    ],
)
def test_accepted_prompt_id_detects_rejection(
    status_code: int,
    payload: dict,
    expected: str | None,
) -> None:
    result = comfyui_generate_service.GenerationResult(
        content=json.dumps(payload).encode("utf-8"),
        status_code=status_code,
        media_type="application/json",
    )
    assert comfyui_router._accepted_prompt_id(result, "requested") == expected


@pytest.mark.anyio
async def test_a_transport_failure_after_reserving_keeps_the_monitor_alive(
    model_work_coordinator,
    local_comfyui: None,
) -> None:
    """The connection can fail after ComfyUI has already queued the prompt.

    Cancelling the monitor there would strand the occupancy with nothing left to
    release it, so an ambiguous failure leaves the delivery running instead.
    """

    cancelled: list[str] = []

    async def _cancel_monitor(delivery_id: str) -> None:
        cancelled.append(delivery_id)

    async def _ack(_project_id: str, _delivery_id: str) -> bool:
        cancelled.append("ack")
        return True

    original_cancel = comfyui_router.generation_holding_service.cancel_monitor
    original_ack = comfyui_router.generation_holding_service.acknowledge_delivery
    comfyui_router.generation_holding_service.cancel_monitor = _cancel_monitor  # type: ignore[assignment]
    comfyui_router.generation_holding_service.acknowledge_delivery = _ack  # type: ignore[assignment]
    try:
        await comfyui_router._abandon_delivery("project-1", "delivery-1", "prompt-1")
        assert cancelled == []  # Ambiguous: the monitor owns reconciliation.

        await comfyui_router._abandon_delivery("project-1", "delivery-1", None)
        assert cancelled == ["delivery-1", "ack"]  # Definitely never submitted.
    finally:
        comfyui_router.generation_holding_service.cancel_monitor = original_cancel  # type: ignore[assignment]
        comfyui_router.generation_holding_service.acknowledge_delivery = original_ack  # type: ignore[assignment]


@pytest.mark.anyio
async def test_a_failed_dispatch_transfers_the_reservation_to_the_monitor(
    monkeypatch: pytest.MonkeyPatch,
    model_work_coordinator,
    local_comfyui: None,
) -> None:
    admission = ComfyPromptAdmission(source="comfyui-vlo", label="flux render")
    admission.reserve()
    assert admission.holds_reservation is True

    # Standing in for the router's `except BaseException` around dispatch.
    admission.accept("prompt-1")
    admission.__exit__(httpx.RequestError, httpx.RequestError("boom"), None)

    assert model_work_coordinator.token_for_prompt("prompt-1") is not None
    assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is not None


@pytest.mark.anyio
async def test_execute_generation_admits_between_preprocess_and_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Holding the card through media upload would block local inference for
    work that has not started sampling yet."""

    order: list[str] = []

    async def fake_preprocess(_ctx: object) -> None:
        order.append("preprocess")

    async def fake_dispatch(ctx: object) -> None:
        order.append("dispatch")
        ctx.comfyui_response = httpx.Response(
            200,
            json={"prompt_id": "prompt-1"},
            request=httpx.Request("POST", "http://comfy/prompt"),
        )

    async def reserve() -> None:
        order.append("reserve")

    monkeypatch.setattr(comfyui_generate_service, "run_backend_preprocess", fake_preprocess)
    monkeypatch.setattr(comfyui_generate_service, "dispatch_to_comfyui", fake_dispatch)

    await comfyui_generate_service.execute_generation(
        comfyui_generate_service.GenerationInput(client_id="c", workflow={}),
        client=None,  # type: ignore[arg-type]
        before_dispatch=reserve,
    )

    assert order == ["preprocess", "reserve", "dispatch"]


# ---------------------------------------------------------------------------
# §6.1 — reconciliation watchdog
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_model_work_monitor_watchdog(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    model_work_coordinator,
    local_comfyui: None,
) -> None:
    monkeypatch.setattr(
        delivery_service_module, "MONITOR_BACKSTOP_ONLY_INITIAL_DELAY_SECONDS", 0
    )
    monkeypatch.setattr(delivery_service_module, "MONITOR_BACKSTOP_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(delivery_service_module, "MONITOR_UNREACHABLE_STALE_THRESHOLD", 2)
    monkeypatch.setattr(delivery_service_module, "MONITOR_BACKSTOP_MISS_THRESHOLD", 2)
    service = GenerationHoldingService(root=tmp_path / "holding")

    admission = ComfyPromptAdmission(source="comfyui-iframe", label="in-editor")
    admission.reserve()
    admission.accept("prompt-1")

    verdicts = iter(
        [
            ("unknown", None),  # ComfyUI unreachable
            ("unknown", None),  # ...still unreachable: retain and flag
            ("pending", None),  # back, and the prompt is queued
            ("completed", None),  # authoritative terminal verdict
        ]
    )
    seen: list[str] = []

    async def fake_reconcile(prompt_id: str) -> tuple[str, str | None]:
        assert prompt_id == "prompt-1"
        verdict = next(verdicts)
        seen.append(verdict[0])
        if verdict[0] == "unknown" and len(seen) == 2:
            # Occupancy is retained while ComfyUI cannot confirm the prompt.
            assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is not None
        return verdict

    monkeypatch.setattr(service, "_reconcile_prompt_state", fake_reconcile)

    await service.watch_unadopted_prompt("prompt-1")

    assert seen == ["unknown", "unknown", "pending", "completed"]
    assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is None


@pytest.mark.anyio
async def test_watchdog_flags_unreachable_comfyui_instead_of_releasing(
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
    service = GenerationHoldingService(root=tmp_path / "holding")

    admission = ComfyPromptAdmission(source="comfyui-vlo", label="flux render")
    admission.reserve()
    token = admission.accept("prompt-1")

    passes = 0

    async def always_unknown(_prompt_id: str) -> tuple[str, str | None]:
        nonlocal passes
        passes += 1
        if passes >= 3:
            # Stop the loop the only way that is legitimate: an explicit,
            # operator-driven unsafe release.
            model_work_coordinator.unsafe_release(token.entry_id)
        return "unknown", None

    monkeypatch.setattr(service, "_reconcile_prompt_state", always_unknown)

    await service.watch_unadopted_prompt("prompt-1")

    assert passes == 3
    assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is None


def test_settle_prompt_is_idempotent_and_prompt_scoped(
    model_work_coordinator,
    local_comfyui: None,
) -> None:
    first = ComfyPromptAdmission(source="comfyui-vlo", label="render A")
    first.reserve()
    first.accept("prompt-a")
    second = ComfyPromptAdmission(source="comfyui-vlo", label="render B")
    second.reserve()
    second.accept("prompt-b")

    comfyui_admission.settle_prompt("prompt-a", "succeeded")
    comfyui_admission.settle_prompt("prompt-a", "failed")

    # B's occupancy is untouched by A's duplicate terminal events.
    assert model_work_coordinator.token_for_prompt("prompt-b") is not None
    assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is not None

    comfyui_admission.settle_prompt("prompt-b", "succeeded")
    assert model_work_coordinator.describe_resource(LOCAL_GPU_RESOURCE) is None
