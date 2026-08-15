"""Backend-side admission for ComfyUI prompts.

The frontend gate is advisory only — useful for UI state, never for exclusion,
because a check-then-submit gap is not atomic. The authoritative reservation is
taken here, *before* the prompt is forwarded to ComfyUI, for both the vlo
generation panel and the in-editor iframe proxy.

Holding through ComfyUI's queued state is deliberate: several accepted prompts
may hold child tokens under one ``comfyui-process`` occupancy, and local
inference stays excluded until all of them settle.
"""

from __future__ import annotations

import logging
from typing import Any

from services.model_work import get_model_work_coordinator
from services.model_work.leases import Lease, ModelWorkError, MonitorToken
from services.model_work.ledger import TENANT_COMFYUI
from services.model_work.locality import comfy_resource_key

logger = logging.getLogger(__name__)

COMFY_OWNER = "vlo.comfyui"


class ComfyGpuBusyError(ModelWorkError):
    """Local inference owns the GPU, so this prompt must not be forwarded."""

    def __init__(self, occupied_by: str | None) -> None:
        super().__init__(
            "The local GPU is busy with vlo model work"
            + (f" ({occupied_by})" if occupied_by else "")
        )
        self.occupied_by = occupied_by


class ComfyPromptAdmission:
    """Reserve → forward → (accept | release) for a single ComfyUI prompt.

    Use as a context manager. Leaving the context without :meth:`accept`
    releases the child immediately, which is what should happen when ComfyUI
    rejects the prompt or the response cannot be parsed.
    """

    def __init__(
        self,
        *,
        source: str,
        label: str,
        owner: str = COMFY_OWNER,
        cancel_endpoint: str | None = None,
    ) -> None:
        self._source = source
        self._label = label
        self._owner = owner
        self._cancel_endpoint = cancel_endpoint
        self._lease: Lease | None = None
        self._token: MonitorToken | None = None

    @property
    def entry_id(self) -> str | None:
        if self._token is not None:
            return self._token.entry_id
        return self._lease.entry_id if self._lease is not None else None

    @property
    def token(self) -> MonitorToken | None:
        return self._token

    @property
    def holds_reservation(self) -> bool:
        """Whether the GPU was reserved and has not yet been handed on.

        Callers use this to distinguish "the prompt never reached ComfyUI" from
        "we don't know", which are the two halves of a transport failure.
        """

        return self._lease is not None

    def reserve(self) -> None:
        """Claim the GPU for this prompt, or raise :class:`ComfyGpuBusyError`.

        A remote ComfyUI resolves to no admission resource: the work is still
        recorded in the ledger, but nothing is serialised against it.
        """

        coordinator = get_model_work_coordinator()
        resource = comfy_resource_key()
        lease = coordinator.try_reserve_sync(
            resource=resource,
            tenant=TENANT_COMFYUI if resource is not None else None,
            source=self._source,
            label=self._label,
            owner=self._owner,
            sharing="tenant" if resource is not None else "exclusive",
            cancel_endpoint=self._cancel_endpoint,
        )
        if lease is None:
            raise ComfyGpuBusyError(coordinator.describe_resource(resource))
        self._lease = lease

    def accept(self, prompt_id: str) -> MonitorToken:
        """Hand the occupancy to a prompt-scoped monitor token.

        Called before any fallible delivery persistence or monitor attachment,
        so a later failure leaves the token occupied (and reconciling) instead
        of returning the resource to the pool early.
        """

        if self._lease is None:
            raise ModelWorkError("ComfyUI admission was never reserved")
        self._token = self._lease.transfer(prompt_id)
        self._lease = None
        return self._token

    def detach(self) -> Lease | None:
        """Hand the reservation to a caller that will own its release.

        For submissions whose outcome is genuinely unknown and whose prompt id
        is not either: the occupancy has to survive this request, but there is
        no prompt to key a monitor token on.
        """

        lease = self._lease
        self._lease = None
        return lease

    def release(self, verdict: str = "failed") -> None:
        if self._lease is not None:
            self._lease.release(verdict)  # type: ignore[arg-type]
            self._lease = None

    def __enter__(self) -> "ComfyPromptAdmission":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        # A no-op once `accept` ran: from there the occupancy belongs to the
        # monitor token. Reaching here still holding the lease means ComfyUI
        # never took the prompt.
        del exc_type, exc, tb
        self.release("failed")


def settle_prompt(prompt_id: str, verdict: str) -> None:
    """Release a prompt's occupancy on a terminal verdict. Idempotent."""

    if not prompt_id:
        return
    get_model_work_coordinator().settle_token(prompt_id, verdict=verdict)  # type: ignore[arg-type]


def report_prompt_progress(
    prompt_id: str,
    *,
    progress: float | None = None,
    message: str | None = None,
) -> None:
    if not prompt_id:
        return
    coordinator = get_model_work_coordinator()
    token = coordinator.token_for_prompt(prompt_id)
    if token is None:
        return
    token.report(progress=progress, message=message)


def mark_prompt_suspected_stale(prompt_id: str, diagnostic: str) -> None:
    """ComfyUI could not be reached; retain occupancy and surface it.

    A wall-clock timeout must never silently break exclusion, so the Queue
    panel's explicit unsafe-release action is the only automatic-free path.
    """

    if not prompt_id:
        return
    coordinator = get_model_work_coordinator()
    token = coordinator.token_for_prompt(prompt_id)
    if token is None:
        return
    token.mark_suspected_stale_sync(diagnostic)


__all__ = [
    "COMFY_OWNER",
    "ComfyGpuBusyError",
    "ComfyPromptAdmission",
    "mark_prompt_suspected_stale",
    "report_prompt_progress",
    "settle_prompt",
]
