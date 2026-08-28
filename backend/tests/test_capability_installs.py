"""Running an install from inside the app, and the restart that follows it.

The governing case: **the command the diagnostics panel offers to run is the
command the printed remediation names, built from the same table, and nothing a
client sends can change it.** A client asks to install a capability id; the argv
is derived here. So the tests below pin the derivation, the refusal to derive
one from a target that is really a flag, the single-install-at-a-time rule that
keeps two resolvers out of one ``site-packages``, and the restart bookkeeping
that stops the app claiming a freshly installed package is usable by a process
that has already finished importing.
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.ai_models.capabilities import (
    CapabilityDescriptor,
    PackageSpec,
    capability_json,
    get_capability,
    install_plan_for_capability,
    profiles,
    register_descriptor,
    unregister_descriptor,
)
from services.ai_models.capabilities import installs
from services.ai_models.capabilities.installs import (
    InstallNotAvailableError,
    InstallPlan,
    describe_install,
    failing_package_modules,
    install_failure_message,
    restart_reason_id,
    run_install,
    validate_plan,
)
from services.ai_models.capabilities.profiles import (
    SAM2_PROFILE_ID,
    SAM_AUDIO_PROFILE_ID,
    record_profile_install,
    read_install_marker,
    write_install_marker,
)
from services.app_lifecycle import restart as restart_module
from services.app_lifecycle import (
    clear_restart_required,
    note_restart_required,
    restart_state,
)

from conftest import _FakeEnvironment  # noqa: E402


PROJECT_ROOT = Path(__file__).resolve().parents[2]

FAKE_ID = "vlo-fake-install"


@pytest.fixture
def with_uv(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(profiles, "_find_on_path", lambda name: f"/usr/bin/{name}")


@pytest.fixture
def without_uv(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(profiles, "_find_on_path", lambda name: None)
    monkeypatch.setattr(profiles, "_uv_bootstrap_candidates", lambda: ())


@pytest.fixture(autouse=True)
def clean_restart_ledger():
    clear_restart_required()
    yield
    clear_restart_required()


# --------------------------------------------------------------------------
# Deriving the command
# --------------------------------------------------------------------------


def test_a_profile_install_runs_the_command_the_panel_prints(with_uv: None) -> None:
    plan = install_plan_for_capability("sam2")

    assert plan is not None
    assert plan.tool == "uv"
    assert plan.profile_id == SAM2_PROFILE_ID
    # Same tool, same interpreter, same requirements file as the printed
    # remediation — but resolved, because the runner has no guarantee about the
    # working directory a relative path would be read from.
    assert plan.argv[:3] == ("uv", "pip", "install")
    assert plan.argv[3] == "--python"
    assert Path(plan.argv[4]) == Path(profiles.backend_python_executable())
    assert plan.argv[-2] == "-r"
    assert Path(plan.argv[-1]) == PROJECT_ROOT / "backend" / "requirements-sam2.txt"
    assert plan.requires_restart is True


def test_the_displayed_command_is_the_argv_and_nothing_else(with_uv: None) -> None:
    plan = install_plan_for_capability("sam-audio")

    assert plan is not None
    # What the user agrees to is rendered from the vector that will run, so a
    # confirmation cannot show one command and execute another.
    assert plan.display.split() == list(plan.argv)
    assert plan.to_json()["command"] == plan.display
    assert plan.to_json()["profileId"] == SAM_AUDIO_PROFILE_ID


def test_a_profile_override_file_rides_along_with_the_requirements(
    with_uv: None,
) -> None:
    # SAM-Audio's protobuf floor cannot be a requirement: dacvae caps protobuf
    # below 3.20, and a requirement intersects with that cap rather than
    # replacing it, so the resolve is unsatisfiable. Losing the flag here would
    # make every in-app SAM-Audio install fail in the resolver.
    plan = install_plan_for_capability("sam-audio")

    assert plan is not None
    assert plan.argv[5] == "--overrides"
    assert (
        Path(plan.argv[6]) == PROJECT_ROOT / "backend" / "overrides-sam-audio.txt"
    )
    assert plan.argv[-2] == "-r"
    assert (
        Path(plan.argv[-1])
        == PROJECT_ROOT / "backend" / "requirements-sam-audio.txt"
    )
    # The file has to exist, or the install stops before the installer runs.
    validate_plan(plan)


def test_pip_installs_when_the_machine_has_no_uv(
    without_uv: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The printed remediation degrades to a documentation link here, because a
    # ``uv`` command line would fail with "command not found". The runner has a
    # tool the printed line does not: it knows the interpreter by absolute
    # path, so ``python -m pip`` needs nothing from PATH.
    monkeypatch.setattr(installs, "_pip_available", lambda: True)

    plan = install_plan_for_capability("sam2")

    assert plan is not None
    assert plan.tool == "pip"
    assert plan.argv[:4] == (
        profiles.backend_python_executable(),
        "-m",
        "pip",
        "install",
    )


def test_nothing_is_offered_when_neither_installer_exists(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
    without_uv: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The venv ``uv sync`` builds has no pip in it. With uv gone too there is
    # no way to install anything, and offering a button that cannot work is
    # the false affordance this whole surface exists to remove.
    monkeypatch.setattr(installs, "_pip_available", lambda: False)

    assert install_plan_for_capability("sam2") is None
    capability = get_capability("sam2", deep_probe=False)
    assert capability is not None
    assert describe_install(capability) is None
    assert "install" not in capability_json(capability)


# --------------------------------------------------------------------------
# Package targets, including the ones an extension brings
# --------------------------------------------------------------------------


def _package_descriptor(**overrides) -> CapabilityDescriptor:
    return CapabilityDescriptor(
        id=FAKE_ID,
        label="Fake runtime",
        packages=(
            PackageSpec(
                module="vlo_fake_runtime",
                distribution="vlo-fake",
                install_target="vlo-fake==1.2.3",
                install_summary="Install the fake runtime",
            ),
        ),
        **overrides,
    )


def test_a_package_target_beats_the_profile(with_uv: None) -> None:
    register_descriptor(_package_descriptor(profile=SAM2_PROFILE_ID))
    try:
        plan = install_plan_for_capability(FAKE_ID)
    finally:
        unregister_descriptor(FAKE_ID)

    assert plan is not None
    assert plan.argv[-1] == "vlo-fake==1.2.3"
    assert plan.summary == "Install the fake runtime"
    # No profile was installed, so there is no installer record to write.
    assert plan.profile_id is None


def _two_package_descriptor() -> CapabilityDescriptor:
    """An extension-shaped capability: two required packages, two targets."""

    return CapabilityDescriptor(
        id=FAKE_ID,
        label="Fake runtime",
        packages=(
            PackageSpec(
                module="vlo_fake_runtime",
                distribution="vlo-fake",
                install_target="vlo-fake==1.2.3",
                install_summary="Install the fake runtime",
            ),
            PackageSpec(
                module="vlo_fake_extra",
                distribution="vlo-fake-extra",
                install_target="vlo-fake-extra==4.5.6",
                install_summary="Install the fake extra",
            ),
        ),
    )


def test_the_install_is_for_the_package_that_failed(
    fake_environment: _FakeEnvironment,
    with_uv: None,
) -> None:
    # The primary package is present; the second one is not. Installing the
    # primary would reinstall something already there, leave the real problem
    # untouched, and hide the remediation that named it — with a button whose
    # only possible effect is to run again.
    fake_environment.set_package("vlo_fake_runtime", installed=True)
    fake_environment.set_package(
        "vlo_fake_extra", installed=False, importable=False
    )

    register_descriptor(_two_package_descriptor())
    try:
        capability = get_capability(FAKE_ID)
        assert capability is not None
        payload = capability_json(capability)
    finally:
        unregister_descriptor(FAKE_ID)

    assert payload["install"]["command"].endswith("vlo-fake-extra==4.5.6")
    assert "vlo-fake==1.2.3" not in payload["install"]["command"]
    assert payload["install"]["summary"] == "Install the fake extra"


def test_several_failing_packages_install_in_one_command(
    fake_environment: _FakeEnvironment,
    with_uv: None,
) -> None:
    fake_environment.set_package(
        "vlo_fake_runtime", installed=False, importable=False
    )
    fake_environment.set_package(
        "vlo_fake_extra", installed=False, importable=False
    )

    register_descriptor(_two_package_descriptor())
    try:
        capability = get_capability(FAKE_ID)
        assert capability is not None
        plan = install_plan_for_capability(
            FAKE_ID, failing_modules=failing_package_modules(capability)
        )
    finally:
        unregister_descriptor(FAKE_ID)

    assert plan is not None
    # One resolve, one install, one restart — not two rounds of each.
    assert plan.argv[-2:] == ("vlo-fake==1.2.3", "vlo-fake-extra==4.5.6")


def test_with_nothing_failing_the_plan_covers_every_required_package(
    with_uv: None,
) -> None:
    # No evidence is not evidence of nothing: a bare call cannot pick one
    # package over another, and installing all of them is the answer that
    # cannot be wrong. Optional extras stay out — madmom's absence enables a
    # feature rather than blocking one.
    register_descriptor(
        replace(
            _two_package_descriptor(),
            packages=(
                *_two_package_descriptor().packages,
                PackageSpec(
                    module="vlo_fake_optional",
                    optional=True,
                    install_target="vlo-fake-optional",
                ),
            ),
        )
    )
    try:
        plan = install_plan_for_capability(FAKE_ID)
    finally:
        unregister_descriptor(FAKE_ID)

    assert plan is not None
    assert plan.argv[-2:] == ("vlo-fake==1.2.3", "vlo-fake-extra==4.5.6")
    assert "vlo-fake-optional" not in plan.argv


def test_a_target_that_is_really_a_flag_is_refused(with_uv: None) -> None:
    # Extensions declare their own install targets. A target beginning with a
    # dash is an installer option — ``--index-url``, ``--pre`` — and running it
    # would reconfigure the install rather than name a package to install.
    descriptor = _package_descriptor()
    descriptor = replace(
        descriptor,
        packages=(
            replace(descriptor.packages[0], install_target="--index-url=http://x"),
        ),
    )
    register_descriptor(descriptor)
    try:
        assert install_plan_for_capability(FAKE_ID) is None
    finally:
        unregister_descriptor(FAKE_ID)


def test_a_shell_metacharacter_in_a_target_stays_one_argument(
    with_uv: None,
) -> None:
    descriptor = _package_descriptor()
    descriptor = replace(
        descriptor,
        packages=(
            replace(descriptor.packages[0], install_target="pkg; rm -rf ~"),
        ),
    )
    register_descriptor(descriptor)
    try:
        plan = install_plan_for_capability(FAKE_ID)
    finally:
        unregister_descriptor(FAKE_ID)

    assert plan is not None
    # No shell runs the vector, so the semicolon is part of a (nonsense)
    # package name and never a second command.
    assert plan.argv[-1] == "pkg; rm -rf ~"
    assert "'pkg; rm -rf ~'" in plan.display


# --------------------------------------------------------------------------
# Running it
# --------------------------------------------------------------------------


def _script_plan(script: str, profile_id: str | None = None) -> InstallPlan:
    return InstallPlan(
        capability_id="sam2",
        summary="Install a fake runtime",
        argv=(sys.executable, "-c", script),
        tool="pip",
        profile_id=profile_id,
    )


def test_running_an_install_streams_its_output_and_reports_success() -> None:
    lines: list[str] = []
    code, tail = run_install(
        _script_plan("print('Resolved 3 packages'); print('Installed sam2')"),
        on_line=lines.append,
    )

    assert code == 0
    assert lines == ["Resolved 3 packages", "Installed sam2"]
    assert tail[-1] == "Installed sam2"


def test_a_failing_install_reports_the_end_of_the_log() -> None:
    code, tail = run_install(
        _script_plan(
            "import sys; print('collecting'); "
            "print('error: no matching distribution', file=sys.stderr); "
            "sys.exit(2)"
        ),
    )

    assert code == 2
    message = install_failure_message(code, tail)
    # The reason a resolver gives up is the last thing it says, not the first.
    assert "no matching distribution" in message
    assert message.startswith("The install command exited with status 2")


def test_cancelling_stops_the_installer() -> None:
    # A download produces no output for minutes, so cancellation cannot depend
    # on the reader loop noticing: a watchdog owns stopping the process.
    code, _tail = run_install(
        _script_plan("import time; time.sleep(30)"),
        is_cancelled=lambda: True,
    )

    assert code != 0


def test_a_reader_that_gives_up_does_not_leave_the_installer_running() -> None:
    # A cancelled job raises from inside the line callback: the job manager's
    # ``report_diagnostic`` refuses to run once cancellation is requested. That
    # exception stands the watchdog down, so the runner itself has to stop the
    # process — otherwise the wait for its exit code blocks on an installer
    # that is still writing packages.
    plan = _script_plan(
        "import sys, time\n"
        "print('starting', flush=True)\n"
        "time.sleep(30)\n"
    )

    def stop(_line: str) -> None:
        raise RuntimeError("the job was cancelled")

    started = time.monotonic()
    with pytest.raises(RuntimeError, match="cancelled"):
        run_install(plan, on_line=stop)

    # Not thirty seconds, and not the job timeout either.
    assert time.monotonic() - started < 10


def test_an_install_that_overruns_is_stopped_and_says_so() -> None:
    with pytest.raises(installs.InstallFailedError, match="did not finish"):
        run_install(
            _script_plan("import time; time.sleep(30)"),
            timeout_seconds=0.3,
        )


def test_a_missing_requirements_file_fails_before_the_installer_runs(
    tmp_path: Path,
) -> None:
    plan = InstallPlan(
        capability_id="sam2",
        summary="Install SAM2",
        argv=("uv", "pip", "install", "-r", str(tmp_path / "gone.txt")),
        tool="uv",
    )

    with pytest.raises(InstallNotAvailableError, match="requirements file"):
        validate_plan(plan)


# --------------------------------------------------------------------------
# The installer's marker
# --------------------------------------------------------------------------


def test_an_in_app_install_records_itself_without_erasing_other_profiles(
    isolated_install_marker: Path,
) -> None:
    write_install_marker(
        {SAM2_PROFILE_ID: "failed", SAM_AUDIO_PROFILE_ID: "skipped"},
        path=isolated_install_marker,
    )

    record_profile_install(
        SAM_AUDIO_PROFILE_ID, status="installed", installer="vlo-app"
    )

    marker = read_install_marker()
    audio = marker.record(SAM_AUDIO_PROFILE_ID)
    assert audio is not None
    assert audio.status == "installed"
    assert audio.requested is True
    # The whole point of the merge: the failed SAM2 step is the only record of
    # an installer warning nobody saw, and installing something else must not
    # take it away.
    sam2 = marker.record(SAM2_PROFILE_ID)
    assert sam2 is not None
    assert sam2.status == "failed"
    assert marker.installer == "vlo-app"


def test_a_repaired_profile_stops_reporting_the_old_failure(
    isolated_install_marker: Path,
) -> None:
    write_install_marker({SAM2_PROFILE_ID: "failed"}, path=isolated_install_marker)

    record_profile_install(SAM2_PROFILE_ID, status="installed")

    record = read_install_marker().record(SAM2_PROFILE_ID)
    assert record is not None
    assert record.failed is False


def test_a_marker_written_as_a_list_can_still_be_merged(
    isolated_install_marker: Path,
) -> None:
    # ``InstallMarker`` reads both shapes, so the merge has to handle the one
    # it did not write.
    isolated_install_marker.parent.mkdir(parents=True, exist_ok=True)
    isolated_install_marker.write_text(
        json.dumps(
            {
                "version": 1,
                "profiles": [{"id": SAM2_PROFILE_ID, "status": "failed"}],
            }
        ),
        encoding="utf-8",
    )
    profiles.invalidate_install_marker_cache()

    record_profile_install(SAM_AUDIO_PROFILE_ID, status="installed")

    marker = read_install_marker()
    assert marker.record(SAM2_PROFILE_ID) is not None
    assert marker.record(SAM2_PROFILE_ID).status == "failed"
    assert marker.record(SAM_AUDIO_PROFILE_ID).status == "installed"


# --------------------------------------------------------------------------
# What the payload says
# --------------------------------------------------------------------------


def test_the_payload_carries_the_install_and_the_restart_flag(
    fake_environment: _FakeEnvironment,
    capability_dirs: dict[str, Path],
    isolated_install_marker: Path,
    with_uv: None,
) -> None:
    capability = get_capability("sam2", deep_probe=False)
    assert capability is not None

    payload = capability_json(capability)
    assert payload["install"]["available"] is True
    assert payload["install"]["requiresRestart"] is True
    assert payload["restartRequired"] is False

    note_restart_required(
        restart_reason_id("sam2"), label="SAM2", summary="Installed"
    )
    assert capability_json(capability)["restartRequired"] is True


# --------------------------------------------------------------------------
# Restarting
# --------------------------------------------------------------------------


def test_restart_state_reports_what_is_waiting() -> None:
    state = restart_state()
    assert state["restartRequired"] is False
    assert state["reasons"] == []

    note_restart_required("capability:sam2", label="SAM2", summary="Installed")

    state = restart_state()
    assert state["restartRequired"] is True
    assert state["reasons"][0]["label"] == "SAM2"
    assert state["instanceId"] == restart_module.INSTANCE_ID


def test_a_module_launch_is_relaunched_as_a_module(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # ``sys.argv`` does not record ``-m``: re-execing argv[0] would run
    # uvicorn's ``__main__.py`` as a loose script instead of the module.
    class _Spec:
        name = "uvicorn.__main__"
        parent = "uvicorn"

    class _Main:
        __spec__ = _Spec()

    monkeypatch.setitem(sys.modules, "__main__", _Main())
    monkeypatch.setattr(sys, "argv", ["/venv/lib/uvicorn/__main__.py", "main:app"])

    assert restart_module._relaunch_argv() == [
        sys.executable,
        "-m",
        "uvicorn",
        "main:app",
    ]


def test_a_deployment_can_turn_the_in_app_restart_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(restart_module.DISABLE_ENV_VAR, "1")

    assert restart_module.restart_supported() is False
    with pytest.raises(restart_module.RestartNotSupportedError):
        restart_module.request_restart()


def test_a_supervised_child_never_restarts_itself(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Under ``uvicorn --reload`` the API runs in a spawned child while the
    # supervisor holds the socket, and ``sys.argv`` still says ``--reload``.
    # Re-execing the child starts a second supervisor that cannot bind the
    # port, and the client waits out its timeout for an instance id that will
    # never change.
    monkeypatch.delenv(restart_module.DISABLE_ENV_VAR, raising=False)
    monkeypatch.setattr(
        restart_module.multiprocessing,
        "current_process",
        lambda: SimpleNamespace(name="SpawnProcess-1"),
    )

    assert restart_module.restart_supported() is False
    reason = restart_module.restart_unsupported_reason()
    assert reason is not None and "supervisor" in reason


def test_a_reload_launch_is_refused_even_from_the_main_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(restart_module.DISABLE_ENV_VAR, raising=False)
    monkeypatch.setattr(sys, "argv", ["uvicorn", "main:app", "--reload"])

    assert restart_module.restart_supported() is False


def test_a_running_install_blocks_a_restart(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from services.ai_models.capabilities import install_jobs

    # An install job is an ordinary CPU job: the GPU ledger cannot see it, so
    # without this a restart prompt raised by one finished install would
    # re-exec the process while a second installer was still writing
    # site-packages.
    monkeypatch.delenv(restart_module.DISABLE_ENV_VAR, raising=False)
    monkeypatch.setattr(
        install_jobs, "active_install_capability_ids", lambda: ("sam-audio",)
    )

    blocker = restart_module.restart_blocker()
    assert blocker is not None and "sam-audio" in blocker
    with pytest.raises(restart_module.RestartBlockedError):
        restart_module.request_restart()


def test_a_restart_is_refused_while_gpu_work_is_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The one test that reaches the scheduling path, so it is the one test that
    # removes the suite-wide off-switch — with ``_relaunch_argv`` and the timer
    # both replaced, so what is "scheduled" is a recording, not an execv.
    monkeypatch.delenv(restart_module.DISABLE_ENV_VAR, raising=False)
    monkeypatch.setattr(
        restart_module, "restart_blocker", lambda: "1 GPU job is still running"
    )

    with pytest.raises(restart_module.RestartBlockedError):
        restart_module.request_restart()

    # Forcing is the user's decision to make, and it only overrides this guard.
    scheduled: list[float] = []
    monkeypatch.setattr(restart_module, "_relaunch_argv", lambda: ["/bin/true"])
    monkeypatch.setattr(
        restart_module.threading,
        "Timer",
        lambda delay, function: _NullTimer(delay, scheduled),
    )
    assert restart_module.request_restart(force=True)["restarting"] is True
    assert scheduled == [restart_module.RESTART_DELAY_SECONDS]


class _NullTimer:
    """A timer that records rather than fires. Nothing here may re-exec."""

    def __init__(self, delay: float, scheduled: list[float]) -> None:
        self._delay = delay
        self._scheduled = scheduled
        self.name = ""
        self.daemon = False

    def start(self) -> None:
        self._scheduled.append(self._delay)


# --------------------------------------------------------------------------
# Over HTTP
# --------------------------------------------------------------------------


@pytest.fixture
def client():
    """One client, and one event loop for the whole test.

    Used as a context manager on purpose: a bare ``TestClient`` runs each
    request on its own portal and tears it down afterwards, which cancels the
    job task the POST just created. The job would then report ``cancelled``
    with an empty log, some of the time, depending on whether the runner
    happened to finish first.
    """

    from routers.app_lifecycle import router as lifecycle_router
    from routers.runtime_capabilities import router as capabilities_router

    app = FastAPI()
    app.include_router(capabilities_router)
    app.include_router(lifecycle_router)
    with TestClient(app) as client:
        yield client


def test_the_install_route_takes_no_command_from_the_caller(
    client: TestClient,
    with_uv: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from services.ai_models.capabilities import install_jobs

    ran: list[tuple[str, ...]] = []

    def fake_run(plan, *, on_line=None, is_cancelled=None, **kwargs):
        ran.append(plan.argv)
        if on_line is not None:
            on_line("Installed 1 package")
        return 0, ("Installed 1 package",)

    monkeypatch.setattr(install_jobs, "run_install", fake_run)
    monkeypatch.setattr(install_jobs, "_record_outcome", lambda *a, **k: None)

    started = client.post("/app/runtime-capabilities/sam2/install")
    assert started.status_code == 200, started.text
    job_id = started.json()["jobId"]

    for _ in range(200):
        snapshot = client.get(
            f"/app/runtime-capabilities/sam2/install/{job_id}"
        ).json()
        if snapshot["status"] not in {"queued", "running"}:
            break
    assert snapshot["status"] == "succeeded", snapshot
    assert snapshot["result"]["installed"] is True
    assert ran and ran[0][:3] == ("uv", "pip", "install")
    # The log the panel shows is the installer's own output.
    assert any(
        "Installed 1 package" in diagnostic["message"]
        for diagnostic in snapshot["diagnostics"]
    )
    # And the capability now says a restart is what is left to do.
    payload = client.get("/app/runtime-capabilities/sam2").json()
    assert payload["capability"]["restartRequired"] is True


def test_an_install_job_belongs_to_its_capability(
    client: TestClient,
    with_uv: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from services.ai_models.capabilities import install_jobs

    monkeypatch.setattr(
        install_jobs, "run_install", lambda *a, **k: (0, ("done",))
    )
    monkeypatch.setattr(install_jobs, "_record_outcome", lambda *a, **k: None)

    job_id = client.post("/app/runtime-capabilities/sam2/install").json()["jobId"]

    stolen = client.get(f"/app/runtime-capabilities/sam-audio/install/{job_id}")
    assert stolen.status_code == 404


def test_a_capability_with_no_runnable_install_is_refused(
    client: TestClient,
    without_uv: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(installs, "_pip_available", lambda: False)

    response = client.post("/app/runtime-capabilities/sam2/install")

    assert response.status_code == 409
    assert "terminal" in response.json()["detail"]


def test_an_unknown_capability_is_a_404(client: TestClient) -> None:
    response = client.post("/app/runtime-capabilities/not-a-runtime/install")

    assert response.status_code == 404


def test_the_lifecycle_route_answers_the_restart_poll(client: TestClient) -> None:
    first = client.get("/app/lifecycle").json()
    assert first["instanceId"] == restart_module.INSTANCE_ID
    assert first["restartRequired"] is False

    note_restart_required("capability:sam2", label="SAM2", summary="Installed")
    assert client.get("/app/lifecycle").json()["restartRequired"] is True


def test_restarting_is_refused_rather_than_pretended(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        restart_module, "restart_unsupported_reason", lambda: "Not here."
    )

    response = client.post("/app/lifecycle/restart")

    # 501, not 500: this backend cannot restart itself, and the client should
    # fall back to telling the user to do it.
    assert response.status_code == 501
