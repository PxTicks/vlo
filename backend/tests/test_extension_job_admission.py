"""Extension jobs inside the model-work queue (backend-extension-contract §5 Phase E).

Before this, an extension registering a GPU capability got a Test-runtime probe
that took a real exclusive lease while its actual inference job — the thing that
runs all day — took nothing. The cheap diagnostic was admitted and the expensive
real work was not.

What these tests hold is that the asymmetry is gone, and gone *structurally*:
the extension declares that a job uses the GPU, and the host takes the lease.
Ownership, quota and cancellation stay extension-scoped; only the reservation
joins the exclusive ``backend-process`` tenant, because an extension's model
runs in this process against this VRAM.
"""

from __future__ import annotations

import asyncio
import threading
import time

import pytest

from services.jobs.artifacts import JobArtifactStore
from services.jobs.manager import (
    BackendJobDefinition,
    BackendJobManager,
    BackendJobValidationError,
)
from services.model_work import (
    LOCAL_GPU_RESOURCE,
    TENANT_BACKEND,
    get_model_work_coordinator,
)
from services.model_work.local_inference import holds_local_gpu, local_gpu_lease


OTHER_EXTENSION_ID = "acme.captions"


EXTENSION_ID = "acme.tracking"
WORK_SOURCE = "extension"


def _manager(tmp_path, **kwargs) -> BackendJobManager:
    return BackendJobManager(
        JobArtifactStore(tmp_path / "job-artifacts"),
        work_source=WORK_SOURCE,
        max_concurrent_jobs_per_owner=2,
        **kwargs,
    )


def _register(manager: BackendJobManager, *definitions: BackendJobDefinition) -> None:
    manager.register_owner(EXTENSION_ID, "1.0.0", definitions)


async def _close(manager: BackendJobManager) -> None:
    """Shut down, and wait for the worker threads to actually be gone.

    ``shutdown_all`` deliberately does not wait — a runner that ignores
    cancellation must not hold up the server. In a test that means a thread
    from one case can still be unwinding during the next, which is how these
    cases started perturbing unrelated ones.
    """

    await manager.shutdown_all()
    manager._executor.shutdown(wait=True)
    if manager._gpu_executor is not None:
        manager._gpu_executor.shutdown(wait=True)


async def _drain(
    manager: BackendJobManager,
    job_id: str,
    *,
    owner_id: str = EXTENSION_ID,
    timeout: float = 5.0,
):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snapshot = manager.get(owner_id, job_id)
        if snapshot.status in ("succeeded", "failed", "cancelled"):
            return snapshot
        await asyncio.sleep(0.01)
    raise AssertionError(f"job {job_id} did not settle: {snapshot.status}")


def _entries(source: str | None = None):
    """Live ledger entries. Released ones are kept as queue-panel history."""

    snapshot = get_model_work_coordinator().snapshot()
    return [
        entry
        for entry in snapshot.entries
        if (source is None or entry.source == source)
        and entry.occupancy != "released"
    ]


async def _reach(event: threading.Event, timeout: float = 5.0) -> bool:
    """Wait for a worker thread without blocking the loop that dispatches it.

    A plain ``event.wait()`` here would stall the event loop before the job
    task had been scheduled, so the worker being waited for would never start.
    """

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if event.is_set():
            return True
        await asyncio.sleep(0.01)
    return False


# --------------------------------------------------------------------------
# The governing case
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_gpu_job_holds_the_local_gpu_as_the_backend_tenant(
    tmp_path,
    model_work_coordinator,
) -> None:
    observed: dict[str, object] = {}
    inside = threading.Event()
    release = threading.Event()

    def run(context, value):
        # The lease belongs to this worker thread, which is what makes a nested
        # host inference call pass through instead of deadlocking.
        observed["held"] = holds_local_gpu()
        observed["entries"] = [
            (entry.source, entry.owner, entry.tenant, entry.resource, entry.occupancy)
            for entry in _entries(WORK_SOURCE)
        ]
        inside.set()
        release.wait(5)
        return {"ok": True}

    manager = _manager(tmp_path)
    _register(
        manager,
        BackendJobDefinition(
            id="track",
            label="Track subject",
            run=run,
            uses_local_gpu=True,
        ),
    )
    try:
        snapshot = await manager.submit(EXTENSION_ID, "track", {})
        assert await _reach(inside)
        release.set()
        settled = await _drain(manager, snapshot.identity.job_id)
    finally:
        release.set()
        await _close(manager)

    assert settled.status == "succeeded"
    assert observed["held"] is True
    assert observed["entries"] == [
        ("extension", EXTENSION_ID, TENANT_BACKEND, LOCAL_GPU_RESOURCE, "occupied")
    ]


