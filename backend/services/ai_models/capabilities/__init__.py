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

import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .catalogue import (
    BEATS_CAPABILITY_ID,
    COMFYUI_CAPABILITY_ID,
    DESCRIPTORS,
    SAM2_CAPABILITY_ID,
    SAM_AUDIO_CAPABILITY_ID,
    catalogue_generation,
    descriptor_ids,
    descriptors,
    get_descriptor,
    register_descriptor,
    unregister_descriptor,
)
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
from .descriptors import (
    CapabilityDescriptor,
    DirectorySpec,
    Discovery,
    PackageSpec,
    SysPathSpec,
)
from .environment import ENVIRONMENT_PROBE_KEY, describe_environment
from .environment_checks import build_environment_checks
from .failures import (
    DURABLE_FAILURE_CODES,
    ClassifiedFailure,
    classify_exception,
    clear_failures,
    get_last_failure,
    is_durable,
    note_capability_success,
    record_exception,
    record_failure,
    record_load_failures,
    sanitize_message,
    sanitize_url,
)
from .observations import is_capability_checking
from .profiles import (
    INSTALLABLE_PROFILE_IDS,
    PROFILES,
    CapabilityProfile,
    capability_install_remediation,
    capability_was_requested,
    describe_profiles,
    expand_profile_ids,
    get_profile,
    install_command,
    install_remediation,
    invalidate_install_marker_cache,
    profile_for_capability,
    read_install_marker,
    uv_command,
    write_install_marker,
)
from .providers import (
    CapabilityProvider,
    ComfyUIProvider,
    DescriptorProvider,
)
from .runtimes import LazyRuntime, RuntimeLoad, lazy_runtime, reset_lazy_runtimes
from .subprocess_probe import invalidate_probe_cache


#: Capabilities the descriptor shape does not fit, implemented directly against
#: :class:`CapabilityProvider`. ComfyUI is the standing example: no package to
#: probe, no local device, no model files, and a reachability test rather than a
#: load. Forcing it into the table would mean a descriptor that is mostly
#: ``None`` plus an escape hatch — and a table with an escape hatch stops being
#: a table.
_HAND_WRITTEN: tuple[CapabilityProvider, ...] = (ComfyUIProvider(),)

_REGISTRY_LOCK = threading.Lock()
_REGISTRY_CACHE: (
    tuple[
        int,
        tuple[CapabilityProvider, ...],
        dict[str, CapabilityProvider],
    ]
    | None
) = None


def _registry() -> tuple[
    tuple[CapabilityProvider, ...], dict[str, CapabilityProvider]
]:
    """Descriptor-built providers first, then the hand-written ones.

    Rebuilt whenever the descriptor table changes rather than snapshotted at
    import, so registering a capability is the only thing registering a
    capability takes. Registration order is display order.

    Keyed on the catalogue's generation, not on the set of ids: unregistering
    an id and registering a different descriptor under it leaves the id set
    identical, and a cache keyed on that would keep serving the old provider.
    """

    global _REGISTRY_CACHE

    fingerprint = catalogue_generation()
    with _REGISTRY_LOCK:
        cached = _REGISTRY_CACHE
        if cached is not None and cached[0] == fingerprint:
            return cached[1], cached[2]

        providers: tuple[CapabilityProvider, ...] = (
            *(DescriptorProvider(descriptor) for descriptor in descriptors()),
            *_HAND_WRITTEN,
        )
        by_id = {provider.id: provider for provider in providers}
        _REGISTRY_CACHE = (fingerprint, providers, by_id)
        return providers, by_id

#: Cap on concurrent probe subprocesses. Each one may import torch, so fanning
#: out without a limit trades a slow cold cache for a memory spike.
_PROBE_FAN_OUT = 3


def list_capability_ids() -> tuple[str, ...]:
    return tuple(_registry()[1])


