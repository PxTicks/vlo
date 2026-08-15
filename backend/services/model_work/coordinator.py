"""Admission authority and ledger for every GPU-executing path in vlo.

The coordinator **executes nothing**. It owns two things:

1. the ledger — one place to see what the machine is doing;
2. admission — leases taken against a *resource key* by an *execution tenant*.

v1 defines one contended resource, ``local-gpu``. Local inference reserves it as
the exclusive ``backend-process`` tenant; every prompt sent to the same local
ComfyUI process reserves it as a child of one shared ``comfyui-process``
occupancy, because ComfyUI serialises its own queue internally. The resource
excludes *different* tenants; it does not pretend that each prompt inside one
already-exclusive ComfyUI process is another GPU contender.

The core is a thread-safe synchronous object because every torch workload
ultimately executes in a worker thread. The async methods are a façade over the
same state and the same lock — they never block the event loop on a
``threading.Condition`` and never consume a worker thread while waiting.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any

from services.model_work.leases import (
    CoordinatorNotReadyError,
    Lease,
    LeaseInvalidError,
    LeaseTimeoutError,
    ModelWorkError,
    MonitorToken,
)
from services.model_work.ledger import (
    LOCAL_GPU_RESOURCE,
    TENANT_COMFYUI,
    TENANT_SHARING,
    TERMINAL_JOB_STATUSES,
    JobStatus,
    LedgerEntry,
    LedgerEvent,
    LedgerSnapshot,
    PersistedOccupancy,
    ResourceView,
    Sharing,
    TerminalVerdict,
)

logger = logging.getLogger(__name__)

#: Terminal entries kept for the Queue panel's history before pruning.
MAX_TERMINAL_ENTRIES = 100

#: Per-subscriber event buffer. On overflow the buffer is replaced by a single
#: gap marker rather than silently dropping events: a client that received a
#: contiguous prefix and then nothing would never learn it had fallen behind.
SUBSCRIBER_QUEUE_SIZE = 256

#: Terminal verdicts kept for prompts whose settlement beat their own transfer.
MAX_SETTLED_PROMPT_VERDICTS = 512


@dataclass
class _Holder:
    holder_id: str
    entry: LedgerEntry
    occupancy: "_TenantOccupancy | None"
    prompt_id: str | None = None


@dataclass
class _TenantOccupancy:
    occupancy_id: str
    resource: str
    tenant: str
    sharing: Sharing
    holders: dict[str, _Holder] = field(default_factory=dict)


#: Queued in place of a subscriber's backlog when its buffer overflows. The
#: consumer must re-snapshot; applying anything after it would be applying a
#: delta to state that is known to be wrong.
LEDGER_GAP = object()


@dataclass
class _Subscriber:
    loop: asyncio.AbstractEventLoop
    queue: "asyncio.Queue[LedgerEvent | object]"
    gapped: bool = False


class LedgerStream:
    """A subscriber registered atomically with its initial snapshot."""

    def __init__(
        self,
        *,
        coordinator: "ModelWorkCoordinator",
        subscriber: _Subscriber,
        snapshot: LedgerSnapshot,
    ) -> None:
        self._coordinator = coordinator
        self._subscriber = subscriber
        self.snapshot = snapshot

    async def __aenter__(self) -> "LedgerStream":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        self.close()

    def __aiter__(self) -> AsyncIterator["LedgerEvent | object"]:
        return self.events()

    async def events(self) -> AsyncIterator["LedgerEvent | object"]:
        """Yields events, or :data:`LEDGER_GAP` when the consumer fell behind.

        A gap suspends delivery until :meth:`resync` is called, so a slow
        consumer cannot be handed deltas that apply to state it never saw.
        """

        while True:
            yield await self._subscriber.queue.get()

    def resync(self) -> LedgerSnapshot:
        return self._coordinator.resume_subscriber(self)

    def close(self) -> None:
        self._coordinator._remove_subscriber(self._subscriber)


class ModelWorkCoordinator:
    def __init__(self, *, resource_widths: dict[str, int] | None = None) -> None:
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._ready = False
        self._revision = 0
        self._entries: "OrderedDict[str, LedgerEntry]" = OrderedDict()
        self._holders: dict[str, _Holder] = {}
        self._occupancies: dict[str, list[_TenantOccupancy]] = {}
        self._tokens: dict[str, MonitorToken] = {}
        self._settled_prompts: "OrderedDict[str, TerminalVerdict]" = OrderedDict()
        self._subscribers: list[_Subscriber] = []
        self._async_waiters: list[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = []
        self._resource_widths: dict[str, int] = {LOCAL_GPU_RESOURCE: 1}
        if resource_widths:
            self._resource_widths.update(resource_widths)

    # ------------------------------------------------------------------
    # Readiness / restart recovery
    # ------------------------------------------------------------------

    def ready(self) -> bool:
        with self._lock:
            return self._ready

    def mark_ready(self) -> None:
        with self._lock:
            self._ready = True
            self._notify_locked()

    def resource_width(self, resource: str) -> int:
        with self._lock:
            return self._resource_widths.get(resource, 1)

    def set_resource_width(self, resource: str, width: int) -> None:
        if width < 1:
            raise ValueError("Resource width must be >= 1")
        with self._lock:
            self._resource_widths[resource] = width
            self._notify_locked()

    async def restore(self, entries: Sequence[PersistedOccupancy]) -> None:
        """Rebuild ComfyUI occupancy from persisted manifests, then become ready.

        Reservation is refused until this completes, so a restart cannot admit
        local work alongside prompts that are still running in ComfyUI.
        """

        for persisted in entries:
            self.restore_prompt_token(persisted)
        self.mark_ready()

    def restore_prompt_token(self, persisted: PersistedOccupancy) -> MonitorToken:
        """Recreate one prompt's occupancy. Idempotent by prompt id."""

        with self._lock:
            existing = self._tokens.get(persisted.prompt_id)
            if existing is not None:
                return existing

            entry = LedgerEntry(
                entry_id=uuid.uuid4().hex,
                source=persisted.source,
                owner=persisted.owner,
                label=persisted.label,
                job_status=persisted.job_status,
                submitted_at=persisted.submitted_at or time.time(),
                cancel_endpoint=persisted.cancel_endpoint,
                prompt_id=persisted.prompt_id,
            )
            holder = self._admit_locked(
                resource=LOCAL_GPU_RESOURCE,
                tenant=TENANT_COMFYUI,
                sharing="tenant",
                entry=entry,
            )
            if holder is None:
                # Width-1 local-gpu already owned by a different tenant. That is
                # impossible during restore (nothing has been admitted yet), so
                # treat it as a programming error rather than silently dropping
                # a prompt that is genuinely running.
                raise ModelWorkError(
                    f"Cannot restore prompt {persisted.prompt_id}: local-gpu is held by another tenant"
                )
            holder.prompt_id = persisted.prompt_id
            entry.started_at = entry.started_at or time.time()
            self._entries[entry.entry_id] = entry
            token = MonitorToken(
                coordinator=self,
                prompt_id=persisted.prompt_id,
                holder_id=holder.holder_id,
                entry_id=entry.entry_id,
            )
            self._tokens[persisted.prompt_id] = token
            self._publish_locked("added", entry)
            return token

    # ------------------------------------------------------------------
    # Reservation
    # ------------------------------------------------------------------

    def try_reserve_sync(
        self,
        *,
        resource: str | None,
        tenant: str | None,
        source: str,
        label: str,
        owner: str,
        sharing: Sharing = "exclusive",
        cancel_endpoint: str | None = None,
    ) -> Lease | None:
        with self._lock:
            self._require_ready_locked()
            entry = self._new_entry(
                source=source,
                label=label,
                owner=owner,
                resource=resource,
                tenant=tenant,
                cancel_endpoint=cancel_endpoint,
            )
            holder = self._admit_locked(
                resource=resource,
                tenant=tenant,
                sharing=sharing,
                entry=entry,
            )
            if holder is None:
                return None
            self._entries[entry.entry_id] = entry
            self._publish_locked("added", entry)
            return self._lease_for(holder)

    def reserve_sync(
        self,
        *,
        resource: str | None,
        tenant: str | None,
        source: str,
        label: str,
        owner: str,
        sharing: Sharing = "exclusive",
        timeout: float | None = None,
        cancel_endpoint: str | None = None,
    ) -> Lease:
        """Block the calling worker thread until admitted, or raise on timeout.

        Only ever called from a worker thread. The waiting entry is visible in
        the ledger so the queue is not a black box.
        """

        deadline = None if timeout is None else time.monotonic() + timeout
        with self._condition:
            self._require_ready_locked()
            entry = self._new_entry(
                source=source,
                label=label,
                owner=owner,
                resource=resource,
                tenant=tenant,
                cancel_endpoint=cancel_endpoint,
            )
            self._entries[entry.entry_id] = entry
            self._publish_locked("added", entry)
            try:
                while True:
                    holder = self._admit_locked(
                        resource=resource,
                        tenant=tenant,
                        sharing=sharing,
                        entry=entry,
                    )
                    if holder is not None:
                        self._publish_locked("updated", entry)
                        return self._lease_for(holder)
                    if deadline is None:
                        self._condition.wait()
                        continue
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise LeaseTimeoutError(
                            "Timed out waiting for the local GPU",
                            occupied_by=self._describe_resource_locked(resource),
                        )
                    self._condition.wait(remaining)
            except BaseException:
                self._drop_entry_locked(entry)
                raise

    async def try_reserve(self, **kwargs: Any) -> Lease | None:
        # Non-blocking, so the synchronous core is safe to call from the loop.
        return self.try_reserve_sync(**kwargs)

    async def reserve(
        self,
        *,
        resource: str | None,
        tenant: str | None,
        source: str,
        label: str,
        owner: str,
        sharing: Sharing = "exclusive",
        timeout: float | None = None,
        cancel_endpoint: str | None = None,
    ) -> Lease:
        """Await admission without blocking the event loop or a worker thread."""

        loop = asyncio.get_running_loop()
        wakeup = asyncio.Event()
        waiter = (loop, wakeup)
        deadline = None if timeout is None else time.monotonic() + timeout

        with self._lock:
            self._require_ready_locked()
            entry = self._new_entry(
                source=source,
                label=label,
                owner=owner,
                resource=resource,
                tenant=tenant,
                cancel_endpoint=cancel_endpoint,
            )
            self._entries[entry.entry_id] = entry
            self._publish_locked("added", entry)
            holder = self._admit_locked(
                resource=resource,
                tenant=tenant,
                sharing=sharing,
                entry=entry,
            )
            if holder is not None:
                self._publish_locked("updated", entry)
                return self._lease_for(holder)
            self._async_waiters.append(waiter)

        try:
            while True:
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    raise LeaseTimeoutError(
                        "Timed out waiting for the local GPU",
                        occupied_by=self.describe_resource(resource),
                    )
                try:
                    await asyncio.wait_for(wakeup.wait(), remaining)
                except (asyncio.TimeoutError, TimeoutError):
                    raise LeaseTimeoutError(
                        "Timed out waiting for the local GPU",
                        occupied_by=self.describe_resource(resource),
                    ) from None
                wakeup.clear()
                with self._lock:
                    holder = self._admit_locked(
                        resource=resource,
                        tenant=tenant,
                        sharing=sharing,
                        entry=entry,
                    )
                    if holder is not None:
                        self._publish_locked("updated", entry)
                        return self._lease_for(holder)
        except BaseException:
            with self._lock:
                self._drop_entry_locked(entry)
            raise
        finally:
            with self._lock:
                with contextlib.suppress(ValueError):
                    self._async_waiters.remove(waiter)

    # ------------------------------------------------------------------
    # Entry mutation
    # ------------------------------------------------------------------

    def get_entry(self, entry_id: str) -> LedgerEntry | None:
        with self._lock:
            entry = self._entries.get(entry_id)
            return entry.copy() if entry is not None else None

    def update_entry(
        self,
        entry_id: str,
        *,
        progress: float | None = None,
        message: str | None = None,
        job_status: JobStatus | None = None,
    ) -> None:
        with self._lock:
            entry = self._entries.get(entry_id)
            if entry is None:
                return
            if progress is not None:
                entry.progress = progress
            if message is not None:
                entry.message = message
            if job_status is not None:
                entry.job_status = job_status
            self._publish_locked("updated", entry)

    def mark_stopping(self, entry_id: str, *, message: str | None = None) -> None:
        with self._lock:
            entry = self._entries.get(entry_id)
            if entry is None:
                return
            entry.job_status = "cancelled"
            if entry.occupancy == "occupied":
                entry.occupancy = "stopping"
            if message is not None:
                entry.message = message
            self._publish_locked("updated", entry)

    # ------------------------------------------------------------------
    # Release / transfer
    # ------------------------------------------------------------------

    def release_holder(self, holder_id: str, *, verdict: TerminalVerdict = "succeeded") -> None:
        with self._condition:
            holder = self._holders.pop(holder_id, None)
            if holder is None:
                return
            self._detach_holder_locked(holder)
            entry = holder.entry
            entry.occupancy = "released"
            entry.ended_at = time.time()
            if entry.job_status not in TERMINAL_JOB_STATUSES:
                entry.job_status = verdict
            self._publish_locked("updated", entry)
            self._prune_terminal_locked()
            self._notify_locked()

    def transfer_lease(self, lease: Lease, prompt_id: str) -> MonitorToken:
        normalized = prompt_id.strip()
        if not normalized:
            raise LeaseInvalidError("A prompt id is required to transfer a lease")

        with self._condition:
            holder = self._holders.get(lease.holder_id)
            if holder is None:
                raise LeaseInvalidError("Lease is no longer held")

            existing = self._tokens.get(normalized)
            if existing is not None:
                # The monitor already owns this prompt (restore raced the live
                # response). Drop the redundant holder rather than double-hold.
                self._holders.pop(lease.holder_id, None)
                self._detach_holder_locked(holder)
                self._drop_entry_locked(holder.entry)
                self._notify_locked()
                return existing

            settled_verdict = self._settled_prompts.get(normalized)
            if settled_verdict is not None:
                # ComfyUI reported this prompt terminal before the response that
                # created the lease got back here. Nothing is left to hold — but
                # the verdict must survive, or a failed generation would sit in
                # the ledger as "running" and raise no notification.
                self._holders.pop(lease.holder_id, None)
                self._detach_holder_locked(holder)
                holder.entry.prompt_id = normalized
                holder.entry.occupancy = "released"
                holder.entry.ended_at = time.time()
                holder.entry.job_status = settled_verdict
                self._publish_locked("updated", holder.entry)
                self._notify_locked()
                return MonitorToken(
                    coordinator=self,
                    prompt_id=normalized,
                    holder_id=holder.holder_id,
                    entry_id=holder.entry.entry_id,
                )

            holder.prompt_id = normalized
            holder.entry.prompt_id = normalized
            token = MonitorToken(
                coordinator=self,
                prompt_id=normalized,
                holder_id=holder.holder_id,
                entry_id=holder.entry.entry_id,
            )
            self._tokens[normalized] = token
            self._publish_locked("updated", holder.entry)
            return token

    def token_for_prompt(self, prompt_id: str) -> MonitorToken | None:
        with self._lock:
            return self._tokens.get(prompt_id)

    def is_token_settled(self, prompt_id: str) -> bool:
        with self._lock:
            return prompt_id in self._settled_prompts or prompt_id not in self._tokens

    def _record_settled_locked(self, prompt_id: str, verdict: TerminalVerdict) -> None:
        # Bounded: this only exists to catch a terminal event that beats its own
        # transfer, which is a sub-second race. Unbounded, it would grow for the
        # life of the process.
        self._settled_prompts.pop(prompt_id, None)
        self._settled_prompts[prompt_id] = verdict
        while len(self._settled_prompts) > MAX_SETTLED_PROMPT_VERDICTS:
            self._settled_prompts.popitem(last=False)

    def settle_token(self, prompt_id: str, *, verdict: TerminalVerdict = "succeeded") -> None:
        with self._condition:
            self._record_settled_locked(prompt_id, verdict)
            token = self._tokens.pop(prompt_id, None)
            if token is None:
                return
            holder = self._holders.pop(token.holder_id, None)
            if holder is None:
                return
            self._detach_holder_locked(holder)
            entry = holder.entry
            entry.occupancy = "released"
            entry.suspected_stale = False
            entry.ended_at = time.time()
            entry.job_status = verdict
            self._publish_locked("updated", entry)
            self._prune_terminal_locked()
            self._notify_locked()

    def mark_token_suspected_stale(self, prompt_id: str, diagnostic: str) -> None:
        with self._lock:
            token = self._tokens.get(prompt_id)
            if token is None:
                return
        self.mark_entry_suspected_stale(token.entry_id, diagnostic)

    def mark_entry_suspected_stale(self, entry_id: str, diagnostic: str) -> None:
        with self._lock:
            entry = self._entries.get(entry_id)
            if entry is None:
                return
            entry.suspected_stale = True
            entry.message = diagnostic
            self._publish_locked("updated", entry)

    def unsafe_release(self, entry_id: str) -> bool:
        """Operator escape hatch for an occupancy ComfyUI can no longer confirm.

        Only reachable from the Queue panel's explicitly warned action; never
        from a wall-clock timeout.
        """

        with self._lock:
            entry = self._entries.get(entry_id)
            if entry is None or entry.occupancy == "released":
                return False
            if entry.prompt_id:
                self.settle_token(entry.prompt_id, verdict="failed")
                return True
            holder_id = next(
                (
                    holder.holder_id
                    for holder in self._holders.values()
                    if holder.entry.entry_id == entry_id
                ),
                None,
            )
            if holder_id is None:
                return False
            self.release_holder(holder_id, verdict="failed")
            return True

    # ------------------------------------------------------------------
    # Read model
    # ------------------------------------------------------------------

    def snapshot(self) -> LedgerSnapshot:
        with self._lock:
            return self._snapshot_locked()

    def describe_resource(self, resource: str | None) -> str | None:
        with self._lock:
            return self._describe_resource_locked(resource)

    def open_stream(self) -> LedgerStream:
        """Register a subscriber and capture its snapshot under one lock.

        Without this atomicity an event can fall between snapshot creation and
        subscription, and the client would never learn it missed one.
        """

        loop = asyncio.get_running_loop()
        subscriber = _Subscriber(loop=loop, queue=asyncio.Queue(maxsize=SUBSCRIBER_QUEUE_SIZE))
        with self._lock:
            self._subscribers.append(subscriber)
            snapshot = self._snapshot_locked()
        return LedgerStream(coordinator=self, subscriber=subscriber, snapshot=snapshot)

    async def subscribe(self, *, after_revision: int = 0) -> AsyncIterator[LedgerEvent]:
        stream = self.open_stream()
        try:
            async for event in stream.events():
                if event is LEDGER_GAP:
                    stream.resync()
                    continue
                assert isinstance(event, LedgerEvent)
                if event.revision > after_revision:
                    yield event
        finally:
            stream.close()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _require_ready_locked(self) -> None:
        if not self._ready:
            raise CoordinatorNotReadyError(
                "The model-work coordinator is still restoring in-flight work"
            )

    def _new_entry(
        self,
        *,
        source: str,
        label: str,
        owner: str,
        resource: str | None,
        tenant: str | None,
        cancel_endpoint: str | None,
    ) -> LedgerEntry:
        return LedgerEntry(
            entry_id=uuid.uuid4().hex,
            source=source,
            owner=owner,
            label=label,
            resource=resource,
            tenant=tenant if resource is not None else None,
            cancel_endpoint=cancel_endpoint,
        )

    def _admit_locked(
        self,
        *,
        resource: str | None,
        tenant: str | None,
        sharing: Sharing,
        entry: LedgerEntry,
    ) -> _Holder | None:
        if resource is None:
            # Observe-only work (remote ComfyUI). Recorded, never gated.
            holder = _Holder(holder_id=uuid.uuid4().hex, entry=entry, occupancy=None)
            self._holders[holder.holder_id] = holder
            entry.occupancy = "occupied"
            entry.job_status = "running" if entry.job_status == "queued" else entry.job_status
            entry.started_at = entry.started_at or time.time()
            return holder

        if tenant is None:
            raise ModelWorkError("A tenant is required to reserve a resource")
        registered = TENANT_SHARING.get(tenant)
        if registered is None:
            raise ModelWorkError(f"Unknown execution tenant: {tenant}")
        if sharing != registered:
            raise ModelWorkError(
                f"Tenant {tenant} is registered as {registered!r}, not {sharing!r}"
            )

        occupancies = self._occupancies.setdefault(resource, [])
        target: _TenantOccupancy | None = None
        if registered == "tenant":
            target = next((occ for occ in occupancies if occ.tenant == tenant), None)
        if target is None:
            if len(occupancies) >= self._resource_widths.get(resource, 1):
                return None
            target = _TenantOccupancy(
                occupancy_id=uuid.uuid4().hex,
                resource=resource,
                tenant=tenant,
                sharing=registered,
            )
            occupancies.append(target)

        holder = _Holder(holder_id=uuid.uuid4().hex, entry=entry, occupancy=target)
        target.holders[holder.holder_id] = holder
        self._holders[holder.holder_id] = holder
        entry.occupancy = "occupied"
        if entry.job_status == "queued":
            entry.job_status = "running"
        entry.started_at = entry.started_at or time.time()
        # Shared tenants group their prompt children under one occupancy id.
        entry.parent_occupancy_id = target.occupancy_id if registered == "tenant" else None
        return holder

    def _detach_holder_locked(self, holder: _Holder) -> None:
        occupancy = holder.occupancy
        if occupancy is None:
            return
        occupancy.holders.pop(holder.holder_id, None)
        if not occupancy.holders:
            siblings = self._occupancies.get(occupancy.resource, [])
            if occupancy in siblings:
                siblings.remove(occupancy)

    def _lease_for(self, holder: _Holder) -> Lease:
        return Lease(
            coordinator=self,
            holder_id=holder.holder_id,
            entry_id=holder.entry.entry_id,
            resource=holder.entry.resource,
            tenant=holder.entry.tenant,
            occupancy_id=holder.occupancy.occupancy_id if holder.occupancy else None,
        )

    def _drop_entry_locked(self, entry: LedgerEntry) -> None:
        removed = self._entries.pop(entry.entry_id, None)
        if removed is not None:
            self._publish_locked("removed", removed)

    def _prune_terminal_locked(self) -> None:
        terminal = [
            entry
            for entry in self._entries.values()
            if entry.occupancy == "released"
        ]
        overflow = len(terminal) - MAX_TERMINAL_ENTRIES
        for entry in terminal[:overflow] if overflow > 0 else []:
            self._entries.pop(entry.entry_id, None)
            self._publish_locked("removed", entry)

    def _resource_views_locked(self) -> tuple[ResourceView, ...]:
        views: list[ResourceView] = []
        for resource, width in self._resource_widths.items():
            occupancies = self._occupancies.get(resource, [])
            if not occupancies:
                views.append(
                    ResourceView(
                        resource=resource,
                        width=width,
                        tenant=None,
                        occupancy_id=None,
                        holder_count=0,
                    )
                )
                continue
            for occupancy in occupancies:
                views.append(
                    ResourceView(
                        resource=resource,
                        width=width,
                        tenant=occupancy.tenant,
                        occupancy_id=occupancy.occupancy_id,
                        holder_count=len(occupancy.holders),
                    )
                )
        return tuple(views)

    def _describe_resource_locked(self, resource: str | None) -> str | None:
        if resource is None:
            return None
        occupancies = self._occupancies.get(resource, [])
        if not occupancies:
            return None
        occupancy = occupancies[0]
        labels = [holder.entry.label for holder in occupancy.holders.values()]
        if not labels:
            return occupancy.tenant
        return f"{occupancy.tenant}: {', '.join(labels)}"

    def _snapshot_locked(self) -> LedgerSnapshot:
        return LedgerSnapshot(
            revision=self._revision,
            ready=self._ready,
            entries=tuple(entry.copy() for entry in self._entries.values()),
            resources=self._resource_views_locked(),
        )

    def _publish_locked(self, kind: str, entry: LedgerEntry) -> None:
        self._revision += 1
        event = LedgerEvent(
            revision=self._revision,
            kind=kind,  # type: ignore[arg-type]
            entry=entry.copy(),
            resources=self._resource_views_locked(),
        )
        for subscriber in list(self._subscribers):
            self._deliver_locked(subscriber, event)

    def _deliver_locked(self, subscriber: _Subscriber, event: LedgerEvent) -> None:
        def _put() -> None:
            if subscriber.gapped:
                # Already behind: every further event is part of the same gap,
                # and the pending marker already tells the consumer to resync.
                return
            try:
                subscriber.queue.put_nowait(event)
            except asyncio.QueueFull:
                # Replace the backlog with an explicit gap marker. Draining and
                # re-queuing is what makes the gap *observable*: without it the
                # consumer would read a contiguous prefix, see no revision jump,
                # and keep applying deltas to state it had already lost.
                subscriber.gapped = True
                while not subscriber.queue.empty():
                    subscriber.queue.get_nowait()
                subscriber.queue.put_nowait(LEDGER_GAP)

        try:
            subscriber.loop.call_soon_threadsafe(_put)
        except RuntimeError:  # pragma: no cover - loop already closed
            self._subscribers.remove(subscriber)

    def resume_subscriber(self, stream: "LedgerStream") -> LedgerSnapshot:
        """Re-snapshot a gapped stream and let it receive events again."""

        with self._lock:
            stream._subscriber.gapped = False
            return self._snapshot_locked()

    def _remove_subscriber(self, subscriber: _Subscriber) -> None:
        with self._lock:
            with contextlib.suppress(ValueError):
                self._subscribers.remove(subscriber)

    def _notify_locked(self) -> None:
        self._condition.notify_all()
        for loop, event in list(self._async_waiters):
            try:
                loop.call_soon_threadsafe(event.set)
            except RuntimeError:  # pragma: no cover - loop already closed
                with contextlib.suppress(ValueError):
                    self._async_waiters.remove((loop, event))
