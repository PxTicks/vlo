"""The descriptor table — the single registration site for a local runtime.

Adding a capability here gives it, with no other edit: a provider in the
registry, an entry in ``/app/runtime-capabilities``, its packages and cache
directories and model search paths in the environment snapshot, an
``/app/status`` field derived from ``canAttempt``, and a load boundary that
records real failures whether or not anyone remembered to ask for it.

Only two things stay bespoke, because they are genuinely different per
capability: model discovery, and the factory that builds the runtime. Both are
named as ``"module:attr"`` strings so that reading this table never imports an
optional ML dependency graph.

Why one table rather than a descriptor declared inside each provider module:
:mod:`.environment` derives the snapshot from these descriptors, and the
provider modules import from :mod:`.environment`. A table that lives below both
is the acyclic arrangement.

ComfyUI is deliberately absent — see :mod:`.descriptors`.
"""

from __future__ import annotations

import threading
from collections.abc import Callable

from .contract import Remediation, RemediationKind
from .descriptors import (
    CapabilityDescriptor,
    DirectorySpec,
    PackageSpec,
    SysPathSpec,
)
from .profiles import BASE_PROFILE_ID, SAM2_PROFILE_ID, SAM_AUDIO_PROFILE_ID


SAM2_CAPABILITY_ID = "sam2"
SAM_AUDIO_CAPABILITY_ID = "sam-audio"
BEATS_CAPABILITY_ID = "beat-this"
COMFYUI_CAPABILITY_ID = "comfyui"

_PROVIDERS_MODULE = "services.ai_models.capabilities.providers"

#: Cancellation is not failure, so it passes through the load boundary
#: unrecorded rather than becoming the capability's ``lastFailure``.
_CANCELLED = "services.jobs:BackendJobCancelledError"


SAM2_DESCRIPTOR = CapabilityDescriptor(
    id=SAM2_CAPABILITY_ID,
    label="SAM2",
    profile=SAM2_PROFILE_ID,
    packages=(
        # Probing the submodule rather than the top-level name matters: the
        # installer's ``backend/sam2`` clone makes a bare ``import sam2``
        # succeed as an empty namespace package even when nothing was
        # installed into the venv.
        PackageSpec(
            module="sam2",
            distribution="sam2",
            import_target="sam2.build_sam",
        ),
    ),
    python_min=(3, 10),
    device_env_var="SAM2_DEVICE",
    cache_dirs=(
        DirectorySpec(
            id="sam2.cache",
            config_attr="SAM2_CACHE_DIR",
            label="The SAM2 cache directory",
        ),
    ),
    search_paths=("SAM2_SEARCH_PATHS",),
    sys_path=SysPathSpec(env_var="SAM2_PYTHONPATH", include_backend_root=True),
    app_status_key="sam2",
    unavailable_message="No SAM2 models discovered",
    uses_local_gpu=True,
    loader="services.sam2.sam2_service:build_sam2_runtime",
    discover_models=f"{_PROVIDERS_MODULE}.sam2:discover",
    download_remediation=Remediation(
        kind=RemediationKind.DOWNLOAD,
        summary="Download a SAM2 checkpoint from the model manager",
    ),
)


SAM_AUDIO_DESCRIPTOR = CapabilityDescriptor(
    id=SAM_AUDIO_CAPABILITY_ID,
    label="SAM-Audio",
    profile=SAM_AUDIO_PROFILE_ID,
    packages=(PackageSpec(module="sam_audio", distribution="sam-audio"),),
    python_min=(3, 11),
    device_env_var="SAM_AUDIO_DEVICE",
    cache_dirs=(
        DirectorySpec(
            id="samAudio.cache",
            config_attr="SAM_AUDIO_CACHE_DIR",
            label="The SAM-Audio cache directory",
        ),
        # Inventory, not a requirement: the discovery stage already reports
        # whether the models are there, so this one is snapshot-only.
        DirectorySpec(
            id="samAudio.models",
            config_attr="SAM_AUDIO_MODEL_DIR",
            label="The SAM-Audio model directory",
            check_id=None,
        ),
    ),
    search_paths=("SAM_AUDIO_SEARCH_PATHS",),
    sys_path=SysPathSpec(
        env_var="SAM_AUDIO_PYTHONPATH",
        home_relative=("sam-audio",),
    ),
    # The accelerator shims the real load path fakes when they are absent,
    # plus wandb, which SAM-Audio's dependency chain imports at module scope
    # and uses only for training.
    import_stubs=("xformers.ops.fmha", "torchcodec.decoders", "wandb"),
    app_status_key="sam_audio",
    unavailable_message="No SAM-Audio model configured",
    uses_local_gpu=True,
    loader="services.sam_audio.sam_audio_service:build_sam_audio_runtime",
    discover_models=f"{_PROVIDERS_MODULE}.sam_audio:discover",
    cancel_exception=_CANCELLED,
    download_remediation=Remediation(
        kind=RemediationKind.DOWNLOAD,
        summary="Download a SAM-Audio model from the model manager",
    ),
)


