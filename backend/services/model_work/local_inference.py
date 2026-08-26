"""Worker-thread wrapper for local (in-process) torch inference.

Every local model call goes through here so that admission and execution share
one lifetime. Two properties matter:

- **The lease is owned by the worker thread, not the request coroutine.** A
  client disconnect or a cancelled ``run_in_threadpool`` coroutine cannot return
  the GPU to the pool while the physical call is still inside torch.
  :func:`local_gpu_lease` acquires and owns in one step, for a caller that is
  already on the thread that will run the model. A caller that must *wait*
  somewhere else — a job manager awaiting admission on the event loop so a
  queued job does not sit on a worker thread — splits the two:
  :func:`reserve_local_gpu` awaits admission, and :func:`hold_local_gpu` takes
  ownership on the worker thread and releases there.
- **Nested calls do not deadlock.** SAM-Audio's separation job reads cached SAM2
  mask frames, which can initialise a predictor session. The backend tenant is
  exclusive by design, so a second acquisition on the same thread would block
  forever; instead the wrapper recognises that this thread already owns the
  resource and passes straight through.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Callable, TypeVar

from services.model_work import get_model_work_coordinator
from services.model_work.leases import Lease, LeaseTimeoutError, TerminalVerdict
from services.model_work.ledger import LOCAL_GPU_RESOURCE, TENANT_BACKEND
from services.model_work.vram import release_cuda_cache

T = TypeVar("T")

#: Bounded wait for an inline HTTP API before it answers 429 + Retry-After.
LOCAL_INFERENCE_WAIT_SECONDS = 120.0

_thread_state = threading.local()


def holds_local_gpu() -> bool:
    return bool(getattr(_thread_state, "held", False))


@contextmanager
def local_gpu_lease(
    *,
    source: str,
    label: str,
    owner: str,
    timeout: float | None = None,
    fail_fast: bool = False,
    stop: threading.Event | None = None,
) -> Iterator[Lease | None]:
    """Hold ``local-gpu`` for the body, on the calling worker thread.

    ``timeout=None`` means :data:`LOCAL_INFERENCE_WAIT_SECONDS`. There is
    deliberately no unbounded wait here: an inline HTTP API must answer.

    ``stop`` abandons the wait when it is set, for a caller whose work can be
    cancelled while it is still queued — a background job, as opposed to an
    inline request whose client is still holding the connection open.

    Yields ``None`` when this thread already owns the resource, so nested calls
    (SAM-Audio reading SAM2 mask frames) pass through instead of deadlocking
    against the exclusive backend tenant.
    """

    if holds_local_gpu():
        yield None
        return

    lease = _acquire(
        get_model_work_coordinator(),
        source=source,
        label=label,
        owner=owner,
        timeout=LOCAL_INFERENCE_WAIT_SECONDS if timeout is None else timeout,
        fail_fast=fail_fast,
        stop=stop,
    )

    with hold_local_gpu(lease):
        yield lease


async def reserve_local_gpu(
    *,
    source: str,
    label: str,
    owner: str,
    timeout: float | None = None,
) -> Lease:
    """Await admission to ``local-gpu`` without blocking a worker thread.

    For a caller that dispatches the model call to a thread of its own: the
    wait belongs on the event loop, so a queued job does not sit on a pool
    worker that unrelated CPU work needs. The returned lease is *unowned* — it
    must be handed to :func:`hold_local_gpu` on the thread that runs the model,
    which is what releases it, or released directly by the caller if that
    dispatch never happens.
    """

    return await get_model_work_coordinator().reserve(
        resource=LOCAL_GPU_RESOURCE,
        tenant=TENANT_BACKEND,
        source=source,
        label=label,
        owner=owner,
        sharing="exclusive",
        timeout=LOCAL_INFERENCE_WAIT_SECONDS if timeout is None else timeout,
    )


@contextmanager
def hold_local_gpu(lease: Lease) -> Iterator[Lease]:
    """Own an already-reserved ``lease`` on this thread for the body's duration.

    This is the physical exit path of the model work, so it is where the lease
    is released — not a future's done callback, which can run on the thread
    that registered it when the future has already finished, and not the
    awaiting coroutine, which would hand the GPU over on timeout with the model
    still resident. Marking the thread also makes nested acquisitions pass
    through :func:`local_gpu_lease` rather than deadlock.
    """

    _thread_state.held = True
    verdict: TerminalVerdict = "succeeded"
    try:
        yield lease
    except BaseException:
        verdict = "failed"
        raise
    finally:
        _thread_state.held = False
        # The VRAM release hook runs before the resource becomes available to
        # another tenant, and must never mask the call's own result.
        try:
            release_cuda_cache()
        except Exception:  # pragma: no cover - defensive
            pass
        entry = lease.entry()
        if verdict == "succeeded" and entry is not None and entry.job_status == "cancelled":
            verdict = "cancelled"
        lease.release(verdict)


def run_local_inference(
    callable_: Callable[[], T],
    *,
    source: str,
    label: str,
    owner: str,
    timeout: float | None = None,
    fail_fast: bool = False,
    stop: threading.Event | None = None,
) -> T:
    """Run ``callable_`` on this thread while holding the ``local-gpu`` lease.

    ``fail_fast`` is for foreground clicks: a clear "GPU busy" beats an
    indefinite spinner. Batch work waits up to ``timeout`` and then reports 429.
    """

    with local_gpu_lease(
        source=source,
        label=label,
        owner=owner,
        timeout=timeout,
        fail_fast=fail_fast,
        stop=stop,
    ):
        return callable_()


def _acquire(
    coordinator,
    *,
    source: str,
    label: str,
    owner: str,
    timeout: float | None,
    fail_fast: bool,
    stop: threading.Event | None = None,
) -> Lease:
    if fail_fast:
        lease = coordinator.try_reserve_sync(
            resource=LOCAL_GPU_RESOURCE,
            tenant=TENANT_BACKEND,
            source=source,
            label=label,
            owner=owner,
            sharing="exclusive",
        )
        if lease is None:
            occupant = coordinator.describe_resource(LOCAL_GPU_RESOURCE)
            raise LeaseTimeoutError(
                "The GPU is busy"
                + (f" with {occupant}" if occupant else "")
                + ". Try again when it is free.",
                occupied_by=occupant,
            )
        return lease

    return coordinator.reserve_sync(
        resource=LOCAL_GPU_RESOURCE,
        tenant=TENANT_BACKEND,
        source=source,
        label=label,
        owner=owner,
        sharing="exclusive",
        timeout=timeout,
        stop=stop,
    )


__all__ = [
    "LOCAL_INFERENCE_WAIT_SECONDS",
    "hold_local_gpu",
    "holds_local_gpu",
    "local_gpu_lease",
    "reserve_local_gpu",
    "run_local_inference",
]