def get_provider(capability_id: str) -> CapabilityProvider | None:
    return _registry()[1].get(capability_id)


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

    provider = get_provider(capability_id)
    if provider is None:
        return None
    if refresh:
        invalidate_capability_cache(capability_id)
    return provider.build(
        deep_probe=deep_probe and not is_capability_checking(capability_id)
    )


def list_capabilities(
    *,
    refresh: bool = False,
    deep_probe: bool = True,
) -> list[Capability]:
    if refresh:
        invalidate_capability_cache()

    providers = _registry()[0]

    # Providers share one subprocess for torch and the devices — the probe
    # cache is single-flight per key, so the fan-out joins that one run rather
    # than spawning a torch import per capability.
    with ThreadPoolExecutor(
        max_workers=min(_PROBE_FAN_OUT, len(providers)),
        thread_name_prefix="capability-probe",
    ) as pool:
        return list(
            pool.map(
                lambda provider: provider.build(
                    deep_probe=(
                        deep_probe and not is_capability_checking(provider.id)
                    )
                ),
                providers,
            )
        )


def invalidate_capability_cache(capability_id: str | None = None) -> None:
    """Drop cached probe results.

    Called by an explicit recheck and (from the rollout's later step) by any
    real load attempt, so a capability never keeps reporting a stale
    environment after the user has fixed it.
    """

    # A recheck re-evaluates from scratch, so a failure a previous run
    # recorded is dropped along with the cached probes. Anything still broken
    # is caught again by the checks or by the next real attempt; anything the
    # user has since fixed is no longer held against them.
    #
    # The installer marker is read from disk and cached on its mtime, so a user
    # who reruns the installer and then hits Recheck sees the new record rather
    # than the one this process happened to parse first.
    invalidate_install_marker_cache()
    if capability_id is None:
        invalidate_probe_cache()
        clear_failures()
        return
    invalidate_probe_cache(capability_id)
    clear_failures(capability_id)
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
    "DURABLE_FAILURE_CODES",
    "INSTALLABLE_PROFILE_IDS",
    "PROFILES",
    "BEATS_CAPABILITY_ID",
    "COMFYUI_CAPABILITY_ID",
    "SAM2_CAPABILITY_ID",
    "SAM_AUDIO_CAPABILITY_ID",
    "STAGE_ORDER",
    "DESCRIPTORS",
    "Capability",
    "CapabilityDescriptor",
    "CapabilityProfile",
    "CapabilityProvider",
    "CapabilityState",
    "Check",
    "CheckStatus",
    "ClassifiedFailure",
    "DescriptorProvider",
    "DeviceReport",
    "DirectorySpec",
    "Discovery",
    "FailureCode",
    "FailureRecord",
    "LazyRuntime",
    "PackageSpec",
    "Remediation",
    "RemediationKind",
    "RuntimeLoad",
    "SysPathSpec",
    "VerificationStage",
    "build_environment_checks",
    "capabilities_payload",
    "capability_install_remediation",
    "capability_payload",
    "capability_was_requested",
    "classify_exception",
    "clear_failures",
    "derive_state",
    "derive_verified_through",
    "descriptor_ids",
    "descriptors",
    "evaluated_stages",
    "describe_environment",
    "describe_profiles",
    "expand_profile_ids",
    "get_capability",
    "get_descriptor",
    "get_last_failure",
    "get_profile",
    "get_provider",
    "install_command",
    "install_remediation",
    "invalidate_capability_cache",
    "invalidate_install_marker_cache",
    "is_durable",
    "lazy_runtime",
    "note_capability_success",
    "list_capabilities",
    "list_capability_ids",
    "profile_for_capability",
    "read_install_marker",
    "register_descriptor",
    "record_exception",
    "record_failure",
    "record_load_failures",
    "reset_lazy_runtimes",
    "sanitize_message",
    "sanitize_url",
    "unregister_descriptor",
    "uv_command",
    "write_install_marker",
]
