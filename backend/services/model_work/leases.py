"""Lease handles for the model-work coordinator.

The lease is owned by the *physical worker callable*, not by the job record and
not by the HTTP request coroutine. A job may be publicly ``cancelled`` while the
coordinator still reports its resource ``occupied``: that is the honest state,
because ``concurrent.futures`` cannot stop a thread that is inside a torch call.

Application code never calls ``release()`` directly. Use ``with lease`` /
``async with lease`` or :func:`run_with_lease`. The single ownership-changing
operation is :meth:`Lease.transfer`, which hands a ComfyUI prompt's occupancy to
an idempotent monitor token.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable, TypeVar

from services.model_work.ledger import JobStatus, LedgerEntry, TerminalVerdict

__all__ = [
    "CoordinatorNotReadyError",
    "Lease",
    "LeaseInvalidError",
    "LeaseTimeoutError",
    "ModelWorkError",
    "MonitorToken",
    "TerminalVerdict",
    "run_with_lease",
]

if TYPE_CHECKING:  # pragma: no cover - typing only
    from services.model_work.coordinator import ModelWorkCoordinator

T = TypeVar("T")


class ModelWorkError(RuntimeError):
    """Base class for coordinator errors."""


class CoordinatorNotReadyError(ModelWorkError):
    """Raised while restart recovery is still rebuilding occupancy (HTTP 503)."""


class LeaseTimeoutError(ModelWorkError):
    """Raised when a bounded wait for admission expired (HTTP 429)."""

    def __init__(self, message: str, *, occupied_by: str | None = None) -> None:
        super().__init__(message)
        self.occupied_by = occupied_by


class LeaseInvalidError(ModelWorkError):
    """Raised when a released or transferred lease handle is used again."""


class LeaseAbandonedError(ModelWorkError):
    """Raised when a waiter stopped waiting before it was admitted.

    Distinct from :class:`LeaseTimeoutError`: nothing expired and the resource
    is not necessarily busy — the caller's own work was cancelled while it sat
    in the queue. A cancelled job must leave the queue then, not when the GPU
    it no longer needs finally comes free.
    """


class Lease:
    """A live claim on a resource, held for the duration of physical execution."""

    def __init__(
        self,
        *,
        coordinator: "ModelWorkCoordinator",
        holder_id: str,
        entry_id: str,
        resource: str | None,
        tenant: str | None,
        occupancy_id: str | None,
    ) -> None:
        self._coordinator = coordinator
        self._holder_id = holder_id
        self._entry_id = entry_id
        self._resource = resource
        self._tenant = tenant
        self._occupancy_id = occupancy_id
        self._active = True

    @property
    def entry_id(self) -> str:
        return self._entry_id

    @property
    def holder_id(self) -> str:
        return self._holder_id

    @property
    def resource(self) -> str | None:
        return self._resource

    @property
    def tenant(self) -> str | None:
        return self._tenant

    @property
    def occupancy_id(self) -> str | None:
        return self._occupancy_id

    @property
    def active(self) -> bool:
        return self._active

    def entry(self) -> LedgerEntry | None:
        return self._coordinator.get_entry(self._entry_id)

    def report(
        self,
        *,
        progress: float | None = None,
        message: str | None = None,
        job_status: JobStatus | None = None,
    ) -> None:
        self._coordinator.update_entry(
            self._entry_id,
            progress=progress,
            message=message,
            job_status=job_status,
        )

    def request_stop(
        self,
        *,
        message: str | None = None,
        verdict: TerminalVerdict = "cancelled",
    ) -> None:
        """This work is publicly over; the worker is still resident.

        Physically the entry becomes ``stopping`` and keeps excluding other
        tenants until the callable exits. ``verdict`` is what the entry now
        says publicly — ``cancelled`` for a cancellation, ``failed`` for a job
        the host has already given up on, such as an execution timeout.
        """

        self._coordinator.mark_stopping(
            self._entry_id,
            message=message,
            job_status=verdict,
        )

    def transfer(self, prompt_id: str) -> "MonitorToken":
        """Hand this occupancy to a prompt-scoped monitor token.

        Atomic and fail-closed: after ComfyUI accepts a prompt, the resource is
        never returned to the pool by the caller's context manager. A duplicate
        transfer for the same prompt id returns the existing token and drops the
        redundant holder.
        """

        if not self._active:
            raise LeaseInvalidError("Lease has already been released or transferred")
        token = self._coordinator.transfer_lease(self, prompt_id)
        self._active = False
        return token

    def release(self, verdict: TerminalVerdict = "succeeded") -> None:
        if not self._active:
            return
        self._active = False
        self._coordinator.release_holder(self._holder_id, verdict=verdict)

    def _invalidate(self) -> None:
        self._active = False

    def __enter__(self) -> "Lease":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.release(_verdict_for(self, exc_type))

    async def __aenter__(self) -> "Lease":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.release(_verdict_for(self, exc_type))


def _verdict_for(lease: Lease, exc_type: Any) -> TerminalVerdict:
    if exc_type is not None:
        return "failed"
    entry = lease.entry()
    if entry is not None and entry.job_status == "cancelled":
        return "cancelled"
    return "succeeded"


class MonitorToken:
    """Prompt-scoped occupancy owned by a delivery monitor.

    ``settle`` is idempotent and keyed by prompt id, so duplicate terminal
    events, reconcile backstops, and restore/live-event races cannot release
    another prompt's occupancy or double-release this one.
    """

    def __init__(
        self,
        *,
        coordinator: "ModelWorkCoordinator",
        prompt_id: str,
        holder_id: str,
        entry_id: str,
    ) -> None:
        self._coordinator = coordinator
        self._prompt_id = prompt_id
        self._holder_id = holder_id
        self._entry_id = entry_id

    @property
    def prompt_id(self) -> str:
        return self._prompt_id

    @property
    def entry_id(self) -> str:
        return self._entry_id

    @property
    def holder_id(self) -> str:
        return self._holder_id

    @property
    def settled(self) -> bool:
        return self._coordinator.is_token_settled(self._prompt_id)

    def settle_sync(self, verdict: TerminalVerdict = "succeeded") -> None:
        self._coordinator.settle_token(self._prompt_id, verdict=verdict)

    async def settle(self, verdict: TerminalVerdict = "succeeded") -> None:
        self.settle_sync(verdict)

    def mark_suspected_stale_sync(self, diagnostic: str) -> None:
        """Occupancy is retained because ComfyUI could not be reached.

        A wall-clock timeout alone must never silently break exclusion, so this
        keeps the resource held and surfaces an explicit unsafe-release action.
        """

        self._coordinator.mark_token_suspected_stale(self._prompt_id, diagnostic)

    async def mark_suspected_stale(self, diagnostic: str) -> None:
        self.mark_suspected_stale_sync(diagnostic)

    def report(
        self,
        *,
        progress: float | None = None,
        message: str | None = None,
        job_status: JobStatus | None = None,
    ) -> None:
        self._coordinator.update_entry(
            self._entry_id,
            progress=progress,
            message=message,
            job_status=job_status,
        )


def run_with_lease(
    lease: Lease,
    callable_: Callable[..., T],
    *args: Any,
    release_hook: Callable[[], None] | None = None,
    **kwargs: Any,
) -> T:
    """Run ``callable_`` under ``lease`` on the calling (worker) thread.

    The lease is released only when the callable returns, including when it
    returns by raising. ``release_hook`` runs *before* the resource becomes
    available to another tenant — that is where a source-specific VRAM release
    such as ``torch.cuda.empty_cache()`` belongs.
    """

    verdict: TerminalVerdict = "succeeded"
    try:
        return callable_(*args, **kwargs)
    except BaseException:
        verdict = "failed"
        raise
    finally:
        if release_hook is not None:
            try:
                release_hook()
            except Exception:  # pragma: no cover - hooks must never mask the result
                pass
        entry = lease.entry()
        if verdict == "succeeded" and entry is not None and entry.job_status == "cancelled":
            verdict = "cancelled"
        lease.release(verdict)