@pytest.mark.asyncio
async def test_a_gpu_job_cannot_run_beside_native_local_inference(
    tmp_path,
    model_work_coordinator,
) -> None:
    # The claim the whole queue exists to make: an extension's model and SAM2
    # are not resident at the same time.
    started = threading.Event()
    ran = threading.Event()

    def run(context, value):
        ran.set()
        return {"ok": True}

    manager = _manager(tmp_path)
    _register(
        manager,
        BackendJobDefinition(
            id="track",
            label="Track subject",
            run=run,
            uses_local_gpu=True,
        ),
    )

    def hold_native() -> None:
        with local_gpu_lease(
            source="sam2",
            label="Propagate masks",
            owner="sam2-service",
        ):
            started.set()
            time.sleep(0.35)

    native = threading.Thread(target=hold_native)
    try:
        native.start()
        assert await _reach(started)
        snapshot = await manager.submit(EXTENSION_ID, "track", {})

        # SAM2 holds the resource: the extension's job is admitted-pending, so
        # it must not have executed a line of its runner yet.
        await asyncio.sleep(0.1)
        assert not ran.is_set()
        assert manager.get(EXTENSION_ID, snapshot.identity.job_id).status == "queued"
        waiting = [entry for entry in _entries(WORK_SOURCE)]
        assert [entry.occupancy for entry in waiting] == ["waiting"]

        settled = await _drain(manager, snapshot.identity.job_id)
    finally:
        native.join(5)
        await _close(manager)

    assert settled.status == "succeeded"
    assert ran.is_set()


@pytest.mark.asyncio
async def test_execution_timeout_starts_at_admission_not_at_submission(
    tmp_path,
    model_work_coordinator,
) -> None:
    # A job whose timeout ran while it sat in the queue would fail without ever
    # touching the model, and would do so more often the busier the machine is.
    started = threading.Event()

    def run(context, value):
        return {"ok": True}

    manager = _manager(tmp_path)
    _register(
        manager,
        BackendJobDefinition(
            id="track",
            label="Track subject",
            run=run,
            uses_local_gpu=True,
            timeout_seconds=0.75,
        ),
    )

    def hold_native() -> None:
        with local_gpu_lease(source="sam2", label="Propagate", owner="sam2-service"):
            started.set()
            time.sleep(1.2)

    native = threading.Thread(target=hold_native)
    try:
        native.start()
        assert await _reach(started)
        snapshot = await manager.submit(EXTENSION_ID, "track", {})
        settled = await _drain(manager, snapshot.identity.job_id, timeout=8.0)
    finally:
        native.join(5)
        await _close(manager)

    assert settled.status == "succeeded", settled.error


# --------------------------------------------------------------------------
# Cancellation
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cancelling_a_queued_job_leaves_the_gpu_queue(
    tmp_path,
    model_work_coordinator,
) -> None:
    # Without an abandonable wait the cancelled job keeps its place in the
    # queue until it is admitted to work nobody wants any more.
    started = threading.Event()
    ran = threading.Event()

    def run(context, value):
        ran.set()
        return {"ok": True}

    manager = _manager(tmp_path)
    _register(
        manager,
        BackendJobDefinition(
            id="track",
            label="Track subject",
            run=run,
            uses_local_gpu=True,
        ),
    )

    def hold_native() -> None:
        with local_gpu_lease(source="sam2", label="Propagate", owner="sam2-service"):
            started.set()
            time.sleep(0.6)

    native = threading.Thread(target=hold_native)
    try:
        native.start()
        assert await _reach(started)
        snapshot = await manager.submit(EXTENSION_ID, "track", {})
        await asyncio.sleep(0.05)
        cancelled = await manager.cancel(EXTENSION_ID, snapshot.identity.job_id)

        # Cancelled, and gone from the queue well before SAM2 lets go.
        assert cancelled.status == "cancelled"
        deadline = time.monotonic() + 2.0
        while _entries(WORK_SOURCE) and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
        assert _entries(WORK_SOURCE) == []
        assert not ran.is_set()
    finally:
        native.join(5)
        await _close(manager)


