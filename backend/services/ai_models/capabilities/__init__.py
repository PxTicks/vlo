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
    evaluated_stages,
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
from .providers.beats import CAPABILITY_ID as BEATS_CAPABILITY_ID
from .providers.comfyui import CAPABILITY_ID as COMFYUI_CAPABILITY_ID
from .providers.sam2 import CAPABILITY_ID as SAM2_CAPABILITY_ID
from .providers.sam_audio import CAPABILITY_ID as SAM_AUDIO_CAPABILITY_ID
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


def get_capability(
    capability_id: str,
    *,
    refresh: bool = False,
    deep_probe: bool = True,
) -> Capability | None:
    """One capability's cheap-stage report.

    ``deep_probe=False`` guarantees no subprocess is spawned — the caller gets
    the static checks plus whatever import result is already warm. That is what
    makes this safe to call from ``/app/status``, which is on the startup path.
    """

    provider = _PROVIDERS_BY_ID.get(capability_id)
    if provider is None:
        return None
    if refresh:
        invalidate_capability_cache(capability_id)
    return provider.build(deep_probe=deep_probe)


def list_capabilities(
    *,
    refresh: bool = False,
    deep_probe: bool = True,
) -> list[Capability]:
    if refresh:
        invalidate_capability_cache()

    # Providers share one subprocess for torch and the devices — the probe
    # cache is single-flight per key, so the fan-out joins that one run rather
    # than spawning a torch import per capability.
    with ThreadPoolExecutor(
        max_workers=min(_PROBE_FAN_OUT, len(_PROVIDERS)),
        thread_name_prefix="capability-probe",
    ) as pool:
        return list(
            pool.map(lambda provider: provider.build(deep_probe=deep_probe), _PROVIDERS)
        )


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
    """The full cheap-stage response: every capability plus the environment.

    There is deliberately no payload-level timestamp. Capabilities can be
    rechecked one at a time, so each object carries the time it was checked and
    nothing claims to cover the whole response.
    """

    capabilities = list_capabilities(refresh=refresh)
    return {
        "capabilities": [capability.to_json() for capability in capabilities],
        # ``list_capabilities`` has already invalidated and re-run the probes,
        # so this reads the warm cache rather than spawning another round.
        "environment": describe_environment(),
    }


def capability_payload(
    capability_id: str,
    *,
    refresh: bool = False,
) -> dict[str, Any] | None:
    """One capability, in the same envelope as the listing.

    The environment travels with it because a recheck drops the shared
    torch/device probe as well: returning the capability alone would leave a
    caller showing a freshly checked feature beside device information from
    before the recheck.
    """

    capability = get_capability(capability_id, refresh=refresh)
    if capability is None:
        return None
    return {
        "capability": capability.to_json(),
        "environment": describe_environment(),
    }


__all__ = [
    "ATTEMPTABLE_STATES",
    "BEATS_CAPABILITY_ID",
    "COMFYUI_CAPABILITY_ID",
    "SAM2_CAPABILITY_ID",
    "SAM_AUDIO_CAPABILITY_ID",
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
    "capability_payload",
    "classify_exception",
    "clear_failures",
    "derive_state",
    "derive_verified_through",
    "evaluated_stages",
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
