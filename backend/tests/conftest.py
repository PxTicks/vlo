"""Shared backend test configuration.

``pythonpath = ["."]`` in ``pyproject.toml`` puts the backend root on ``sys.path``,
so test modules import ``services.*`` / ``routers.*`` / ``main`` directly. No
per-file ``sys.path`` manipulation is needed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import pytest

from services.ai_models.capabilities import probes, subprocess_probe
from services.ai_models.capabilities.subprocess_probe import (
    DeviceProbe,
    ModuleProbe,
    ProbeResult,
    ProbeSpec,
    invalidate_probe_cache,
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


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    """Run every ``@pytest.mark.anyio`` test on the asyncio backend."""
    return "asyncio"


@pytest.fixture(autouse=True)
def model_work_coordinator():
    """Give each test a fresh, ready model-work coordinator.

    Production starts the coordinator *not ready* and opens admission from the
    application lifespan once in-flight ComfyUI prompts have been restored. A
    test that calls a service directly never runs that lifespan, and a lease
    left held by one test would refuse admission in the next, so the singleton
    is rebuilt per test. Tests that need the not-ready gate construct their own
    ``ModelWorkCoordinator``.
    """
    from services import model_work

    coordinator = model_work.reset_model_work_coordinator()
    coordinator.mark_ready()
    yield coordinator
    model_work.reset_model_work_coordinator()


@pytest.fixture(autouse=True)
def uv_on_path(monkeypatch: pytest.MonkeyPatch):
    """Pin ``uv`` discovery so remediation is not a property of the host.

    ``install_remediation`` degrades to a docs link when it cannot find ``uv``,
    which is correct behaviour and wrong for a test suite: every assertion about
    the documented ``uv pip install ...`` command would pass or fail depending
    on whether the developer running it happens to have uv installed. Tests that
    care about the no-uv path override this with their own patch.
    """

    from services.ai_models.capabilities import profiles

    # Patch the module's own seam, never ``shutil.which``: that name is shared
    # with every other PATH lookup in the process, and faking it here made an
    # unrelated ffmpeg test try to exec a binary that does not exist.
    monkeypatch.setattr(profiles, "_find_on_path", lambda name: f"/usr/bin/{name}")


@pytest.fixture(autouse=True)
def isolated_install_marker(monkeypatch: pytest.MonkeyPatch, tmp_path_factory):
    """Hide the developer's own installer marker from every test.

    ``backend/runtime/install-profiles.json`` is written by a real install on
    the machine running the suite, and it feeds capability ``expected``. Left
    visible it would make readiness assertions depend on how the developer
    happened to install the app. Tests that need a marker write one into this
    temporary path.
    """
    from services.ai_models.capabilities import profiles

    marker = tmp_path_factory.mktemp("install-marker") / "install-profiles.json"
    monkeypatch.setattr(profiles, "PROFILE_MARKER_PATH", marker)
    profiles.invalidate_install_marker_cache()
    yield marker
    profiles.invalidate_install_marker_cache()


@pytest.fixture
def fast_delivery_timings(monkeypatch: pytest.MonkeyPatch) -> None:
    """Collapse the generation-delivery monitor's wall-clock waits to ~0.

    The monitor's real delays (a 10 s websocket-grace backstop, a 5 s connect
    timeout, reconnect backoff) exist to be patient in production; in tests that
    exercise the monitor/backstop flow but do not assert on timing they are pure
    dead wait. Opt in via this fixture rather than autouse: a few tests patch
    these constants themselves to assert timeout behaviour, and an autouse
    fixture would mask that.
    """
    from services.generation_delivery import service as delivery_service_module

    near_zero = {
        "HISTORY_FETCH_RETRY_SECONDS": 0,
        "MONITOR_CONNECT_TIMEOUT_SECONDS": 0.05,
        "MONITOR_RECONNECT_BASE_DELAY_SECONDS": 0,
        "MONITOR_RECONNECT_MAX_DELAY_SECONDS": 0,
        "MONITOR_BACKSTOP_INITIAL_DELAY_SECONDS": 0,
        "MONITOR_BACKSTOP_INTERVAL_SECONDS": 0,
        "MONITOR_BACKSTOP_QUEUED_INTERVAL_SECONDS": 0,
        "MONITOR_BACKSTOP_ONLY_INITIAL_DELAY_SECONDS": 0,
    }
    for name, value in near_zero.items():
        monkeypatch.setattr(delivery_service_module, name, value)


@pytest.fixture
def stub_comfyui_http(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace the shared ComfyUI httpx client with an offline stub.

    Several delivery paths (``_finalize_delivery`` → history-metadata
    enrichment, reconcile) fetch ``/history`` from ComfyUI. A test that does not
    assert on that data should not make a real connection — otherwise it hangs
    on the client's 10 s connect timeout whenever nothing answers on the
    configured URL, which is exactly what happens in CI and on dev machines
    without ComfyUI running.
    """
    from services.generation_delivery import service as delivery_service_module

    class _StubResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {}

    class _StubClient:
        async def get(self, *_args, **_kwargs) -> "_StubResponse":
            return _StubResponse()

    async def _stub_get_http_client() -> "_StubClient":
        return _StubClient()

    monkeypatch.setattr(
        delivery_service_module, "get_http_client", _stub_get_http_client
    )


@pytest.fixture
def reset_hardware_probe_cache():
    """Clear the process-global VRAM cache around a test.

    ``services.hardware.detect_local_vram`` memoises its result in a module
    global with a TTL, so without this a test that lets the real probe run (or
    patches it) leaks its value into later tests — an order-dependent flake.
    Scoped to the hardware-touching tests, not autouse, so the whole suite is
    not coupled to a private production global.
    """
    from services import hardware

    hardware._cached_local_vram = None
    yield
    hardware._cached_local_vram = None