@pytest.mark.asyncio
async def test_cancelling_a_running_job_marks_the_entry_stopping(
    tmp_path,
    model_work_coordinator,
) -> None:
    # Publicly cancelled, physically still resident: the ledger must not say
    # the GPU is free while the worker is still inside the model.
    inside = threading.Event()
    release = threading.Event()

    def run(context, value):
        context.report_progress(0.4, "Tracking frames")
        inside.set()
        release.wait(5)
        context.raise_if_cancelled()
        return {"ok": True}

    manager = _manager(tmp_path)
    _register(
        manager,
        BackendJobDefinition(
            id="track",
            label="Track subject",
            run=run,
            uses_local_gpu=True,
        ),
    )
    try:
        snapshot = await manager.submit(EXTENSION_ID, "track", {})
        assert await _reach(inside)

        # Progress reached the queue panel, not just the job.
        running = _entries(WORK_SOURCE)
        assert [entry.message for entry in running] == ["Tracking frames"]
        assert running[0].progress == pytest.approx(0.4)

        cancelling = asyncio.create_task(
            manager.cancel(EXTENSION_ID, snapshot.identity.job_id)
        )
        await asyncio.sleep(0.05)
        stopping = _entries(WORK_SOURCE)
        assert [entry.occupancy for entry in stopping] == ["stopping"]

        release.set()
        cancelled = await cancelling
    finally:
        release.set()
        await _close(manager)

    assert cancelled.status == "cancelled"
    # The public job is terminal, but the resource is released by the worker
    # thread, on its own schedule — the two statuses are independent by
    # design, and a released-on-cancel entry would be the ledger lying about
    # a model that is still resident.
    deadline = time.monotonic() + 2.0
    while _entries(WORK_SOURCE) and time.monotonic() < deadline:
        await asyncio.sleep(0.02)
    assert _entries(WORK_SOURCE) == []


# --------------------------------------------------------------------------
# What a definition may declare
# --------------------------------------------------------------------------


def test_a_manager_with_no_work_source_refuses_a_gpu_job(tmp_path) -> None:
    # An entry with no source is one the queue panel cannot attribute, so the
    # declaration is refused rather than silently ignored.
    manager = BackendJobManager(JobArtifactStore(tmp_path / "job-artifacts"))
    try:
        with pytest.raises(BackendJobValidationError, match="no work_source"):
            manager.register_owner(
                EXTENSION_ID,
                "1.0.0",
                (
                    BackendJobDefinition(
                        id="track",
                        label="Track subject",
                        run=lambda context, value: None,
                        uses_local_gpu=True,
                    ),
                ),
            )
    finally:
        asyncio.run(_close(manager))


def test_a_gpu_job_must_be_synchronous(tmp_path) -> None:
    async def run(context, value):
        return {"ok": True}

    manager = _manager(tmp_path)
    try:
        with pytest.raises(BackendJobValidationError, match="must be synchronous"):
            _register(
                manager,
                BackendJobDefinition(
                    id="track",
                    label="Track subject",
                    run=run,
                    uses_local_gpu=True,
                ),
            )
    finally:
        asyncio.run(_close(manager))


@pytest.mark.asyncio
async def test_a_gpu_job_returning_an_awaitable_fails_rather_than_releasing_early(
    tmp_path,
    model_work_coordinator,
) -> None:
    # The synchronous callable that hands its work back to the event loop: the
    # lease would be released here, with the model still to be used.
    async def deferred():
        return {"ok": True}

    def run(context, value):
        return deferred()

    manager = _manager(tmp_path)
    _register(
        manager,
        BackendJobDefinition(
            id="track",
            label="Track subject",
            run=run,
            uses_local_gpu=True,
        ),
    )
    try:
        snapshot = await manager.submit(EXTENSION_ID, "track", {})
        settled = await _drain(manager, snapshot.identity.job_id)
    finally:
        await _close(manager)

    assert settled.status == "failed"
    assert "must not return an awaitable" in (settled.error or "")
    assert _entries(WORK_SOURCE) == []