BEATS_DESCRIPTOR = CapabilityDescriptor(
    id=BEATS_CAPABILITY_ID,
    label="Beat This!",
    # Part of the base backend requirements, which is what makes a missing
    # package here a broken install rather than a feature nobody asked for.
    profile=BASE_PROFILE_ID,
    packages=(
        PackageSpec(
            module="beat_this",
            distribution="beat-this",
            import_target="beat_this.inference",
        ),
        PackageSpec(
            module="madmom",
            distribution="madmom",
            optional=True,
            feature="DBN post-processing",
            install_summary="Install madmom to enable DBN post-processing",
            install_target="git+https://github.com/CPJKU/madmom.git",
        ),
    ),
    python_min=(3, 10),
    device_env_var="BEATTHIS_DEVICE",
    cache_dirs=(
        DirectorySpec(
            id="beatThis.cache",
            config_attr="BEATTHIS_CACHE_DIR",
            label="The Beat This! cache directory",
        ),
    ),
    sys_path=SysPathSpec(include_backend_root=True),
    app_status_key="beat_this",
    unavailable_message="Beat This! is not installed",
    uses_local_gpu=True,
    loader="services.beats.beats_service:build_beats_runtime",
    discover_models=f"{_PROVIDERS_MODULE}.beats:discover",
)


#: The capabilities this build ships. Registration order is display order.
DESCRIPTORS: tuple[CapabilityDescriptor, ...] = (
    SAM2_DESCRIPTOR,
    SAM_AUDIO_DESCRIPTOR,
    BEATS_DESCRIPTOR,
)

# The live table. Every consumer reads it through ``descriptors()`` rather than
# binding the tuple above at import time, so a capability registered after
# start-up reaches the registry, the environment snapshot and ``/app/status``
# by the same route as a built-in one — which is the property the completeness
# sweep exists to hold.
_DESCRIPTORS: list[CapabilityDescriptor] = list(DESCRIPTORS)
_BY_ID: dict[str, CapabilityDescriptor] = {
    descriptor.id: descriptor for descriptor in _DESCRIPTORS
}
_LOCK = threading.Lock()

# Bumped on every registration change. Consumers that cache anything derived
# from the table key their cache on this rather than on the set of ids: an
# unregister followed by a register of the *same* id leaves the id set
# identical while the descriptor behind it is a different object entirely.
_GENERATION = 0

_LISTENERS: list[Callable[[str], None]] = []


def descriptors() -> tuple[CapabilityDescriptor, ...]:
    """Every registered descriptor, in registration order."""

    return tuple(_DESCRIPTORS)


def catalogue_generation() -> int:
    """Monotonic counter of registration changes.

    The cache key for anything derived from the table.
    """

    return _GENERATION


def add_change_listener(listener: Callable[[str], None]) -> None:
    """Be told, by capability id, when the table changes.

    Registration is not just a lookup: a capability carries process state —
    a loaded runtime, a recorded failure — that must not outlive the descriptor
    it was produced under. Listeners are how that state is dropped without the
    table having to import the modules holding it.
    """

    with _LOCK:
        if listener not in _LISTENERS:
            _LISTENERS.append(listener)


def _notify(capability_id: str) -> None:
    # Called with the lock released: a listener may reasonably call back into
    # this module to ask what is registered now.
    for listener in tuple(_LISTENERS):
        listener(capability_id)


def get_descriptor(capability_id: str) -> CapabilityDescriptor | None:
    return _BY_ID.get(capability_id)


def descriptor_ids() -> tuple[str, ...]:
    return tuple(_BY_ID)


def descriptor_packages() -> tuple[str, ...]:
    """Every distribution named by a descriptor, in registration order."""

    names: list[str] = []
    for descriptor in descriptors():
        for package in descriptor.packages:
            if package.report_name not in names:
                names.append(package.report_name)
    return tuple(names)


def register_descriptor(descriptor: CapabilityDescriptor) -> None:
    """Add a capability to the live table.

    The table above is the normal registration site; this is what makes it a
    table rather than a hardcoded tuple, and it is what the completeness sweep
    uses to prove that a capability registered by descriptor alone behaves
    identically to a built-in one.
    """

    global _GENERATION

    with _LOCK:
        if descriptor.id in _BY_ID:
            raise ValueError(f"'{descriptor.id}' is already registered")
        _DESCRIPTORS.append(descriptor)
        _BY_ID[descriptor.id] = descriptor
        _GENERATION += 1
    _notify(descriptor.id)


def unregister_descriptor(capability_id: str) -> None:
    """Remove a capability from the live table, if it is in it."""

    global _GENERATION

    with _LOCK:
        descriptor = _BY_ID.pop(capability_id, None)
        if descriptor is None:
            return
        _DESCRIPTORS.remove(descriptor)
        _GENERATION += 1
    _notify(capability_id)


__all__ = [
    "BEATS_CAPABILITY_ID",
    "BEATS_DESCRIPTOR",
    "COMFYUI_CAPABILITY_ID",
    "DESCRIPTORS",
    "SAM2_CAPABILITY_ID",
    "SAM2_DESCRIPTOR",
    "SAM_AUDIO_CAPABILITY_ID",
    "SAM_AUDIO_DESCRIPTOR",
    "add_change_listener",
    "catalogue_generation",
    "descriptor_ids",
    "descriptor_packages",
    "descriptors",
    "get_descriptor",
    "register_descriptor",
    "unregister_descriptor",
]
