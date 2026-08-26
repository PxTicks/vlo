"""Worker-thread wrapper for local (in-process) torch inference.

Every local model call goes through here so that admission and execution share
one lifetime. Two properties matter:

- **The lease is owned by the worker thread, not the request coroutine.** A
  client disconnect or a cancelled ``run_in_threadpool`` coroutine cannot return
  the GPU to the pool while the physical call is still inside torch.
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
    "holds_local_gpu",
    "local_gpu_lease",
    "run_local_inference",
]