@pytest.mark.asyncio
async def test_a_job_that_does_not_declare_the_gpu_takes_no_lease(
    tmp_path,
    model_work_coordinator,
) -> None:
    # Quota is not admission: an extension's CPU work is unaffected by this
    # seam and must not queue behind SAM2.
    observed: dict[str, object] = {}

    def run(context, value):
        observed["held"] = holds_local_gpu()
        observed["entries"] = list(_entries(WORK_SOURCE))
        return {"ok": True}

    manager = _manager(tmp_path)
    _register(
        manager,
        BackendJobDefinition(id="report", label="Summarise", run=run),
    )
    try:
        snapshot = await manager.submit(EXTENSION_ID, "report", {})
        settled = await _drain(manager, snapshot.identity.job_id)
    finally:
        await _close(manager)

    assert settled.status == "succeeded"
    assert observed["held"] is False
    assert observed["entries"] == []


# --------------------------------------------------------------------------
# Waiting for the GPU costs no worker thread
# --------------------------------------------------------------------------


def _cpu_and_gpu_manager(tmp_path, *, executor_max_workers: int):
    """A manager whose general pool is deliberately small.

    The point of these cases is what a *queued* or *running* GPU job does to
    everything else in the pool, so the pool has to be small enough that a GPU
    job holding a thread would be visible.
    """

    return BackendJobManager(
        JobArtifactStore(tmp_path / "job-artifacts"),
        work_source=WORK_SOURCE,
        executor_max_workers=executor_max_workers,
    )


@pytest.mark.asyncio
async def test_queued_gpu_jobs_do_not_occupy_the_general_pool(
    tmp_path,
    model_work_coordinator,
) -> None:
    # The bug this seam fixes: the wait for `local-gpu` used to happen on the
    # worker thread that would go on to run the model, so enough queued GPU
    # jobs filled the pool and an unrelated extension's CPU job — which wants
    # nothing from the card — sat behind them.
    started = threading.Event()
    finished_native = threading.Event()
    cpu_ran = threading.Event()

    def gpu_run(context, value):
        return {"ok": True}

    def cpu_run(context, value):
        cpu_ran.set()
        return {"ok": True}

    manager = _cpu_and_gpu_manager(tmp_path, executor_max_workers=2)
    _register(
        manager,
        BackendJobDefinition(
            id="track",
            label="Track subject",
            run=gpu_run,
            uses_local_gpu=True,
        ),
    )
    manager.register_owner(
        OTHER_EXTENSION_ID,
        "1.0.0",
        (BackendJobDefinition(id="caption", label="Caption", run=cpu_run),),
    )

    def hold_native() -> None:
        with local_gpu_lease(source="sam2", label="Propagate", owner="sam2-service"):
            started.set()
            finished_native.wait(5)

    native = threading.Thread(target=hold_native)
    try:
        native.start()
        assert await _reach(started)

        # Three queued GPU jobs against a two-thread pool: on the old shape
        # both threads are blocked in the admission wait before the CPU job is
        # ever dispatched.
        queued = [
            await manager.submit(EXTENSION_ID, "track", {}) for _ in range(3)
        ]
        cpu = await manager.submit(OTHER_EXTENSION_ID, "caption", {})

        settled_cpu = await _drain(
            manager,
            cpu.identity.job_id,
            owner_id=OTHER_EXTENSION_ID,
            timeout=3.0,
        )
        assert settled_cpu.status == "succeeded"
        assert cpu_ran.is_set()

        # And the GPU jobs really were still queued while that happened.
        assert [entry.occupancy for entry in _entries(WORK_SOURCE)] == [
            "waiting"
        ] * 3
        assert all(
            manager.get(EXTENSION_ID, snapshot.identity.job_id).status == "queued"
            for snapshot in queued
        )

        finished_native.set()
        for snapshot in queued:
            assert (
                await _drain(manager, snapshot.identity.job_id, timeout=8.0)
            ).status == "succeeded"
    finally:
        finished_native.set()
        native.join(5)
        await _close(manager)


