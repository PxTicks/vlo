"""The descriptor table, and what registering a capability actually takes.

The governing case here mirrors the parent plan's: **a new capability
registered by descriptor alone — with no edits to ``environment.py``,
``main.py``, or any service's load path — behaves identically to a native
one.** Everything else in this file exists to keep that true: a completeness
sweep over the table, and the row-6 regression (a service that forgets to wrap
its loader) made structurally impossible rather than merely absent.
"""

from __future__ import annotations

import asyncio
import inspect
import re
import sys
from contextlib import contextmanager
from pathlib import Path
from dataclasses import replace
from types import ModuleType

import pytest

from services.ai_models.capabilities import (
    COMFYUI_CAPABILITY_ID,
    CapabilityDescriptor,
    CapabilityState,
    DeviceSpec,
    DirectorySpec,
    Discovery,
    FromConfig,
    PackageSpec,
    RuntimeLoad,
    SearchPathSpec,
    VerificationStage,
    capabilities_payload,
    descriptors,
    evaluated_stages,
    failures,
    get_capability,
    get_profile,
    get_provider,
    lazy_runtime,
    list_capability_ids,
    register_descriptor,
    unregister_descriptor,
)
from services.ai_models.capabilities.contract import (
    Check,
    CheckStatus,
    FailureCode,
)
from services.ai_models.capabilities.descriptors import resolve_ref
from services.ai_models.capabilities.environment import (
    UNRESOLVED,
    resolve_directory,
    resolve_search_paths,
    resolve_source,
)
from services.ai_models.capabilities.load_probes import (
    PROBE_JOB_OWNER,
    PROBE_JOB_OWNER_VERSION,
    PROBE_JOB_TYPE,
    RuntimeCapabilityProbeJobs,
    _run_probe_job,
)
from services.ai_models.capabilities.environment import display_path
from services.ai_models.capabilities.providers.base import CapabilityProvider
from services.ai_models.capabilities.providers.descriptor import DescriptorProvider
from services.ai_models.health import app_status_providers
from services.jobs import BackendJobDefinition, BackendJobManager, JobArtifactStore

from conftest import _FakeEnvironment  # noqa: E402

# Imported here, before any test registers anything: the point of the
# ``/app/status`` assertion below is that a capability registered *after*
# ``main`` was imported still reaches the response. Leaving ``main`` to be
# imported lazily inside the fixture would let an import-time snapshot of the
# provider list pass the test by accident.
import main  # noqa: E402,F401


PROJECT_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_STATUS_TS = PROJECT_ROOT / "frontend" / "src" / "types" / "RuntimeStatus.ts"

FAKE_MODULE = "vlo_fake_capability"
FAKE_ID = "vlo-fake"


def _probe_manager(tmp_path: Path) -> BackendJobManager:
    manager = BackendJobManager(
        JobArtifactStore(tmp_path / "probe-artifacts"),
        executor_max_workers=2,
        max_concurrent_jobs_per_owner=2,
    )
    manager.register_owner(
        PROBE_JOB_OWNER,
        PROBE_JOB_OWNER_VERSION,
        (
            BackendJobDefinition(
                id=PROBE_JOB_TYPE,
                label="Test runtime",
                run=_run_probe_job,
            ),
        ),
    )
    return manager


async def _terminal_snapshot(
    jobs: RuntimeCapabilityProbeJobs,
    capability_id: str,
    job_id: str,
):
    for _ in range(200):
        snapshot = jobs.get(capability_id, job_id)
        if snapshot.status not in {"queued", "running"}:
            return snapshot
        await asyncio.sleep(0.01)
    raise AssertionError("runtime probe did not finish")


# --------------------------------------------------------------------------
# The completeness sweep
# --------------------------------------------------------------------------


