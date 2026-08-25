"""Runtime-capability registry.

The single place that answers "can this AI feature actually run right now, and
how do we know?". Readiness is reported in stages — file discovery proves very
little, a successful load proves a lot — so that a capability can honestly say
"installed but unproven" instead of collapsing everything into one ``ready``
boolean that model files alone can flip to true.

Only the cheap stages (``discovered``, ``environment``) are evaluated here.
Loading a model belongs to an explicit probe on the job manager, never to a
status request.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .contract import (
    ATTEMPTABLE_STATES,
    STAGE_ORDER,
    Capability,
    CapabilityState,
    Check,
    CheckStatus,
    DeviceReport,
    FailureCode,
    FailureRecord,
    Remediation,
    RemediationKind,
    VerificationStage,
    derive_state,
    derive_verified_through,
    utc_now,
)
from .environment import ENVIRONMENT_PROBE_KEY, describe_environment
from .failures import (
    ClassifiedFailure,
    classify_exception,
    clear_failures,
    get_last_failure,
    record_exception,
    record_failure,
    sanitize_message,
    sanitize_url,
)
from .providers import (
    BeatsProvider,
    CapabilityProvider,
    ComfyUIProvider,
    Sam2Provider,
    SamAudioProvider,
)
from .subprocess_probe import invalidate_probe_cache


#: Registration order is display order.
_PROVIDERS: tuple[CapabilityProvider, ...] = (
    Sam2Provider(),
    SamAudioProvider(),
    BeatsProvider(),
    ComfyUIProvider(),
)

_PROVIDERS_BY_ID: dict[str, CapabilityProvider] = {
    provider.id: provider for provider in _PROVIDERS
}

#: Cap on concurrent probe subprocesses. Each one may import torch, so fanning
#: out without a limit trades a slow cold cache for a memory spike.
_PROBE_FAN_OUT = 3


def list_capability_ids() -> tuple[str, ...]:
    return tuple(_PROVIDERS_BY_ID)


def get_provider(capability_id: str) -> CapabilityProvider | None:
    return _PROVIDERS_BY_ID.get(capability_id)


def get_capability(capability_id: str, *, refresh: bool = False) -> Capability | None:
    provider = _PROVIDERS_BY_ID.get(capability_id)
    if provider is None:
        return None
    if refresh:
        invalidate_capability_cache(capability_id)
    return provider.build()


def list_capabilities(*, refresh: bool = False) -> list[Capability]:
    if refresh:
        invalidate_capability_cache()

    # Providers share one subprocess for torch and the devices — the probe
    # cache is single-flight per key, so the fan-out joins that one run rather
    # than spawning a torch import per capability.
    with ThreadPoolExecutor(
        max_workers=min(_PROBE_FAN_OUT, len(_PROVIDERS)),
        thread_name_prefix="capability-probe",
    ) as pool:
        return list(pool.map(lambda provider: provider.build(), _PROVIDERS))


def invalidate_capability_cache(capability_id: str | None = None) -> None:
    """Drop cached probe results.

    Called by an explicit recheck and (from the rollout's later step) by any
    real load attempt, so a capability never keeps reporting a stale
    environment after the user has fixed it.
    """

    if capability_id is None:
        invalidate_probe_cache()
        return
    invalidate_probe_cache(capability_id)
    # The shared torch/device probe backs every capability's device check, so a
    # single recheck has to drop it too or the "fixed" answer stays stale.
    invalidate_probe_cache(ENVIRONMENT_PROBE_KEY)


def capabilities_payload(*, refresh: bool = False) -> dict[str, Any]:
    """The full cheap-stage response: every capability plus the environment."""

    capabilities = list_capabilities(refresh=refresh)
    return {
        "capabilities": [capability.to_json() for capability in capabilities],
        # ``list_capabilities`` has already invalidated and re-run the probes,
        # so this reads the warm cache rather than spawning another round.
        "environment": describe_environment(),
        "checkedAt": max(
            (capability.checked_at for capability in capabilities),
            default=utc_now(),
        )
        .isoformat()
        .replace("+00:00", "Z"),
    }


__all__ = [
    "ATTEMPTABLE_STATES",
    "STAGE_ORDER",
    "Capability",
    "CapabilityProvider",
    "CapabilityState",
    "Check",
    "CheckStatus",
    "ClassifiedFailure",
    "DeviceReport",
    "FailureCode",
    "FailureRecord",
    "Remediation",
    "RemediationKind",
    "VerificationStage",
    "capabilities_payload",
    "classify_exception",
    "clear_failures",
    "derive_state",
    "derive_verified_through",
    "describe_environment",
    "get_capability",
    "get_last_failure",
    "get_provider",
    "invalidate_capability_cache",
    "list_capabilities",
    "list_capability_ids",
    "record_exception",
    "record_failure",
    "sanitize_message",
    "sanitize_url",
]