@pytest.mark.asyncio
async def test_a_running_gpu_job_does_not_occupy_the_general_pool(
    tmp_path,
    model_work_coordinator,
) -> None:
    # Admitted work runs on its own pool, sized to what may be admitted at
    # once: a GPU job that had to queue for a general worker after admission
    # would hold the card idle while it waited, and one that took a general
    # worker would be the head-of-line blocking again by another route.
    inside = threading.Event()
    release = threading.Event()
    cpu_ran = threading.Event()

    def gpu_run(context, value):
        inside.set()
        release.wait(5)
        return {"ok": True}

    def cpu_run(context, value):
        cpu_ran.set()
        return {"ok": True}

    manager = _cpu_and_gpu_manager(tmp_path, executor_max_workers=1)
    _register(
        manager,
        BackendJobDefinition(
            id="track",
            label="Track subject",
            run=gpu_run,
            uses_local_gpu=True,
        ),
    )
    manager.register_owner(
        OTHER_EXTENSION_ID,
        "1.0.0",
        (BackendJobDefinition(id="caption", label="Caption", run=cpu_run),),
    )
    try:
        gpu = await manager.submit(EXTENSION_ID, "track", {})
        assert await _reach(inside)

        cpu = await manager.submit(OTHER_EXTENSION_ID, "caption", {})
        settled_cpu = await _drain(
            manager,
            cpu.identity.job_id,
            owner_id=OTHER_EXTENSION_ID,
            timeout=3.0,
        )
        assert settled_cpu.status == "succeeded"
        assert cpu_ran.is_set()

        release.set()
        assert (
            await _drain(manager, gpu.identity.job_id)
        ).status == "succeeded"
    finally:
        release.set()
        await _close(manager)


@pytest.mark.asyncio
async def test_an_admission_no_worker_can_take_is_released_by_the_caller(
    tmp_path,
    model_work_coordinator,
) -> None:
    # Ownership passes to the worker callable, so its `finally` is what
    # releases. If the callable can never run, nobody is left to do it — the
    # coroutine has to, or the card never comes back.
    ran = threading.Event()

    def run(context, value):
        ran.set()
        return {"ok": True}

    manager = _cpu_and_gpu_manager(tmp_path, executor_max_workers=1)
    _register(
        manager,
        BackendJobDefinition(
            id="track",
            label="Track subject",
            run=run,
            uses_local_gpu=True,
        ),
    )
    try:
        # A GPU pool that refuses every submission.
        manager._gpu_worker_pool().shutdown(wait=True)

        snapshot = await manager.submit(EXTENSION_ID, "track", {})
        settled = await _drain(manager, snapshot.identity.job_id)

        assert settled.status == "failed"
        assert not ran.is_set()
        # Admitted, then handed back: nothing is left holding `local-gpu`.
        assert _entries(WORK_SOURCE) == []
        with local_gpu_lease(
            source="sam2",
            label="Propagate",
            owner="sam2-service",
            fail_fast=True,
        ):
            pass
    finally:
        await _close(manager)


@pytest.mark.asyncio
async def test_cancelling_before_the_worker_starts_releases_the_admission(
    tmp_path,
    model_work_coordinator,
) -> None:
    # The other path where the wrapper never runs: the future was still
    # pending when it was cancelled. A `Future.add_done_callback` would fire
    # here too — off any worker thread, with the callable never entered — which
    # is why the release lives in the wrapper and this one case is explicit.
    ran = threading.Event()
    occupied = threading.Event()
    release_pool = threading.Event()

    def run(context, value):
        ran.set()
        return {"ok": True}

    manager = _cpu_and_gpu_manager(tmp_path, executor_max_workers=1)
    _register(
        manager,
        BackendJobDefinition(
            id="track",
            label="Track subject",
            run=run,
            uses_local_gpu=True,
        ),
    )
    try:
        # Occupy the GPU pool's only thread with something that is not a job,
        # so an admitted job's submission stays pending.
        pool = manager._gpu_worker_pool()
        pool.submit(lambda: (occupied.set(), release_pool.wait(5)))
        assert await _reach(occupied)

        snapshot = await manager.submit(EXTENSION_ID, "track", {})
        # Admitted — the entry exists and holds the resource — but pending.
        deadline = time.monotonic() + 2.0
        while not _entries(WORK_SOURCE) and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        assert [entry.occupancy for entry in _entries(WORK_SOURCE)] == ["occupied"]

        cancelled = await manager.cancel(EXTENSION_ID, snapshot.identity.job_id)
        assert cancelled.status == "cancelled"
        assert not ran.is_set()
        assert _entries(WORK_SOURCE) == []
    finally:
        release_pool.set()
        await _close(manager)