def _registration_problems(descriptor: CapabilityDescriptor) -> list[str]:
    """Everything that would make this descriptor a half-registration.

    Shared by the sweep and by the test that proves the sweep can fail: a
    ``"module:attr"`` string is less greppable than a call, and resolving every
    one here is what turns a typo into a test failure instead of a runtime
    surprise the first time someone presses Test runtime.
    """

    problems: list[str] = []

    if not descriptor.id:
        problems.append("no id")
    if not descriptor.label:
        problems.append("no label")

    for field, arity in (("loader", 1), ("discover_models", 1)):
        reference = getattr(descriptor, field)
        if reference is None:
            problems.append(f"{field} is not declared")
            continue
        try:
            target = resolve_ref(reference)
        except (ImportError, AttributeError, ValueError) as exc:
            problems.append(f"{field} {reference!r} does not resolve ({exc})")
            continue
        if not callable(target):
            problems.append(f"{field} {reference!r} is not callable")
            continue
        if field == "discover_models":
            # Called with the descriptor so a hook can reach its own
            # remediation without importing the table.
            parameters = inspect.signature(target).parameters
            if len(parameters) != arity:
                problems.append(
                    f"discover_models must take exactly {arity} argument"
                )

    if descriptor.cancel_exception is not None:
        try:
            cancel = resolve_ref(descriptor.cancel_exception)
        except (ImportError, AttributeError, ValueError) as exc:
            problems.append(f"cancel_exception does not resolve ({exc})")
        else:
            if not (
                isinstance(cancel, type) and issubclass(cancel, BaseException)
            ):
                problems.append("cancel_exception is not an exception type")

    # ``None`` is a legitimate answer — a capability no installer step covers —
    # but a name that is not in the profile table is a typo.
    if descriptor.profile is not None and get_profile(descriptor.profile) is None:
        problems.append(f"unknown install profile {descriptor.profile!r}")

    if descriptor.app_status_key and not descriptor.unavailable_message:
        problems.append("an app_status_key with no unavailable_message")

    if descriptor.packages and descriptor.primary_package is None:
        problems.append("every declared package is optional")

    # A declared location that cannot be produced is a broken descriptor, not
    # an absent directory. Resolving every one here is what stops the silent
    # variant: a capability that quietly reports one fewer check than its
    # neighbours and looks perfectly healthy doing it.
    for directory in descriptor.cache_dirs:
        if resolve_directory(directory) is None:
            problems.append(f"cache directory {directory.id!r} does not resolve")
    for index, search_path in enumerate(descriptor.search_paths):
        if resolve_search_paths(search_path) is None:
            problems.append(f"search path #{index} does not resolve")
    if (
        descriptor.device is not None
        and resolve_source(descriptor.device.requested) is UNRESOLVED
    ):
        problems.append("device source does not resolve")

    return problems


def test_every_descriptor_is_completely_registered() -> None:
    for descriptor in descriptors():
        assert _registration_problems(descriptor) == [], descriptor.id


def test_descriptor_identities_are_unique() -> None:
    table = descriptors()

    ids = [descriptor.id for descriptor in table]
    assert len(set(ids)) == len(ids)

    # Two capabilities sharing an ``/app/status`` field would silently
    # overwrite each other in the response.
    status_keys = [
        descriptor.app_status_key
        for descriptor in table
        if descriptor.app_status_key
    ]
    assert len(set(status_keys)) == len(status_keys)

    # Same for the environment snapshot's ``searchPaths`` — but only among the
    # descriptors that emit a key there. One that declares no search paths
    # contributes nothing to collide with.
    snapshot_keys = [
        descriptor.snapshot_key for descriptor in table if descriptor.search_paths
    ]
    assert len(set(snapshot_keys)) == len(snapshot_keys)


def test_a_descriptor_that_cannot_resolve_a_location_fails_the_sweep(
    tmp_path: Path,
) -> None:
    broken = CapabilityDescriptor(
        id="broken.paths",
        label="Broken paths",
        device=DeviceSpec(FromConfig("MISSING_DEVICE_ATTRIBUTE")),
        cache_dirs=(
            DirectorySpec(
                id="broken.cache",
                path=FromConfig("NO_SUCH_CONFIG_ATTRIBUTE"),
                label="The broken cache directory",
            ),
        ),
        search_paths=(SearchPathSpec(FromConfig("ALSO_MISSING")),),
        loader=f"{FAKE_MODULE}:build",
        discover_models=f"{FAKE_MODULE}:discover",
    )

    problems = _registration_problems(broken)

    assert any("cache directory" in problem for problem in problems)
    assert any("search path" in problem for problem in problems)
    assert any("device source" in problem for problem in problems)


