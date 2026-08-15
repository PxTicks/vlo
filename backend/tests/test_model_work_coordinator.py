"""Contract tests for the model-work coordinator.

These are preconditions for the unified queue, not follow-ups. The properties
under test are the ones a design review found the first implementation sketch
could not deliver: leases bound to physical execution rather than job state,
atomic admission across tenants, an atomic monitor handoff, restart recovery
before any admission, and a snapshot/subscribe handoff that loses no event.
"""

from __future__ import annotations

import asyncio
import threading
import time

import pytest

from services.model_work import coordinator as coordinator_module
from services.model_work import (
    LOCAL_GPU_RESOURCE,
    TENANT_BACKEND,
    TENANT_COMFYUI,
    CoordinatorNotReadyError,
    LeaseTimeoutError,
    ModelWorkCoordinator,
    PersistedOccupancy,
    run_with_lease,
)


def _ready_coordinator(**kwargs) -> ModelWorkCoordinator:
    coordinator = ModelWorkCoordinator(**kwargs)
    coordinator.mark_ready()
    return coordinator


def _reserve_backend(coordinator: ModelWorkCoordinator, label: str = "beats"):
    return coordinator.try_reserve_sync(
        resource=LOCAL_GPU_RESOURCE,
        tenant=TENANT_BACKEND,
        source="beats",
        label=label,
        owner="vlo.beats",
        sharing="exclusive",
    )


def _reserve_comfy(coordinator: ModelWorkCoordinator, label: str = "prompt"):
    return coordinator.try_reserve_sync(
        resource=LOCAL_GPU_RESOURCE,
        tenant=TENANT_COMFYUI,
        source="comfyui-vlo",
        label=label,
        owner="vlo.comfyui",
        sharing="tenant",
    )


def _entry_for(coordinator: ModelWorkCoordinator, entry_id: str):
    return coordinator.get_entry(entry_id)


# ---------------------------------------------------------------------------
# Lease lifetime is bound to execution, not to job state
# ---------------------------------------------------------------------------


def test_model_work_lease_retention() -> None:
    """A cancelled or timed-out job keeps the resource until its worker exits.

    ``concurrent_future.cancel()`` is a no-op on a running thread and Beat This!
    has no cooperative checkpoints at all, so ``cancelled`` must not be read as
    "the GPU is free".
    """

    coordinator = _ready_coordinator()
    lease = _reserve_backend(coordinator, "mask video")
    assert lease is not None

    # The job manager's timeout path fires: public status goes terminal while the
    # worker callable is still inside torch.
    lease.request_stop(message="timed out")
    entry = _entry_for(coordinator, lease.entry_id)
    assert entry is not None
    assert entry.job_status == "cancelled"
    assert entry.occupancy == "stopping"

    # Another tenant is refused for that entire window.
    assert _reserve_comfy(coordinator) is None

    lease.release("cancelled")

    entry = _entry_for(coordinator, lease.entry_id)
    assert entry is not None
    assert entry.occupancy == "released"
    assert entry.job_status == "cancelled"
    assert _reserve_comfy(coordinator) is not None


def test_run_with_lease_holds_until_the_callable_returns_by_raising() -> None:
    coordinator = _ready_coordinator()
    lease = _reserve_backend(coordinator)
    assert lease is not None
    observed: list[bool] = []
    released_hooks: list[str] = []

    def _explode() -> None:
        observed.append(_reserve_comfy(coordinator) is None)
        raise RuntimeError("inference blew up")

    with pytest.raises(RuntimeError):
        run_with_lease(lease, _explode, release_hook=lambda: released_hooks.append("vram"))

    assert observed == [True]  # Held for the whole physical call.
    assert released_hooks == ["vram"]  # Ran before the resource became available.
    entry = _entry_for(coordinator, lease.entry_id)
    assert entry is not None and entry.job_status == "failed"
    assert _reserve_comfy(coordinator) is not None


@pytest.mark.anyio
async def test_model_work_threadpool_cancellation() -> None:
    """Client disconnect must not release a lease owned by a worker thread."""

    coordinator = _ready_coordinator()
    inside = threading.Event()
    finish = threading.Event()
    holder: dict[str, object] = {}

    def _worker() -> str:
        lease = _reserve_backend(coordinator, "sam2 frame")
        assert lease is not None
        holder["entry_id"] = lease.entry_id

        def _inference() -> str:
            inside.set()
            finish.wait(5)
            return "png"

        return run_with_lease(lease, _inference)

    request = asyncio.get_running_loop().run_in_executor(None, _worker)
    await asyncio.to_thread(inside.wait, 5)

    # The request coroutine is cancelled (client went away); the worker is not.
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request

    assert _reserve_comfy(coordinator) is None
    entry_id = holder["entry_id"]
    assert isinstance(entry_id, str)
    entry = _entry_for(coordinator, entry_id)
    assert entry is not None and entry.occupancy == "occupied"

    finish.set()
    await asyncio.to_thread(_wait_until_free, coordinator)
    assert _reserve_comfy(coordinator) is not None