# --------------------------------------------------------------------------
# The ledger and the job record may differ, but they may not contradict
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_timed_out_job_whose_worker_returns_normally_stays_failed(
    tmp_path,
    model_work_coordinator,
) -> None:
    # The record goes terminal on timeout while the thread is still inside the
    # model. If the entry were left non-terminal, the eventual clean return
    # would release it as *succeeded* — the queue reporting success for a job
    # the user was told had timed out.
    release = threading.Event()
    inside = threading.Event()

    def run(context, value):
        inside.set()
        release.wait(5)          # ignores cancellation, like a torch call
        return {"ok": True}

    manager = _manager(tmp_path)
    _register(
        manager,
        BackendJobDefinition(
            id="track",
            label="Track subject",
            run=run,
            uses_local_gpu=True,
            timeout_seconds=0.3,
        ),
    )
    try:
        snapshot = await manager.submit(EXTENSION_ID, "track", {})
        assert await _reach(inside)
        settled = await _drain(manager, snapshot.identity.job_id)
        assert settled.status == "failed"

        # Publicly failed, physically still resident.
        resident = _entries(WORK_SOURCE)
        assert [(entry.job_status, entry.occupancy) for entry in resident] == [
            ("failed", "stopping")
        ]

        release.set()
        deadline = time.monotonic() + 2.0
        while _entries(WORK_SOURCE) and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
    finally:
        release.set()
        await _close(manager)

    history = [
        entry
        for entry in get_model_work_coordinator().snapshot().entries
        if entry.source == WORK_SOURCE
    ]
    assert [(entry.job_status, entry.occupancy) for entry in history] == [
        ("failed", "released")
    ]


@pytest.mark.asyncio
async def test_a_result_rejected_after_release_does_not_leave_a_succeeded_entry(
    tmp_path,
    model_work_coordinator,
) -> None:
    # Result validation runs after the worker callable returned, so the lease
    # is already released and its entry already says succeeded.
    def run(context, value):
        return {"ok": True}

    def validate_result(value):
        raise ValueError("tracking result was not usable")

    manager = _manager(tmp_path)
    _register(
        manager,
        BackendJobDefinition(
            id="track",
            label="Track subject",
            run=run,
            validate_result=validate_result,
            uses_local_gpu=True,
        ),
    )
    try:
        snapshot = await manager.submit(EXTENSION_ID, "track", {})
        settled = await _drain(manager, snapshot.identity.job_id)
    finally:
        await _close(manager)

    assert settled.status == "failed"
    history = [
        entry
        for entry in get_model_work_coordinator().snapshot().entries
        if entry.source == WORK_SOURCE
    ]
    assert [entry.job_status for entry in history] == ["failed"]


@pytest.mark.asyncio
async def test_shutting_the_owner_down_does_not_leave_a_succeeded_entry(
    tmp_path,
    model_work_coordinator,
) -> None:
    # Deactivation drops the job record entirely; its entry outlives it as
    # queue history and must not claim the departed extension succeeded.
    release = threading.Event()
    inside = threading.Event()

    def run(context, value):
        inside.set()
        release.wait(5)
        return {"ok": True}

    manager = _manager(tmp_path)
    _register(
        manager,
        BackendJobDefinition(
            id="track",
            label="Track subject",
            run=run,
            uses_local_gpu=True,
        ),
    )
    try:
        await manager.submit(EXTENSION_ID, "track", {})
        assert await _reach(inside)
        shutdown = asyncio.create_task(manager.shutdown_owner(EXTENSION_ID))
        await asyncio.sleep(0.05)
        assert [entry.occupancy for entry in _entries(WORK_SOURCE)] == ["stopping"]
        release.set()
        await shutdown
    finally:
        release.set()
        await _close(manager)

    deadline = time.monotonic() + 2.0
    while _entries(WORK_SOURCE) and time.monotonic() < deadline:
        await asyncio.sleep(0.02)
    history = [
        entry
        for entry in get_model_work_coordinator().snapshot().entries
        if entry.source == WORK_SOURCE
    ]
    assert [entry.job_status for entry in history] == ["cancelled"]


# --------------------------------------------------------------------------
# The public path: an installed, approved extension
# --------------------------------------------------------------------------


GPU_EXTENSION_ID = "example.tracking"

