"""Cheap-stage runtime-capability reporting.

The governing case these tests exist for: a SAM-Audio checkpoint sits on disk
while the ``sam_audio`` package is not installed. Nothing may report
"available", the failure must carry ``package_missing``, and the remediation
must target the backend venv through ``uv pip`` rather than offer a model
re-download that could not possibly fix it.
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from services.ai_models.capabilities import (
    CapabilityState,
    CheckStatus,
    FailureCode,
    VerificationStage,
    capabilities_payload,
    derive_state,
    get_capability,
    list_capabilities,
    list_capability_ids,
)
from services.ai_models.capabilities import failures, probes, subprocess_probe
from services.ai_models.capabilities.contract import Check, RemediationKind
from services.ai_models.capabilities.probes import (
    device_check,
    package_check,
    python_version_check,
)
from services.ai_models.capabilities.subprocess_probe import (
    DeviceProbe,
    ModuleProbe,
    ProbeModule,
    ProbeResult,
    ProbeSpec,
    invalidate_probe_cache,
    probe_environment,
    run_probe,
)


SAM_AUDIO_MODEL = "sam-audio-large-tv"


@dataclass
class _FakePackage:
    installed: bool = True
    importable: bool = True
    version: str | None = "1.0.0"
    error: str | None = None
    missing_module: str | None = None


@dataclass
class _FakeEnvironment:
    """Declarative stand-in for "what is installed on this machine".

    Both halves of the real signal are faked together — ``find_spec`` presence
    and the out-of-process import — because a capability's state is exactly the
    disagreement between them.
    """

    packages: dict[str, _FakePackage] = field(default_factory=dict)
    device: DeviceProbe = field(
        default_factory=lambda: DeviceProbe(torch_version="2.4.0")
    )
    probe_calls: list[ProbeSpec] = field(default_factory=list)

    def set_package(self, name: str, **kwargs: object) -> None:
        self.packages[name] = _FakePackage(**kwargs)  # type: ignore[arg-type]

    def entry(self, name: str) -> _FakePackage:
        if name in self.packages:
            return self.packages[name]
        top_level = name.split(".")[0]
        return self.packages.get(top_level, _FakePackage())


@pytest.fixture
def fake_environment(monkeypatch: pytest.MonkeyPatch) -> _FakeEnvironment:
    environment = _FakeEnvironment()

    def fake_find_package(module: str, *, distribution=None, extra_paths=()):
        del distribution, extra_paths
        entry = environment.entry(module)
        return probes.PackagePresence(
            found=entry.installed,
            origin=f"/fake/{module}/__init__.py" if entry.installed else None,
            version=entry.version if entry.installed else None,
        )

    def fake_run_probe(spec: ProbeSpec, *, timeout: float = 0.0) -> ProbeResult:
        del timeout
        environment.probe_calls.append(spec)
        modules = {}
        for module in spec.modules:
            entry = environment.entry(module.name)
            modules[module.name] = ModuleProbe(
                name=module.name,
                imported=entry.installed and entry.importable,
                version=entry.version,
                error=entry.error,
                missing_module=entry.missing_module,
            )
        return ProbeResult(
            ok=True,
            python={"version": "3.11.9"},
            modules=modules,
            device=environment.device if spec.device else None,
        )

    monkeypatch.setattr(probes, "find_package", fake_find_package)
    monkeypatch.setattr(subprocess_probe, "run_probe", fake_run_probe)
    invalidate_probe_cache()
    yield environment
    invalidate_probe_cache()


@pytest.fixture
def capability_dirs(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, Path]:
    """Point every configured model/cache directory at a temporary one."""

    import config
    from services.sam2 import sam2_discovery

    directories = {
        "sam2_models": tmp_path / "sam2-models",
        "sam2_cache": tmp_path / "sam2-cache",
        "sam_audio_models": tmp_path / "sam-audio-models",
        "sam_audio_cache": tmp_path / "sam-audio-cache",
        "beats_cache": tmp_path / "beats-cache",
    }
    for path in directories.values():
        path.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(config, "SAM2_SEARCH_PATHS", [directories["sam2_models"]])
    # ``sam2_discovery`` binds the search paths at import time, so patching the
    # config module alone would not reach it.
    monkeypatch.setattr(
        sam2_discovery, "SAM2_SEARCH_PATHS", [directories["sam2_models"]]
    )
    monkeypatch.setattr(config, "SAM2_CACHE_DIR", directories["sam2_cache"])
    monkeypatch.setattr(
        config, "SAM_AUDIO_SEARCH_PATHS", [directories["sam_audio_models"]]
    )
    monkeypatch.setattr(config, "SAM_AUDIO_MODEL_DIR", directories["sam_audio_models"])
    monkeypatch.setattr(config, "SAM_AUDIO_CACHE_DIR", directories["sam_audio_cache"])
    monkeypatch.setattr(config, "SAM_AUDIO_DEFAULT_MODEL", SAM_AUDIO_MODEL)
    monkeypatch.setattr(config, "BEATTHIS_CACHE_DIR", directories["beats_cache"])
    return directories


def _write_sam_audio_model(
    models_dir: Path,
    *,
    name: str = SAM_AUDIO_MODEL,
    files: tuple[str, ...] = ("config.json", "checkpoint.pt"),
) -> Path:
    model_dir = models_dir / name
    model_dir.mkdir(parents=True, exist_ok=True)
    for filename in files:
        (model_dir / filename).write_text("{}")
    return model_dir


def _check(capability, check_id: str) -> Check:
    for check in capability.checks:
        if check.id == check_id:
            return check
    raise AssertionError(f"no check {check_id!r} in {[c.id for c in capability.checks]}")


# --------------------------------------------------------------------------
# The governing case
# --------------------------------------------------------------------------


def test_checkpoint_present_without_package_is_blocked(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    _write_sam_audio_model(capability_dirs["sam_audio_models"])
    fake_environment.set_package("sam_audio", installed=False, importable=False)

    capability = get_capability("sam-audio")

    assert capability is not None
    assert capability.state is CapabilityState.BLOCKED
    assert capability.can_attempt is False
    assert capability.verified_through is VerificationStage.DISCOVERED

    model = _check(capability, "model.default")
    assert model.status is CheckStatus.PASS

    package = _check(capability, "package.sam_audio")
    assert package.status is CheckStatus.FAIL
    assert package.code is FailureCode.PACKAGE_MISSING
    assert package.remediation is not None
    assert package.remediation.kind is RemediationKind.COMMAND
    assert package.remediation.requires_restart is True
    assert package.remediation.command == (
        "uv pip install --python backend/.venv/bin/python "
        "-r backend/requirements-sam-audio.txt"
    )


def test_blocked_capability_never_reports_available(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    _write_sam_audio_model(capability_dirs["sam_audio_models"])
    fake_environment.set_package("sam_audio", installed=False, importable=False)

    payload = get_capability("sam-audio").to_json()

    assert payload["state"] == "blocked"
    assert payload["canAttempt"] is False
    assert "available" not in json.dumps(payload["state"])
    # The only remediation offered for the failing check must not be a download.
    failing = [check for check in payload["checks"] if check["status"] == "fail"]
    assert [check["code"] for check in failing] == ["package_missing"]
    assert failing[0]["remediation"]["kind"] == "command"


def test_no_model_and_no_package_is_unavailable_not_blocked(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    fake_environment.set_package("sam_audio", installed=False, importable=False)

    capability = get_capability("sam-audio")

    assert capability.state is CapabilityState.UNAVAILABLE
    assert capability.can_attempt is False
    assert capability.verified_through is None


def test_package_and_model_present_is_available_unverified(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    _write_sam_audio_model(capability_dirs["sam_audio_models"])

    capability = get_capability("sam-audio")

    assert capability.state is CapabilityState.AVAILABLE_UNVERIFIED
    assert capability.can_attempt is True
    # Nothing has been loaded, so the claim stops at the environment stage.
    assert capability.verified_through is VerificationStage.ENVIRONMENT


def test_installed_but_broken_package_is_blocked_even_without_a_model(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    fake_environment.set_package(
        "sam_audio",
        installed=True,
        importable=False,
        error="undefined symbol: broken_dependency",
    )

    capability = get_capability("sam-audio")

    assert capability.state is CapabilityState.BLOCKED
    assert _check(capability, "package.sam_audio").code is (
        FailureCode.PACKAGE_IMPORT_FAILED
    )


# --------------------------------------------------------------------------
# One case per failure code
# --------------------------------------------------------------------------


def test_checkpoint_without_config_is_model_invalid(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    _write_sam_audio_model(
        capability_dirs["sam_audio_models"], files=("checkpoint.pt",)
    )

    capability = get_capability("sam-audio")
    model = _check(capability, "model.default")

    assert model.status is CheckStatus.FAIL
    assert model.code is FailureCode.MODEL_INVALID
    assert "config.json" in model.summary
    assert capability.state is CapabilityState.BLOCKED


def test_installed_but_unimportable_package_is_import_failed(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    _write_sam_audio_model(capability_dirs["sam_audio_models"])
    fake_environment.set_package(
        "sam_audio",
        installed=True,
        importable=False,
        error="libcudart.so.12: cannot open shared object file",
        missing_module=None,
    )

    package = _check(get_capability("sam-audio"), "package.sam_audio")

    assert package.status is CheckStatus.FAIL
    assert package.code is FailureCode.PACKAGE_IMPORT_FAILED
    assert "libcudart" in package.detail


def test_import_failure_names_the_missing_dependency(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    _write_sam_audio_model(capability_dirs["sam_audio_models"])
    fake_environment.set_package(
        "sam_audio", installed=True, importable=False, missing_module="dacvae"
    )

    package = _check(get_capability("sam-audio"), "package.sam_audio")

    assert package.code is FailureCode.PACKAGE_IMPORT_FAILED
    assert "dacvae" in package.summary


def test_outdated_dependency_is_incompatible(fake_environment: _FakeEnvironment) -> None:
    fake_environment.set_package("torch", version="1.13.1")

    check = package_check(
        check_id="package.torch",
        module="torch",
        label="Torch",
        minimum_version="2.0.0",
        deep=ModuleProbe(name="torch", imported=True, version="1.13.1"),
    )

    assert check.status is CheckStatus.FAIL
    assert check.code is FailureCode.DEPENDENCY_INCOMPATIBLE


def test_unwritable_cache_directory_blocks_the_capability(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    if os.geteuid() == 0:
        pytest.skip("root ignores directory permissions")

    _write_sam_audio_model(capability_dirs["sam_audio_models"])
    cache_dir = capability_dirs["sam_audio_cache"]
    cache_dir.chmod(0o500)
    try:
        capability = get_capability("sam-audio")
    finally:
        cache_dir.chmod(0o700)

    cache = _check(capability, "cache.directory")
    assert cache.status is CheckStatus.FAIL
    assert cache.code is FailureCode.CACHE_UNWRITABLE
    assert capability.state is CapabilityState.BLOCKED


def test_unsupported_python_version_is_reported() -> None:
    check = python_version_check((99, 0))

    assert check.status is CheckStatus.FAIL
    assert check.code is FailureCode.PYTHON_VERSION_UNSUPPORTED


def test_explicit_cuda_without_cuda_is_device_unavailable() -> None:
    check, report = device_check(
        check_id="device.requested",
        requested="cuda",
        probe=DeviceProbe(torch_version="2.4.0", cuda_available=False),
        env_var="SAM2_DEVICE",
        label="SAM2",
    )

    assert check.status is CheckStatus.FAIL
    assert check.code is FailureCode.DEVICE_UNAVAILABLE
    assert check.remediation.kind is RemediationKind.SETTINGS
    assert report.resolved is None


def test_cpu_fallback_reports_degraded_rather_than_blocked() -> None:
    check, report = device_check(
        check_id="device.requested",
        requested="cuda",
        probe=DeviceProbe(torch_version="2.4.0", cuda_available=False),
        env_var="SAM2_DEVICE",
        label="SAM2",
        cpu_fallback=True,
    )

    assert check.status is CheckStatus.WARN
    assert report.fallback is True
    assert report.resolved == "cpu"
    assert (
        derive_state(expected=True, checks=[check], degraded=report.fallback)
        is CapabilityState.DEGRADED
    )


def test_auto_device_resolves_without_claiming_proof() -> None:
    check, report = device_check(
        check_id="device.requested",
        requested="auto",
        probe=DeviceProbe(torch_version="2.4.0", cuda_available=True),
        env_var="SAM2_DEVICE",
        label="SAM2",
    )

    assert check.status is CheckStatus.PASS
    assert report.resolved == "cuda"
    assert report.proven is False


def test_invalid_comfyui_url_is_config_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from services.comfyui import comfyui_client

    monkeypatch.setattr(comfyui_client, "_comfyui_url", "file:///tmp/comfyui")

    capability = get_capability("comfyui")
    config_check = _check(capability, "config.url")

    assert capability.state is CapabilityState.BLOCKED
    assert config_check.code is FailureCode.CONFIG_MISSING


# --------------------------------------------------------------------------
# The registry as a whole
# --------------------------------------------------------------------------


def test_every_capability_serialises(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    payload = capabilities_payload()

    ids = [capability["id"] for capability in payload["capabilities"]]
    assert ids == list(list_capability_ids())
    assert json.loads(json.dumps(payload)) == payload
    assert payload["environment"]["python"]["version"]

    for capability in payload["capabilities"]:
        assert set(capability) >= {
            "id",
            "label",
            "state",
            "canAttempt",
            "verifiedThrough",
            "checkedAt",
            "checks",
            "lastFailure",
        }
        assert capability["canAttempt"] is (
            capability["state"] in {"available_unverified", "ready", "degraded"}
        )


def test_listing_capabilities_imports_no_optional_ml_package(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    optional = ("sam2", "sam_audio", "beat_this", "madmom", "torch")
    already_imported = {name for name in optional if name in sys.modules}

    list_capabilities()

    newly_imported = {
        name for name in optional if name in sys.modules
    } - already_imported
    assert newly_imported == set()


def test_sam2_discovery_finds_packaged_configs_without_importing_sam2(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from services.sam2 import sam2_discovery

    python_root = tmp_path / "python-root"
    package_root = python_root / "sam2"
    config_dir = package_root / "configs"
    config_dir.mkdir(parents=True)
    (package_root / "__init__.py").write_text(
        "raise RuntimeError('sam2 was imported in-process')\n"
    )
    expected_config = config_dir / "sam2_hiera_l.yaml"
    expected_config.write_text("model: test\n")

    model_dir = tmp_path / "models"
    model_dir.mkdir()
    (model_dir / "sam2_hiera_large.pt").write_bytes(b"checkpoint")

    monkeypatch.syspath_prepend(str(python_root))
    monkeypatch.delitem(sys.modules, "sam2", raising=False)
    monkeypatch.setattr(sam2_discovery, "SAM2_SEARCH_PATHS", [model_dir])

    models = sam2_discovery.discover_sam2_models()

    assert models[0]["config_path"] == str(expected_config)
    assert "sam2" not in sys.modules


def test_beat_this_probe_targets_the_module_used_to_build_the_predictor(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    get_capability("beat-this")

    beat_probe = next(
        spec
        for spec in fake_environment.probe_calls
        if any(module.name.startswith("beat_this") for module in spec.modules)
    )
    assert [module.name for module in beat_probe.modules] == [
        "beat_this.inference",
        "madmom",
    ]


def test_each_probe_runs_once_per_listing(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    # Three capabilities probe their own package and all four share one
    # torch/device probe. A refresh must re-run that set once — not once per
    # capability that happens to ask for it.
    fake_environment.probe_calls.clear()

    list_capabilities()
    assert len(fake_environment.probe_calls) == 4

    list_capabilities()
    assert len(fake_environment.probe_calls) == 4

    list_capabilities(refresh=True)
    assert len(fake_environment.probe_calls) == 8


def test_environment_snapshot_never_returns_a_token(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HF_TOKEN", "hf_thisisasecrettokenvalue1234")

    environment = capabilities_payload()["environment"]

    assert environment["huggingFace"]["tokenPresent"] is True
    assert "hf_thisisasecrettokenvalue1234" not in json.dumps(environment)


def test_unknown_capability_is_none(fake_environment: _FakeEnvironment) -> None:
    assert get_capability("not-a-capability") is None


# --------------------------------------------------------------------------
# The out-of-process probe
# --------------------------------------------------------------------------


def test_subprocess_probe_reports_missing_and_present_modules() -> None:
    result = run_probe(
        ProbeSpec(
            modules=(
                ProbeModule("json"),
                ProbeModule("vlo_definitely_not_installed"),
            )
        ),
        timeout=60.0,
    )

    assert result.ok is True
    assert result.module("json").imported is True
    missing = result.module("vlo_definitely_not_installed")
    assert missing.imported is False
    assert missing.missing_module == "vlo_definitely_not_installed"
    assert result.python["executable"] == sys.executable


def test_subprocess_probe_honours_its_timeout(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # A real hang, not a simulated one: an optional ML import can wedge, and
    # the probe's whole reason to be out-of-process is that we can kill it.
    hanging_worker = tmp_path / "hanging_worker.py"
    hanging_worker.write_text("import time\ntime.sleep(30)\n")
    monkeypatch.setattr(subprocess_probe, "_WORKER_PATH", hanging_worker)

    started = time.monotonic()
    result = run_probe(ProbeSpec(modules=(ProbeModule("json"),)), timeout=0.5)
    elapsed = time.monotonic() - started

    assert result.ok is False
    assert result.timed_out is True
    assert "timed out" in result.error
    assert elapsed < 10
    assert result.module("json").imported is False


def test_probe_results_are_cached_until_invalidated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[ProbeSpec] = []

    def counting_run_probe(spec: ProbeSpec, *, timeout: float = 0.0) -> ProbeResult:
        del timeout
        calls.append(spec)
        return ProbeResult(ok=True)

    monkeypatch.setattr(subprocess_probe, "run_probe", counting_run_probe)
    invalidate_probe_cache()
    spec = ProbeSpec(modules=(ProbeModule("json"),))
    try:
        probe_environment("test-capability", spec)
        probe_environment("test-capability", spec)
        assert len(calls) == 1

        probe_environment("test-capability", spec, refresh=True)
        assert len(calls) == 2
    finally:
        invalidate_probe_cache()


def test_probe_imports_from_the_extra_search_paths(tmp_path: Path) -> None:
    # The services put a sibling checkout on sys.path before importing; a probe
    # that skipped those paths would call a working install missing.
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    (checkout / "vlo_probe_fixture.py").write_text("VALUE = 1\n")

    result = run_probe(
        ProbeSpec(
            modules=(ProbeModule("vlo_probe_fixture"),),
            extra_sys_path=(str(checkout),),
        ),
        timeout=60.0,
    )

    assert result.module("vlo_probe_fixture").imported is True


def test_probe_blames_a_missing_dependency_only_for_import_errors(
    tmp_path: Path,
) -> None:
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    # AttributeError also carries a ``name`` attribute, which is not a module.
    (checkout / "vlo_broken_fixture.py").write_text(
        "raise AttributeError('no attribute', name='endswith')\n"
    )

    module = run_probe(
        ProbeSpec(
            modules=(ProbeModule("vlo_broken_fixture"),),
            extra_sys_path=(str(checkout),),
        ),
        timeout=60.0,
    ).module("vlo_broken_fixture")

    assert module.imported is False
    assert module.error_type == "AttributeError"
    assert module.missing_module is None


def test_stub_modules_leave_dunder_attributes_alone() -> None:
    from services.ai_models.capabilities import probe_worker

    # Stubs stand in for the accelerator shims the real load path fakes. They
    # must answer ordinary attributes and refuse dunders: torch introspects
    # sys.modules while registering fake ops, and a dummy ``__file__`` sends
    # inspect down a path that raises.
    stub = probe_worker._stub_module("vlo_fake_shim")

    assert stub.AnythingAtAll is not None
    for dunder in ("__file__", "__all__", "__wrapped__"):
        with pytest.raises(AttributeError):
            getattr(stub, dunder)


def test_a_probe_that_never_ran_is_not_treated_as_success() -> None:
    result = ProbeResult(ok=False, error="boom")

    module = result.module("sam_audio")

    assert module.imported is False
    assert module.error == "boom"


# --------------------------------------------------------------------------
# Failure classification and sanitisation
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("exception", "code"),
    [
        (ModuleNotFoundError("No module named 'sam_audio'", name="sam_audio"),
         FailureCode.PACKAGE_MISSING),
        (ImportError("cannot import name SAMAudio"), FailureCode.PACKAGE_IMPORT_FAILED),
        (RuntimeError("CUDA out of memory"), FailureCode.OUT_OF_MEMORY),
        (PermissionError("Permission denied"), FailureCode.CACHE_UNWRITABLE),
        (FileNotFoundError("checkpoint.pt"), FailureCode.MODEL_MISSING),
        (RuntimeError("401 Unauthorized"), FailureCode.AUTHENTICATION_REQUIRED),
        (
            RuntimeError("SAM2_DEVICE was set to cuda, but torch.cuda.is_available() is false"),
            FailureCode.DEVICE_UNAVAILABLE,
        ),
        (
            RuntimeError("Connection timed out while downloading a dependency"),
            FailureCode.DEPENDENCY_DOWNLOAD_FAILED,
        ),
        (RuntimeError("something nobody predicted"), FailureCode.RUNTIME_LOAD_FAILED),
    ],
)
def test_classification_is_total(exception: Exception, code: FailureCode) -> None:
    assert failures.classify_exception(exception).code is code


def test_classification_unwraps_the_cause() -> None:
    try:
        try:
            raise ModuleNotFoundError("No module named 'dacvae'", name="dacvae")
        except ModuleNotFoundError as cause:
            raise RuntimeError("Failed to initialize SAM-Audio runtime") from cause
    except RuntimeError as exc:
        classified = failures.classify_exception(exc)

    assert classified.code is FailureCode.PACKAGE_MISSING
    assert "dacvae" in classified.summary


def test_sanitisation_redacts_home_and_tokens_but_keeps_project_paths() -> None:
    project_file = str(Path(__file__).resolve())
    message = (
        f"failed loading {project_file} for user {Path.home()}/models "
        "with token=hf_supersecretvalue0123456789"
    )

    cleaned = failures.sanitize_message(message)

    assert "<project>" in cleaned
    assert str(Path.home()) not in cleaned
    assert "hf_supersecretvalue0123456789" not in cleaned
    assert "token=[redacted]" in cleaned


def test_url_sanitisation_redacts_credentials_and_signed_query_values() -> None:
    cleaned = failures.sanitize_url(
        "https://alice:secret@example.test:8188/api?token=abc123&mode=local"
        "#private-fragment"
    )

    assert "alice" not in cleaned
    assert "secret" not in cleaned
    assert "abc123" not in cleaned
    assert "private-fragment" not in cleaned
    assert "example.test:8188/api" in cleaned
    assert "mode=local" in cleaned


def test_device_probe_errors_are_sanitised_before_becoming_checks() -> None:
    check, _report = device_check(
        check_id="device.requested",
        requested="auto",
        probe=DeviceProbe(error="failed with token=hf_supersecretvalue0123456789"),
        env_var="SAM2_DEVICE",
        label="SAM2",
    )

    assert check.status is CheckStatus.WARN
    assert "hf_supersecretvalue0123456789" not in (check.detail or "")
    assert "token=[redacted]" in (check.detail or "")


def test_recorded_failures_surface_on_the_capability(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    _write_sam_audio_model(capability_dirs["sam_audio_models"])
    failures.clear_failures()
    try:
        failures.record_exception(
            "sam-audio",
            RuntimeError("CUDA out of memory"),
            stage=VerificationStage.LOADED,
        )
        capability = get_capability("sam-audio")
    finally:
        failures.clear_failures()

    assert capability.last_failure is not None
    assert capability.last_failure.code is FailureCode.OUT_OF_MEMORY
    assert capability.to_json()["lastFailure"]["stage"] == "loaded"


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------


@pytest.mark.anyio
async def test_endpoint_returns_capabilities_and_environment(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    from routers import runtime_capabilities

    payload = await runtime_capabilities.get_runtime_capabilities(refresh=False)

    assert {capability["id"] for capability in payload["capabilities"]} == set(
        list_capability_ids()
    )
    assert "environment" in payload


@pytest.mark.anyio
async def test_endpoint_returns_one_capability(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
) -> None:
    _write_sam_audio_model(capability_dirs["sam_audio_models"])
    fake_environment.set_package("sam_audio", installed=False, importable=False)

    from routers import runtime_capabilities

    payload = await runtime_capabilities.get_runtime_capability(
        "sam-audio", refresh=False
    )

    assert payload["state"] == "blocked"
    assert payload["canAttempt"] is False


@pytest.mark.anyio
async def test_endpoint_404s_on_an_unknown_capability(
    fake_environment: _FakeEnvironment,
) -> None:
    from fastapi import HTTPException

    from routers import runtime_capabilities

    with pytest.raises(HTTPException) as raised:
        await runtime_capabilities.get_runtime_capability("nope", refresh=False)

    assert raised.value.status_code == 404
