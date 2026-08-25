"""Explicit runtime load jobs and the evidence they publish."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager, nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

from services.ai_models.capabilities import failures
from services.ai_models.capabilities.contract import (
    Capability,
    CapabilityState,
    Check,
    CheckStatus,
    DeviceReport,
    VerificationStage,
    utc_now,
)
from services.ai_models.capabilities.load_probes import (
    PROBE_JOB_OWNER,
    PROBE_JOB_OWNER_VERSION,
    PROBE_JOB_TYPE,
    CapabilityProbeNotReadyError,
    RuntimeCapabilityProbeJobs,
    _run_probe_job,
)
from services.ai_models.capabilities.observations import (
    clear_runtime_observations,
    set_capability_checking,
)
from services.ai_models.capabilities.providers.base import (
    CapabilityProvider,
    ProviderReport,
    devices_equivalent,
)
from services.jobs import BackendJobDefinition, BackendJobManager, JobArtifactStore
from services.model_work.leases import LeaseTimeoutError


class _FakeLoadProvider:
    id = "fake-runtime"
    label = "Fake runtime"
    uses_local_gpu = True

    def __init__(self) -> None:
        self.calls = 0

    def load_runtime(self, report_progress=None):
        self.calls += 1
        if report_progress is not None:
            report_progress(0.5, "Loading fake runtime")
        return {"resolvedDevice": "cuda"}


def _manager(tmp_path: Path) -> BackendJobManager:
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


async def _terminal(
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


@pytest.fixture(autouse=True)
def _clear_runtime_state():
    failures.clear_failures()
    clear_runtime_observations()
    yield
    failures.clear_failures()
    clear_runtime_observations()


@pytest.mark.asyncio
async def test_probe_jobs_are_single_flight_and_publish_success(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from services.ai_models.capabilities import load_probes

    provider = _FakeLoadProvider()
    monkeypatch.setattr(
        load_probes,
        "get_provider",
        lambda capability_id: provider if capability_id == provider.id else None,
    )
    monkeypatch.setattr(
        load_probes,
        "get_capability",
        lambda capability_id, deep_probe=False: SimpleNamespace(
            can_attempt=True,
            checks=(),
        ),
    )
    monkeypatch.setattr(load_probes, "local_gpu_lease", lambda **kwargs: nullcontext())

    manager = _manager(tmp_path)
    jobs = RuntimeCapabilityProbeJobs(manager)
    try:
        first, second = await asyncio.gather(
            jobs.submit(provider.id),
            jobs.submit(provider.id),
        )
        assert first.identity.job_id == second.identity.job_id

        terminal = await _terminal(jobs, provider.id, first.identity.job_id)
        assert terminal.status == "succeeded"
        assert provider.calls == 1
        assert terminal.result == {
            "capabilityId": provider.id,
            "loaded": True,
            "details": {"resolvedDevice": "cuda"},
        }
    finally:
        await jobs.shutdown()


@pytest.mark.asyncio
async def test_probe_job_classifies_and_records_a_load_failure(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from services.ai_models.capabilities import load_probes

    provider = _FakeLoadProvider()

    def fail_load(report_progress=None):
        del report_progress
        raise ModuleNotFoundError("No module named 'fake_runtime'", name="fake_runtime")

    provider.load_runtime = fail_load  # type: ignore[method-assign]
    monkeypatch.setattr(load_probes, "get_provider", lambda capability_id: provider)
    monkeypatch.setattr(
        load_probes,
        "get_capability",
        lambda capability_id, deep_probe=False: SimpleNamespace(
            can_attempt=True,
            checks=(),
        ),
    )
    monkeypatch.setattr(load_probes, "local_gpu_lease", lambda **kwargs: nullcontext())

    manager = _manager(tmp_path)
    jobs = RuntimeCapabilityProbeJobs(manager)
    try:
        submitted = await jobs.submit(provider.id)
        terminal = await _terminal(jobs, provider.id, submitted.identity.job_id)
        recorded = failures.get_last_failure(provider.id)

        assert terminal.status == "failed"
        assert terminal.error == "The fake_runtime package is not installed: No module named 'fake_runtime'"
        assert recorded is not None
        assert recorded.code.value == "package_missing"
        assert recorded.stage is VerificationStage.LOADED
    finally:
        await jobs.shutdown()


@pytest.mark.asyncio
async def test_probe_preserves_a_failure_recorded_at_the_real_load_boundary(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from services.ai_models.capabilities import load_probes

    provider = _FakeLoadProvider()

    def fail_load(report_progress=None):
        del report_progress
        try:
            with failures.record_load_failures(provider.id):
                raise ModuleNotFoundError(
                    "No module named 'fake_runtime' while trying cuda then cpu",
                    name="fake_runtime",
                )
        except ModuleNotFoundError:
            # Mirrors SAM-Audio's classified wrapper, whose string is only the
            # summary while the registry already has the richer cause detail.
            raise RuntimeError("The fake_runtime package is not installed") from None

    provider.load_runtime = fail_load  # type: ignore[method-assign]
    monkeypatch.setattr(load_probes, "get_provider", lambda capability_id: provider)
    monkeypatch.setattr(
        load_probes,
        "get_capability",
        lambda capability_id, deep_probe=False: SimpleNamespace(
            can_attempt=True,
            checks=(),
        ),
    )
    monkeypatch.setattr(load_probes, "local_gpu_lease", lambda **kwargs: nullcontext())

    manager = _manager(tmp_path)
    jobs = RuntimeCapabilityProbeJobs(manager)
    try:
        submitted = await jobs.submit(provider.id)
        terminal = await _terminal(jobs, provider.id, submitted.identity.job_id)
        recorded = failures.get_last_failure(provider.id)

        assert terminal.status == "failed"
        assert recorded is not None
        assert recorded.detail == (
            "No module named 'fake_runtime' while trying cuda then cpu"
        )
        assert terminal.error == (
            "The fake_runtime package is not installed: "
            "No module named 'fake_runtime' while trying cuda then cpu"
        )
    finally:
        await jobs.shutdown()


@pytest.mark.asyncio
async def test_gpu_lease_contention_fails_only_the_probe_job(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from services.ai_models.capabilities import load_probes

    provider = _FakeLoadProvider()
    monkeypatch.setattr(load_probes, "get_provider", lambda capability_id: provider)
    monkeypatch.setattr(
        load_probes,
        "get_capability",
        lambda capability_id, deep_probe=False: SimpleNamespace(
            can_attempt=True,
            checks=(),
        ),
    )

    @contextmanager
    def busy_gpu(**kwargs):
        del kwargs
        raise LeaseTimeoutError("Timed out waiting for the local GPU")
        yield  # pragma: no cover - makes this a context manager

    monkeypatch.setattr(load_probes, "local_gpu_lease", busy_gpu)

    manager = _manager(tmp_path)
    jobs = RuntimeCapabilityProbeJobs(manager)
    try:
        submitted = await jobs.submit(provider.id)
        terminal = await _terminal(jobs, provider.id, submitted.identity.job_id)

        assert terminal.status == "failed"
        assert terminal.error == "Timed out waiting for the local GPU"
        assert failures.get_last_failure(provider.id) is None
        assert provider.calls == 0
    finally:
        await jobs.shutdown()


@pytest.mark.asyncio
async def test_cancelling_one_submitter_does_not_cancel_the_shared_submission(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from services.ai_models.capabilities import load_probes

    provider = _FakeLoadProvider()
    monkeypatch.setattr(load_probes, "get_provider", lambda capability_id: provider)
    monkeypatch.setattr(
        load_probes,
        "get_capability",
        lambda capability_id, deep_probe=False: SimpleNamespace(
            can_attempt=True,
            checks=(),
        ),
    )

    jobs = RuntimeCapabilityProbeJobs(SimpleNamespace())  # type: ignore[arg-type]
    release = asyncio.Event()
    expected = SimpleNamespace(identity=SimpleNamespace(job_id="shared-job"))

    async def slow_submission(capability_id: str):
        assert capability_id == provider.id
        await release.wait()
        return expected

    monkeypatch.setattr(jobs, "_submit_new", slow_submission)
    disconnected = asyncio.create_task(jobs.submit(provider.id))
    connected = asyncio.create_task(jobs.submit(provider.id))
    await asyncio.sleep(0)

    disconnected.cancel()
    with pytest.raises(asyncio.CancelledError):
        await disconnected
    release.set()

    assert await connected is expected


@pytest.mark.asyncio
async def test_known_blocked_capability_is_not_queued(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from services.ai_models.capabilities import load_probes

    provider = _FakeLoadProvider()
    monkeypatch.setattr(load_probes, "get_provider", lambda capability_id: provider)
    monkeypatch.setattr(
        load_probes,
        "get_capability",
        lambda capability_id, deep_probe=False: SimpleNamespace(
            can_attempt=False,
            checks=(
                Check(
                    id="package.fake",
                    status=CheckStatus.FAIL,
                    code=None,
                    summary="The fake package is missing",
                ),
            ),
        ),
    )

    manager = _manager(tmp_path)
    jobs = RuntimeCapabilityProbeJobs(manager)
    try:
        with pytest.raises(
            CapabilityProbeNotReadyError,
            match="fake package is missing",
        ):
            await jobs.submit(provider.id)
        assert manager.list_jobs(PROBE_JOB_OWNER) == ()
    finally:
        await jobs.shutdown()


def test_successful_load_is_reported_as_loaded_and_proves_the_device() -> None:
    class Provider(CapabilityProvider):
        id = "observed-runtime"
        label = "Observed runtime"

        def inspect(self, *, deep_probe: bool = True) -> ProviderReport:
            del deep_probe
            return ProviderReport(
                expected=True,
                checks=(
                    Check(
                        id="model.default",
                        status=CheckStatus.PASS,
                        stage=VerificationStage.DISCOVERED,
                        summary="Model found",
                    ),
                    Check(
                        id="package.runtime",
                        status=CheckStatus.PASS,
                        stage=VerificationStage.ENVIRONMENT,
                        summary="Package imports",
                    ),
                ),
                device=DeviceReport(requested="auto", resolved="cpu"),
            )

    failures.note_capability_success(
        "observed-runtime",
        resolved_device="cuda",
        detail="Explicit load test passed",
    )

    capability = Provider().build()

    assert capability.state is CapabilityState.READY
    assert capability.verified_through is VerificationStage.LOADED
    assert capability.device == DeviceReport(
        requested="auto",
        resolved="cuda",
        proven=True,
        fallback=False,
    )
    assert capability.last_successful_load is not None
    assert capability.checks[-1].id == "runtime.loaded"


def test_checking_remains_attemptable() -> None:
    class Provider(CapabilityProvider):
        id = "checking-runtime"
        label = "Checking runtime"

        def inspect(self, *, deep_probe: bool = True) -> ProviderReport:
            del deep_probe
            return ProviderReport(
                expected=True,
                checks=(
                    Check(
                        id="model.default",
                        status=CheckStatus.PASS,
                        stage=VerificationStage.DISCOVERED,
                        summary="Model found",
                    ),
                ),
            )

    set_capability_checking("checking-runtime", True)
    capability = Provider().build()

    assert capability.state is CapabilityState.CHECKING
    assert capability.can_attempt is True


def test_legacy_health_keeps_a_checking_capability_available(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from services.ai_models import health

    capability = Capability(
        id="checking-runtime",
        label="Checking runtime",
        state=CapabilityState.CHECKING,
        checked_at=utc_now(),
    )
    monkeypatch.setattr(health, "get_capability", lambda *args, **kwargs: capability)

    assert health.capability_runtime_health("checking-runtime") == {
        "ready": True,
        "state": "checking",
        "verifiedThrough": None,
        "error": None,
        "code": None,
    }
    assert health.AppStatusProvider(
        response_key="checking_runtime",
        capability_id="checking-runtime",
        unavailable_message="Unavailable",
    ).to_app_status() == {
        "status": "available",
        "error": None,
        "state": "checking",
        "verifiedThrough": None,
    }


def test_cuda_zero_resolution_does_not_degrade_a_successful_load() -> None:
    class Provider(CapabilityProvider):
        id = "cuda-zero-runtime"
        label = "CUDA zero runtime"

        def inspect(self, *, deep_probe: bool = True) -> ProviderReport:
            del deep_probe
            return ProviderReport(
                expected=True,
                checks=(
                    Check(
                        id="model.default",
                        status=CheckStatus.PASS,
                        stage=VerificationStage.DISCOVERED,
                        summary="Model found",
                    ),
                    Check(
                        id="device.requested",
                        status=CheckStatus.PASS,
                        stage=VerificationStage.ENVIRONMENT,
                        summary="CUDA is available",
                    ),
                ),
                device=DeviceReport(requested="cuda:0", resolved="cuda:0"),
            )

    failures.note_capability_success(
        "cuda-zero-runtime",
        resolved_device="cuda",
    )

    capability = Provider().build()

    assert capability.state is CapabilityState.READY
    assert capability.device is not None
    assert capability.device.fallback is False


@pytest.mark.parametrize(
    ("requested", "resolved", "equivalent"),
    [
        ("cuda", "cuda:0", True),
        ("cuda:0", "cuda", True),
        ("CUDA:0", "cuda", True),
        ("cuda:1", "cuda", False),
        ("cuda", "cpu", False),
    ],
)
def test_torch_device_equivalence(
    requested: str,
    resolved: str,
    equivalent: bool,
) -> None:
    assert devices_equivalent(requested, resolved) is equivalent