def _wait_until_free(coordinator: ModelWorkCoordinator, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snapshot = coordinator.snapshot()
        if all(view.holder_count == 0 for view in snapshot.resources):
            return
        time.sleep(0.01)
    raise AssertionError("resource never became free")


# ---------------------------------------------------------------------------
# Admission
# ---------------------------------------------------------------------------


def test_model_work_admission_atomicity() -> None:
    coordinator = _ready_coordinator()
    barrier = threading.Barrier(2)
    results: list[object] = []
    results_lock = threading.Lock()

    def _contend(reserve) -> None:
        barrier.wait(5)
        lease = reserve(coordinator)
        with results_lock:
            results.append(lease)

    threads = [
        threading.Thread(target=_contend, args=(_reserve_backend,)),
        threading.Thread(target=_contend, args=(_reserve_comfy,)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)

    admitted = [lease for lease in results if lease is not None]
    assert len(admitted) == 1

    # A second prompt joins the ComfyUI tenant only if ComfyUI won.
    winner = admitted[0]
    if winner.tenant == TENANT_COMFYUI:
        sibling = _reserve_comfy(coordinator, "second prompt")
        assert sibling is not None
        assert sibling.occupancy_id == winner.occupancy_id
        # ...and backend work still cannot get in alongside it.
        assert _reserve_backend(coordinator) is None
    else:
        assert _reserve_backend(coordinator, "second job") is None


def test_exclusive_tenant_never_shares_with_itself() -> None:
    coordinator = _ready_coordinator()
    assert _reserve_backend(coordinator, "beats") is not None
    assert _reserve_backend(coordinator, "sam2") is None


def test_unknown_tenant_cannot_promote_itself_to_shared() -> None:
    coordinator = _ready_coordinator()
    with pytest.raises(Exception):
        coordinator.try_reserve_sync(
            resource=LOCAL_GPU_RESOURCE,
            tenant="something-else",
            source="extension",
            label="rogue",
            owner="ext.rogue",
            sharing="tenant",
        )
    with pytest.raises(Exception):
        coordinator.try_reserve_sync(
            resource=LOCAL_GPU_RESOURCE,
            tenant=TENANT_BACKEND,
            source="beats",
            label="rogue",
            owner="vlo.beats",
            sharing="tenant",
        )


def test_observe_only_work_is_recorded_but_never_gates() -> None:
    coordinator = _ready_coordinator()
    observed = coordinator.try_reserve_sync(
        resource=None,
        tenant=None,
        source="comfyui-vlo",
        label="remote prompt",
        owner="vlo.comfyui",
    )
    assert observed is not None
    assert observed.resource is None
    assert _reserve_backend(coordinator) is not None

    entry = _entry_for(coordinator, observed.entry_id)
    assert entry is not None and entry.resource is None and entry.tenant is None


def test_reserve_sync_waits_then_times_out_with_the_current_occupant() -> None:
    coordinator = _ready_coordinator()
    blocker = _reserve_comfy(coordinator, "flux render")
    assert blocker is not None

    with pytest.raises(LeaseTimeoutError) as excinfo:
        coordinator.reserve_sync(
            resource=LOCAL_GPU_RESOURCE,
            tenant=TENANT_BACKEND,
            source="beats",
            label="beat detection",
            owner="vlo.beats",
            timeout=0.05,
        )

    assert "flux render" in (excinfo.value.occupied_by or "")
    # The abandoned waiter leaves no ledger residue.
    assert all(entry.label != "beat detection" for entry in coordinator.snapshot().entries)


def test_reserve_sync_is_admitted_when_the_occupant_releases() -> None:
    coordinator = _ready_coordinator()
    blocker = _reserve_comfy(coordinator, "flux render")
    assert blocker is not None
    admitted: list[object] = []

    def _wait_for_gpu() -> None:
        lease = coordinator.reserve_sync(
            resource=LOCAL_GPU_RESOURCE,
            tenant=TENANT_BACKEND,
            source="beats",
            label="beat detection",
            owner="vlo.beats",
            timeout=5,
        )
        admitted.append(lease)

    waiter = threading.Thread(target=_wait_for_gpu)
    waiter.start()
    # The waiting entry is visible while it waits: the queue is not a black box.
    _wait_for(lambda: any(e.occupancy == "waiting" for e in coordinator.snapshot().entries))
    blocker.release()
    waiter.join(5)

    assert len(admitted) == 1


def _wait_for(predicate, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition never became true")


@pytest.mark.anyio
async def test_async_reserve_does_not_block_the_event_loop() -> None:
    coordinator = _ready_coordinator()
    blocker = _reserve_comfy(coordinator, "flux render")
    assert blocker is not None

    ticks = 0

    async def _tick() -> None:
        nonlocal ticks
        for _ in range(3):
            ticks += 1
            await asyncio.sleep(0)

    async def _acquire():
        return await coordinator.reserve(
            resource=LOCAL_GPU_RESOURCE,
            tenant=TENANT_BACKEND,
            source="sam2",
            label="mask video",
            owner="vlo.sam2",
            timeout=5,
        )

    acquisition = asyncio.ensure_future(_acquire())
    await _tick()
    assert ticks == 3  # The loop kept running while admission was pending.

    blocker.release()
    lease = await asyncio.wait_for(acquisition, 5)
    assert lease.tenant == TENANT_BACKEND


@pytest.mark.anyio
async def test_async_reserve_timeout_removes_the_waiting_entry() -> None:
    coordinator = _ready_coordinator()
    assert _reserve_comfy(coordinator) is not None

    with pytest.raises(LeaseTimeoutError):
        await coordinator.reserve(
            resource=LOCAL_GPU_RESOURCE,
            tenant=TENANT_BACKEND,
            source="sam2",
            label="mask video",
            owner="vlo.sam2",
            timeout=0.05,
        )

    assert all(entry.label != "mask video" for entry in coordinator.snapshot().entries)


# ---------------------------------------------------------------------------
# Monitor transfer
# ---------------------------------------------------------------------------


def test_a_terminal_event_that_beats_its_own_transfer_keeps_its_verdict() -> None:
    """The monitor can settle a prompt before the HTTP response that created
    the lease gets back to the router. The verdict must not be lost — a failed
    generation left reading "running" raises no notification and never clears."""

    coordinator = _ready_coordinator()
    lease = _reserve_comfy(coordinator, "prompt A")
    assert lease is not None

    coordinator.settle_token("prompt-a", verdict="failed")
    token = lease.transfer("prompt-a")

    entry = _entry_for(coordinator, token.entry_id)
    assert entry is not None
    assert entry.job_status == "failed"
    assert entry.occupancy == "released"
    assert _reserve_backend(coordinator) is not None


def test_settled_prompt_verdicts_are_bounded() -> None:
    coordinator = _ready_coordinator()
    limit = coordinator_module.MAX_SETTLED_PROMPT_VERDICTS

    for index in range(limit + 25):
        coordinator.settle_token(f"prompt-{index}", verdict="succeeded")

    assert len(coordinator._settled_prompts) == limit
    assert "prompt-0" not in coordinator._settled_prompts
    assert f"prompt-{limit + 24}" in coordinator._settled_prompts


def test_model_work_monitor_transfer() -> None:
    coordinator = _ready_coordinator()
    lease = _reserve_comfy(coordinator, "prompt A")
    assert lease is not None

    token = lease.transfer("prompt-a")
    assert not lease.active
    # Transfer is fail-closed: the request handle can no longer free the GPU.
    lease.release()
    assert _reserve_backend(coordinator) is None

    token.settle_sync("succeeded")
    token.settle_sync("failed")  # Duplicate terminal events are no-ops.

    entry = _entry_for(coordinator, token.entry_id)
    assert entry is not None
    assert entry.job_status == "succeeded"
    assert entry.occupancy == "released"
    assert _reserve_backend(coordinator) is not None


def test_transfer_is_idempotent_across_restore_and_live_races() -> None:
    coordinator = ModelWorkCoordinator()
    restored = coordinator.restore_prompt_token(
        PersistedOccupancy(
            prompt_id="prompt-a",
            source="comfyui-vlo",
            owner="vlo.comfyui",
            label="restored prompt",
        )
    )
    coordinator.mark_ready()

    # The live response for the same prompt arrives after restore rebuilt it.
    lease = _reserve_comfy(coordinator, "prompt A")
    assert lease is not None
    token = lease.transfer("prompt-a")
    assert token.entry_id == restored.entry_id

    # One settle frees the one occupancy; nothing leaked and nothing else was
    # double-released.
    token.settle_sync("succeeded")
    assert _reserve_backend(coordinator) is not None


def test_multiple_prompt_children_release_only_after_the_last_settles() -> None:
    coordinator = _ready_coordinator()
    first = _reserve_comfy(coordinator, "prompt A")
    second = _reserve_comfy(coordinator, "prompt B")
    assert first is not None and second is not None

    token_a = first.transfer("prompt-a")
    token_b = second.transfer("prompt-b")

    token_a.settle_sync()
    assert _reserve_backend(coordinator) is None  # ComfyUI still owns the GPU.

    token_b.settle_sync()
    assert _reserve_backend(coordinator) is not None


def test_suspected_stale_occupancy_is_retained_until_explicitly_released() -> None:
    coordinator = _ready_coordinator()
    lease = _reserve_comfy(coordinator, "prompt A")
    assert lease is not None
    token = lease.transfer("prompt-a")

    token.mark_suspected_stale_sync("ComfyUI unreachable")
    entry = _entry_for(coordinator, token.entry_id)
    assert entry is not None and entry.suspected_stale is True
    assert _reserve_backend(coordinator) is None  # Never released on a timeout.

    assert coordinator.unsafe_release(token.entry_id) is True
    assert _reserve_backend(coordinator) is not None


def test_context_manager_release_frees_a_rejected_prompt_child() -> None:
    coordinator = _ready_coordinator()
    lease = _reserve_comfy(coordinator, "prompt A")
    assert lease is not None

    with pytest.raises(RuntimeError):
        with lease:
            raise RuntimeError("ComfyUI rejected the prompt")

    assert _reserve_backend(coordinator) is not None


# ---------------------------------------------------------------------------
# Restart recovery
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_model_work_restart_recovery() -> None:
    coordinator = ModelWorkCoordinator()
    assert coordinator.ready() is False

    with pytest.raises(CoordinatorNotReadyError):
        _reserve_backend(coordinator)

    await coordinator.restore(
        [
            PersistedOccupancy(
                prompt_id="prompt-a",
                source="comfyui-vlo",
                owner="vlo.comfyui",
                label="queued render",
                job_status="queued",
            ),
            PersistedOccupancy(
                prompt_id="prompt-b",
                source="comfyui-iframe",
                owner="vlo.comfyui",
                label="running render",
            ),
        ]
    )

    assert coordinator.ready() is True
    # Both prompts rebuilt one shared ComfyUI occupancy that still excludes local work.
    assert _reserve_backend(coordinator) is None

    token_a = coordinator.token_for_prompt("prompt-a")
    token_b = coordinator.token_for_prompt("prompt-b")
    assert token_a is not None and token_b is not None
    token_a.settle_sync()
    token_b.settle_sync()
    assert _reserve_backend(coordinator) is not None


# ---------------------------------------------------------------------------
# Event transport
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_model_work_event_handoff() -> None:
    coordinator = _ready_coordinator()
    lease = _reserve_backend(coordinator, "before subscribe")
    assert lease is not None

    stream = coordinator.open_stream()
    try:
        snapshot = stream.snapshot
        assert [entry.label for entry in snapshot.entries] == ["before subscribe"]

        lease.release()
        second = _reserve_comfy(coordinator, "after subscribe")
        assert second is not None

        events = []
        async for event in stream.events():
            events.append(event)
            if len(events) == 2:
                break

        # No event fell between snapshot creation and subscription, and the
        # revisions continue from the snapshot without a gap.
        assert [event.revision for event in events] == [
            snapshot.revision + 1,
            snapshot.revision + 2,
        ]
        assert events[0].entry.occupancy == "released"
        assert events[1].entry.label == "after subscribe"
        assert events[1].resources[0].tenant == TENANT_COMFYUI
    finally:
        stream.close()


@pytest.mark.anyio
async def test_subscriber_overflow_surfaces_an_explicit_gap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A dropped backlog must be observable, not silently contiguous.

    Without a marker the consumer reads a prefix, sees no revision jump, and
    keeps applying deltas to state it has already lost.
    """

    monkeypatch.setattr(coordinator_module, "SUBSCRIBER_QUEUE_SIZE", 2)
    coordinator = _ready_coordinator()
    stream = coordinator.open_stream()
    try:
        for index in range(6):
            lease = _reserve_backend(coordinator, f"job {index}")
            assert lease is not None
            lease.release()
            await asyncio.sleep(0)

        # The backlog is replaced, not appended to: what is left is the marker
        # alone, so there is no contiguous prefix to mislead the consumer.
        received = []
        while not stream._subscriber.queue.empty():
            received.append(stream._subscriber.queue.get_nowait())
        assert received == [coordinator_module.LEDGER_GAP]

        # Delivery stays suspended until the consumer resynchronises...
        lease = _reserve_backend(coordinator, "after gap")
        assert lease is not None
        await asyncio.sleep(0)
        assert stream._subscriber.queue.empty()

        # ...and the resync hands back current truth, not a replayed backlog.
        snapshot = stream.resync()
        assert any(entry.label == "after gap" for entry in snapshot.entries)

        lease.release()
        await asyncio.sleep(0)
        resumed = await asyncio.wait_for(stream._subscriber.queue.get(), 1)
        assert resumed is not coordinator_module.LEDGER_GAP
    finally:
        stream.close()


@pytest.mark.anyio
async def test_closed_streams_stop_receiving_events() -> None:
    coordinator = _ready_coordinator()
    stream = coordinator.open_stream()
    stream.close()

    lease = _reserve_backend(coordinator)
    assert lease is not None
    assert stream._subscriber.queue.empty()