def test_an_unresolvable_directory_reports_a_failing_check(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # The runtime half of the same guarantee. Before this, the check simply
    # disappeared from the capability's evidence and nothing said so.
    monkeypatch.setitem(sys.modules, FAKE_MODULE, _fake_module())
    descriptor = _fake_descriptor(tmp_path / "models", tmp_path / "models")
    broken = replace(
        descriptor,
        cache_dirs=(
            DirectorySpec(
                id="vloFake.cache",
                path=FromConfig("NO_SUCH_CONFIG_ATTRIBUTE"),
                label="The fake cache directory",
            ),
        ),
    )
    register_descriptor(broken)
    try:
        capability = get_capability(FAKE_ID)
        assert capability is not None
        cache = next(c for c in capability.checks if c.id == "cache.directory")
        assert cache.status is CheckStatus.FAIL
        assert cache.code is FailureCode.CONFIG_MISSING
        assert capability.state is CapabilityState.BLOCKED

        # And it is absent from the snapshot rather than listed with a
        # placeholder path, which the payload contract has no room for.
        directories = capabilities_payload()["environment"]["directories"]
        assert "vloFake.cache" not in {entry["id"] for entry in directories}
    finally:
        unregister_descriptor(FAKE_ID)


def test_an_unresolvable_device_reports_a_failing_check(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Defaulting an unknown device to "auto" passes the check and establishes
    # nothing — the same silent-health defect an unresolvable directory used to
    # have, one field over.
    monkeypatch.setitem(sys.modules, FAKE_MODULE, _fake_module())
    models = tmp_path / "models"
    models.mkdir()
    broken = replace(
        _fake_descriptor(tmp_path, models),
        device=DeviceSpec(FromConfig("MISSING_DEVICE_ATTRIBUTE")),
    )
    register_descriptor(broken)
    try:
        capability = get_capability(FAKE_ID)
        assert capability is not None
        device = next(c for c in capability.checks if c.id == "device.requested")
        assert device.status is CheckStatus.FAIL
        assert device.code is FailureCode.CONFIG_MISSING
        assert capability.state is CapabilityState.BLOCKED
        # No invented placeholder where the payload promises a real request.
        assert capability.device is None
    finally:
        unregister_descriptor(FAKE_ID)


def test_ids_folding_to_one_key_without_search_paths_are_both_accepted(
    tmp_path: Path,
) -> None:
    # Only a descriptor that declares search paths emits a snapshot key, so a
    # pair that emits none cannot overwrite anything and must not be refused.
    first = replace(
        _fake_descriptor(tmp_path, tmp_path, capability_id="acme.tracker"),
        search_paths=(),
        app_status_key=None,
    )
    second = replace(
        _fake_descriptor(tmp_path, tmp_path, capability_id="acme-tracker"),
        search_paths=(),
        app_status_key=None,
    )
    assert first.snapshot_key == second.snapshot_key

    register_descriptor(first)
    try:
        register_descriptor(second)
        unregister_descriptor(second.id)
    finally:
        unregister_descriptor(first.id)


def test_a_namespaced_id_produces_a_well_formed_snapshot_key(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Extension ids are namespaced, and a dotted id used to leak its dot
    # straight into an environment-snapshot key.
    monkeypatch.setitem(sys.modules, FAKE_MODULE, _fake_module())
    models = tmp_path / "models"
    models.mkdir()
    descriptor = _fake_descriptor(
        tmp_path, models, capability_id="acme.motion-tracker"
    )
    assert descriptor.snapshot_key == "acmeMotionTracker"

    register_descriptor(descriptor)
    try:
        search_paths = capabilities_payload()["environment"]["searchPaths"]
        assert search_paths["acmeMotionTracker"] == [display_path(models)]
    finally:
        unregister_descriptor(descriptor.id)


def test_two_ids_claiming_one_snapshot_key_are_rejected(
    tmp_path: Path,
) -> None:
    # Separators fold, so distinct ids can collide on the derived key. Silently
    # overwriting would drop one capability's search paths from every export.
    first = _fake_descriptor(tmp_path, tmp_path, capability_id="acme.tracker")
    second = _fake_descriptor(tmp_path, tmp_path, capability_id="acme-tracker")

    register_descriptor(first)
    try:
        with pytest.raises(ValueError, match="snapshot key"):
            register_descriptor(second)
    finally:
        # Both, unconditionally: if the guard ever regresses the second
        # registration succeeds, and leaking it would fail unrelated tests
        # further down the file rather than this one.
        unregister_descriptor(first.id)
        unregister_descriptor(second.id)


def test_a_descriptor_missing_a_required_field_fails_the_sweep() -> None:
    # The sweep is only worth having if it can fail, so this is the negative
    # half: a descriptor whose loader names something that is not there.
    broken = CapabilityDescriptor(
        id="broken",
        label="Broken",
        loader="services.sam2.sam2_service:no_such_loader",
        discover_models="services.ai_models.capabilities.providers.sam2:discover",
        profile="not-a-profile",
    )

    problems = _registration_problems(broken)

    assert any("loader" in problem for problem in problems)
    assert any("install profile" in problem for problem in problems)


def test_the_frontend_capability_ids_match_the_registry() -> None:
    # Generating TypeScript from Python is not worth a build step for four ids,
    # so the hand-written constant is asserted against the registry instead.
    source = RUNTIME_STATUS_TS.read_text(encoding="utf-8")
    block = re.search(
        r"RUNTIME_CAPABILITY_IDS\s*=\s*\{(.*?)\}\s*as const;",
        source,
        re.DOTALL,
    )
    assert block is not None, "RUNTIME_CAPABILITY_IDS is no longer declared"

    declared = set(re.findall(r'"([^"]+)"', block.group(1)))
    assert declared == set(list_capability_ids())


# --------------------------------------------------------------------------
# ComfyUI keeps its hand-written provider
# --------------------------------------------------------------------------


def test_comfyui_is_registered_the_hand_written_way(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    comfyui = get_provider(COMFYUI_CAPABILITY_ID)

    assert isinstance(comfyui, CapabilityProvider)
    assert not isinstance(comfyui, DescriptorProvider)
    assert COMFYUI_CAPABILITY_ID not in {
        descriptor.id for descriptor in descriptors()
    }

    # And it still serialises alongside the descriptor-built ones.
    payload = capabilities_payload()
    ids = [capability["id"] for capability in payload["capabilities"]]
    assert ids[-1] == COMFYUI_CAPABILITY_ID
    assert ids[:-1] == [descriptor.id for descriptor in descriptors()]


# --------------------------------------------------------------------------
# A capability registered by descriptor alone
# --------------------------------------------------------------------------


def _fake_module(*, outcome: str = "ok") -> ModuleType:
    """A stand-in service module, reachable by ``"module:attr"``.

    Deliberately contains no ``record_load_failures`` and no probe entry point
    of its own — that is the whole point of the exercise.

    ``outcome`` picks how the loader behaves: it succeeds, it raises, or it
    returns something that is not a :class:`RuntimeLoad` at all — the mistake a
    newly written loader is most likely to make.
    """

    module = ModuleType(FAKE_MODULE)

    def discover(descriptor: CapabilityDescriptor) -> Discovery:
        return Discovery(
            checks=(
                Check(
                    id="model.default",
                    status=CheckStatus.PASS,
                    stage=VerificationStage.DISCOVERED,
                    summary=f"A {descriptor.label} model is present",
                ),
            ),
            selected_model="fake-model",
            found=True,
        )

    def build(on_progress=None):
        if on_progress is not None:
            on_progress(0.5, "Loading the fake runtime")
        if outcome == "raise":
            raise ModuleNotFoundError(
                "No module named 'vlo_fake_runtime'", name="vlo_fake_runtime"
            )
        if outcome == "wrong-shape":
            return {"resolvedDevice": "cuda"}
        return RuntimeLoad(value=object(), resolved_device="cpu")

    def build_alternate(on_progress=None) -> RuntimeLoad:
        del on_progress
        return RuntimeLoad(value="alternate", resolved_device="cpu")

    module.discover = discover  # type: ignore[attr-defined]
    module.build = build  # type: ignore[attr-defined]
    module.build_alternate = build_alternate  # type: ignore[attr-defined]
    return module


def _fake_descriptor(
    cache_dir: Path,
    models_dir: Path,
    *,
    label: str = "Fake runtime",
    loader: str = f"{FAKE_MODULE}:build",
    capability_id: str = FAKE_ID,
) -> CapabilityDescriptor:
    """A descriptor written the way an extension has to write one.

    Every location is supplied as a value. Nothing here names a ``config``
    attribute, because an extension has none and must not add any — which is
    the property the fixture below asserts.
    """

    return CapabilityDescriptor(
        id=capability_id,
        label=label,
        packages=(PackageSpec(module="vlo_fake_runtime", distribution="vlo-fake"),),
        python_min=(3, 10),
        device=DeviceSpec(requested="cpu", env_var="VLO_FAKE_DEVICE"),
        cache_dirs=(
            DirectorySpec(
                id="vloFake.cache",
                path=cache_dir,
                label="The fake cache directory",
            ),
        ),
        search_paths=(SearchPathSpec((models_dir,)),),
        app_status_key="vlo_fake",
        unavailable_message="The fake runtime is not installed",
        uses_local_gpu=True,
        loader=loader,
        discover_models=f"{FAKE_MODULE}:discover",
    )


@pytest.fixture
def fake_capability(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
    request: pytest.FixtureRequest,
) -> CapabilityDescriptor:
    """Register a capability the way a new one would be registered.

    Nothing here touches ``environment.py``, ``main.py``, ``profiles.py`` or a
    service load path — a descriptor and the two hooks it names, and that is
    all.
    """

    import config

    outcome = getattr(request, "param", "ok")
    cache_dir = tmp_path / "fake-cache"
    models_dir = tmp_path / "fake-models"
    cache_dir.mkdir()
    models_dir.mkdir()

    before = set(vars(config))
    monkeypatch.setitem(sys.modules, FAKE_MODULE, _fake_module(outcome=outcome))

    descriptor = _fake_descriptor(cache_dir, models_dir)
    register_descriptor(descriptor)
    try:
        yield descriptor
    finally:
        unregister_descriptor(descriptor.id)

    # The governing constraint, checked rather than asserted in prose: an
    # extension configures its capability entirely from its own descriptor.
    assert set(vars(config)) == before


def test_a_descriptor_alone_reports_both_cheap_stages(
    fake_capability: CapabilityDescriptor,
) -> None:
    capability = get_capability(FAKE_ID)

    assert capability is not None
    assert capability.state is CapabilityState.AVAILABLE_UNVERIFIED
    assert capability.can_attempt is True
    assert capability.selected_model == "fake-model"
    assert evaluated_stages(capability.checks) == (
        VerificationStage.DISCOVERED,
        VerificationStage.ENVIRONMENT,
    )
    assert {check.id for check in capability.checks} == {
        "model.default",
        "python.version",
        "package.vlo_fake_runtime",
        "device.requested",
        "cache.directory",
    }

    # The device and the cache directory came from the descriptor's own values,
    # not from a ``config`` attribute the extension would have had to create.
    assert capability.device is not None
    assert capability.device.requested == "cpu"
    device = next(c for c in capability.checks if c.id == "device.requested")
    assert device.status is CheckStatus.PASS
    cache = next(c for c in capability.checks if c.id == "cache.directory")
    assert cache.status is CheckStatus.PASS


def test_a_descriptor_alone_appears_in_the_environment_snapshot(
    fake_capability: CapabilityDescriptor,
    tmp_path: Path,
) -> None:
    environment = capabilities_payload()["environment"]

    assert "vlo-fake" in environment["packages"]

    cache = next(
        entry for entry in environment["directories"] if entry["id"] == "vloFake.cache"
    )
    assert cache["exists"] is True
    assert cache["writable"] is True

    # Compared through ``display_path`` because the snapshot sanitises paths
    # on the way out, and a temporary directory name can look token-shaped.
    assert environment["searchPaths"]["vloFake"] == [
        display_path(tmp_path / "fake-models")
    ]


@pytest.mark.anyio
async def test_a_descriptor_alone_gets_an_app_status_field(
    fake_capability: CapabilityDescriptor,
    offline_app_status,
) -> None:
    # Asserted against the real endpoint, not the helper that feeds it: the
    # list has to be read per request, or a capability registered after
    # start-up would be built into a tuple nothing ever looks at again.
    assert "vlo_fake" in {
        provider.response_key for provider in app_status_providers()
    }

    status = await offline_app_status.get_app_status()
    assert status["vlo_fake"]["status"] == "available"

    # And the field is derived from ``canAttempt``, not from inventory: a
    # durable failure flips it without anything on disk changing.
    failures.record_exception(
        FAKE_ID, ModuleNotFoundError("No module named 'vlo_fake_runtime'")
    )
    status = await offline_app_status.get_app_status()
    assert status["vlo_fake"]["status"] == "unavailable"
    assert get_capability(FAKE_ID).can_attempt is False


def test_re_registering_an_id_replaces_the_provider_and_the_cell(
    fake_capability: CapabilityDescriptor,
    tmp_path: Path,
) -> None:
    # The id set is identical across an unregister/register pair, so anything
    # caching on it alone keeps serving the descriptor that is no longer there.
    assert get_provider(FAKE_ID).label == "Fake runtime"
    assert lazy_runtime(FAKE_ID).get() != "alternate"

    unregister_descriptor(FAKE_ID)
    register_descriptor(
        _fake_descriptor(
            fake_capability.cache_dirs[0].path,
            tmp_path / "fake-models",
            label="Replacement runtime",
            loader=f"{FAKE_MODULE}:build_alternate",
        )
    )

    assert get_provider(FAKE_ID).label == "Replacement runtime"
    assert get_capability(FAKE_ID).label == "Replacement runtime"
    # And the cell is rebuilt around the new loader rather than handing back
    # the runtime the old one produced.
    assert lazy_runtime(FAKE_ID).get() == "alternate"


def test_unregistering_forgets_what_the_old_runtime_established(
    fake_capability: CapabilityDescriptor,
    tmp_path: Path,
) -> None:
    lazy_runtime(FAKE_ID).get()
    assert get_capability(FAKE_ID).verified_through is VerificationStage.LOADED

    unregister_descriptor(FAKE_ID)
    register_descriptor(
        _fake_descriptor(fake_capability.cache_dirs[0].path, tmp_path / "fake-models")
    )

    # A load observation is what makes a provider report ``loaded``; carried
    # across a re-registration it would claim proof for a runtime this process
    # has never built.
    capability = get_capability(FAKE_ID)
    assert capability.verified_through is VerificationStage.ENVIRONMENT
    assert capability.last_successful_load is None
    assert capability.last_failure is None


# --------------------------------------------------------------------------
# The row-6 regression, made structurally impossible
# --------------------------------------------------------------------------


@pytest.mark.parametrize("fake_capability", ["raise"], indirect=True)
def test_a_loader_nobody_wrapped_still_records_a_real_failure(
    fake_capability: CapabilityDescriptor,
) -> None:
    # The fake service module contains no ``record_load_failures``. It does not
    # need to: the registry owns the memo cell, so there is no unrecorded way
    # to obtain the runtime.
    with pytest.raises(ModuleNotFoundError):
        lazy_runtime(FAKE_ID).get()

    recorded = failures.get_last_failure(FAKE_ID)
    assert recorded is not None
    assert recorded.code is FailureCode.PACKAGE_MISSING
    assert recorded.stage is VerificationStage.LOADED

    # Durable, so the capability is blocked rather than still claiming to be
    # attemptable.
    capability = get_capability(FAKE_ID)
    assert capability is not None
    assert capability.state is CapabilityState.BLOCKED
    assert capability.can_attempt is False


def test_a_successful_load_through_the_cell_proves_the_loaded_stage(
    fake_capability: CapabilityDescriptor,
) -> None:
    lazy_runtime(FAKE_ID).get()

    capability = get_capability(FAKE_ID)
    assert capability is not None
    assert capability.state is CapabilityState.READY
    assert capability.verified_through is VerificationStage.LOADED
    # The device the runtime actually landed on, not the one the configuration
    # was expected to resolve to.
    assert capability.device is not None
    assert capability.device.resolved == "cpu"
    assert capability.device.proven is True


@pytest.mark.asyncio
async def test_the_probe_job_takes_the_gpu_lease_and_reports_loaded(
    fake_capability: CapabilityDescriptor,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # The Test-runtime job needs nothing capability-specific either: it reads
    # ``uses_local_gpu`` off the descriptor and loads through the same cell
    # real work uses, which is why a probe and a genuine failure cannot
    # disagree.
    from services.ai_models.capabilities import load_probes

    leases: list[str] = []

    @contextmanager
    def recording_lease(**kwargs):
        leases.append(str(kwargs.get("source")))
        yield

    monkeypatch.setattr(load_probes, "local_gpu_lease", recording_lease)

    jobs = RuntimeCapabilityProbeJobs(_probe_manager(tmp_path))
    try:
        submitted = await jobs.submit(FAKE_ID)
        terminal = await _terminal_snapshot(jobs, FAKE_ID, submitted.identity.job_id)
    finally:
        await jobs.shutdown()

    assert terminal.status == "succeeded"
    assert terminal.result == {
        "capabilityId": FAKE_ID,
        "loaded": True,
        "details": {"resolvedDevice": "cpu"},
    }
    assert leases == [f"runtime-probe:{FAKE_ID}"]

    payload = capabilities_payload()
    fake = next(
        capability
        for capability in payload["capabilities"]
        if capability["id"] == FAKE_ID
    )
    assert fake["verifiedThrough"] == "loaded"


@pytest.mark.parametrize("fake_capability", ["wrong-shape"], indirect=True)
def test_a_loader_that_returns_the_wrong_shape_is_recorded(
    fake_capability: CapabilityDescriptor,
) -> None:
    # Returning the wrong type is the mistake a newly written loader is most
    # likely to make, and it is a failure to load like any other: it must not
    # escape past the recorded boundary leaving ``lastFailure`` empty.
    with pytest.raises(TypeError):
        lazy_runtime(FAKE_ID).get()

    recorded = failures.get_last_failure(FAKE_ID)
    assert recorded is not None
    assert recorded.code is FailureCode.RUNTIME_LOAD_FAILED
    assert recorded.stage is VerificationStage.LOADED
    assert get_capability(FAKE_ID).last_failure is not None


def test_no_service_wraps_its_own_load_boundary() -> None:
    # The guarantee is that this is impossible to get wrong by omission, which
    # only holds while nobody has quietly re-added the hand-rolled version.
    backend = Path(__file__).resolve().parents[1]
    services = (
        backend / "services" / "sam2" / "sam2_service.py",
        backend / "services" / "sam_audio" / "sam_audio_service.py",
        backend / "services" / "beats" / "beats_service.py",
    )

    for path in services:
        source = path.read_text(encoding="utf-8")
        assert "record_load_failures" not in source, path.name
        assert "note_capability_success" not in source, path.name
