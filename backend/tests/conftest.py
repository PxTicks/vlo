"""Shared backend test configuration.

``pythonpath = ["."]`` in ``pyproject.toml`` puts the backend root on ``sys.path``,
so test modules import ``services.*`` / ``routers.*`` / ``main`` directly. No
per-file ``sys.path`` manipulation is needed.
"""

from __future__ import annotations

import pytest


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    """Run every ``@pytest.mark.anyio`` test on the asyncio backend."""
    return "asyncio"


@pytest.fixture(autouse=True)
def model_work_coordinator():
    """Give each test a fresh, ready model-work coordinator.

    Production starts the coordinator *not ready* and opens admission from the
    application lifespan once in-flight ComfyUI prompts have been restored. A
    test that calls a service directly never runs that lifespan, and a lease
    left held by one test would refuse admission in the next, so the singleton
    is rebuilt per test. Tests that need the not-ready gate construct their own
    ``ModelWorkCoordinator``.
    """
    from services import model_work

    coordinator = model_work.reset_model_work_coordinator()
    coordinator.mark_ready()
    yield coordinator
    model_work.reset_model_work_coordinator()


@pytest.fixture
def fast_delivery_timings(monkeypatch: pytest.MonkeyPatch) -> None:
    """Collapse the generation-delivery monitor's wall-clock waits to ~0.

    The monitor's real delays (a 10 s websocket-grace backstop, a 5 s connect
    timeout, reconnect backoff) exist to be patient in production; in tests that
    exercise the monitor/backstop flow but do not assert on timing they are pure
    dead wait. Opt in via this fixture rather than autouse: a few tests patch
    these constants themselves to assert timeout behaviour, and an autouse
    fixture would mask that.
    """
    from services.generation_delivery import service as delivery_service_module

    near_zero = {
        "HISTORY_FETCH_RETRY_SECONDS": 0,
        "MONITOR_CONNECT_TIMEOUT_SECONDS": 0.05,
        "MONITOR_RECONNECT_BASE_DELAY_SECONDS": 0,
        "MONITOR_RECONNECT_MAX_DELAY_SECONDS": 0,
        "MONITOR_BACKSTOP_INITIAL_DELAY_SECONDS": 0,
        "MONITOR_BACKSTOP_INTERVAL_SECONDS": 0,
        "MONITOR_BACKSTOP_QUEUED_INTERVAL_SECONDS": 0,
        "MONITOR_BACKSTOP_ONLY_INITIAL_DELAY_SECONDS": 0,
    }
    for name, value in near_zero.items():
        monkeypatch.setattr(delivery_service_module, name, value)


@pytest.fixture
def stub_comfyui_http(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace the shared ComfyUI httpx client with an offline stub.

    Several delivery paths (``_finalize_delivery`` → history-metadata
    enrichment, reconcile) fetch ``/history`` from ComfyUI. A test that does not
    assert on that data should not make a real connection — otherwise it hangs
    on the client's 10 s connect timeout whenever nothing answers on the
    configured URL, which is exactly what happens in CI and on dev machines
    without ComfyUI running.
    """
    from services.generation_delivery import service as delivery_service_module

    class _StubResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {}

    class _StubClient:
        async def get(self, *_args, **_kwargs) -> "_StubResponse":
            return _StubResponse()

    async def _stub_get_http_client() -> "_StubClient":
        return _StubClient()

    monkeypatch.setattr(
        delivery_service_module, "get_http_client", _stub_get_http_client
    )


@pytest.fixture
def reset_hardware_probe_cache():
    """Clear the process-global VRAM cache around a test.

    ``services.hardware.detect_local_vram`` memoises its result in a module
    global with a TTL, so without this a test that lets the real probe run (or
    patches it) leaks its value into later tests — an order-dependent flake.
    Scoped to the hardware-touching tests, not autouse, so the whole suite is
    not coupled to a private production global.
    """
    from services import hardware

    hardware._cached_local_vram = None
    yield
    hardware._cached_local_vram = None