GPU_EXTENSION_SOURCE = '''
from pathlib import Path

from services.extensions import (
    BackendExtensionDefinition,
    BackendJobDefinition,
    CapabilityDescriptor,
    Check,
    CheckStatus,
    Discovery,
    PackageSpec,
    RuntimeLoad,
    VerificationStage,
    capability_runtime_health,
    lazy_runtime,
)

STARTED = Path({started!r})
RELEASE = Path({release!r})


def discover(descriptor):
    return Discovery(
        checks=(
            Check(
                id="model.default",
                status=CheckStatus.PASS,
                stage=VerificationStage.DISCOVERED,
                summary="Tracker checkpoint found",
            ),
        ),
        models=({{"name": "tracker-v1"}},),
        selected_model="tracker-v1",
        found=True,
    )


def build(on_progress=None):
    return RuntimeLoad(value={{"tracker": True}}, resolved_device="cuda")


def create_extension(context):
    capability_id = context.capabilities.register(
        CapabilityDescriptor(
            id="tracker",
            label="Acme Tracker",
            packages=(
                PackageSpec(
                    module="acme_tracker",
                    install_target="acme-tracker>=1.0",
                ),
            ),
            uses_local_gpu=True,
            loader=build,
            discover_models=discover,
        )
    )
    runtime = lazy_runtime(capability_id)

    def readiness():
        from services.extensions import BackendJobReadiness

        health = capability_runtime_health(capability_id)
        if health["ready"]:
            return BackendJobReadiness.available("Acme Tracker is ready")
        return BackendJobReadiness.unavailable(health["error"] or "unavailable")

    def track(job_context, value):
        # Loading through the registry-owned cell is the only way to obtain
        # the runtime, so the load boundary is recorded whatever happens.
        runtime.get()
        STARTED.write_text("1", encoding="utf-8")
        while not RELEASE.exists():
            job_context.raise_if_cancelled()
            import time

            time.sleep(0.01)
        return {{"tracked": True}}

    return BackendExtensionDefinition(
        jobs=(
            BackendJobDefinition(
                id="track",
                label="Track subject",
                run=track,
                readiness=readiness,
                uses_local_gpu=True,
                timeout_seconds=30,
            ),
        )
    )
'''


@pytest.mark.asyncio
async def test_an_installed_extension_reserves_the_gpu_for_its_own_job(
    tmp_path,
    fake_environment,
    capability_dirs,
    model_work_coordinator,
    activate_backend_extension,
) -> None:
    """The governing Phase E case, through the path a user's install takes.

    Staged package, approval, ``BackendExtensionRuntime.start``, the public
    ``services.extensions`` barrel, a capability and a job that both declare
    the GPU — and the reservation the plan promises.
    """

    fake_environment.set_package("acme_tracker", installed=True, importable=True)
    started = tmp_path / "started"
    release = tmp_path / "release"
    runtime, summary = await activate_backend_extension.start_async(
        GPU_EXTENSION_SOURCE.format(started=str(started), release=str(release)),
        extension_id=GPU_EXTENSION_ID,
    )
    assert [record.status for record in summary.records] == ["active"]

    # The declaration reaches the frontend contract, so a panel can say that
    # this job waits for the machine rather than looking hung.
    job_types = await runtime.jobs.list_job_types(GPU_EXTENSION_ID)
    assert job_types[0]["id"] == "track"
    assert job_types[0]["usesLocalGpu"] is True
    assert job_types[0]["readiness"]["ready"] is True

    try:
        snapshot = await runtime.jobs.submit(GPU_EXTENSION_ID, "track", {})
        deadline = time.monotonic() + 5
        while not started.exists() and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        assert started.exists(), "the job never reached its runner"

        entries = _entries(WORK_SOURCE)
        assert [
            (entry.owner, entry.tenant, entry.resource, entry.occupancy)
            for entry in entries
        ] == [(GPU_EXTENSION_ID, TENANT_BACKEND, LOCAL_GPU_RESOURCE, "occupied")]
        # Named for the panel: which extension is holding the card.
        assert GPU_EXTENSION_ID in entries[0].label

        release.write_text("1", encoding="utf-8")
        settled = await _drain_runtime(runtime, snapshot.identity.job_id)
        assert settled.status == "succeeded"
    finally:
        release.write_text("1", encoding="utf-8")

    # Deactivation returns the resource and leaves no live entry behind.
    await runtime.stop()
    assert _entries(WORK_SOURCE) == []


async def _drain_runtime(runtime, job_id: str, *, timeout: float = 5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snapshot = runtime.jobs.get(GPU_EXTENSION_ID, job_id)
        if snapshot.status in ("succeeded", "failed", "cancelled"):
            return snapshot
        await asyncio.sleep(0.01)
    raise AssertionError(f"job {job_id} did not settle")
