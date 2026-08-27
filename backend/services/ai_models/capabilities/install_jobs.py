"""Capability installs, executed through the shared job lifecycle.

The same shape as :mod:`.load_probes`: an explicit POST starts a job, the
client polls it, and the work happens on the job manager rather than inside a
request. Two things differ, and both come from what an install actually is.

**Only one install runs at a time, across every capability.** Two installers
resolving into the same virtual environment at once is not slow, it is
corrupting — they write the same ``site-packages`` with different ideas about
what should be in it. The lock is global for that reason, not per capability.

**The log is the progress.** An install has no meaningful percentage: a
resolver spends an unpredictable amount of time thinking and then downloads an
unpredictable number of megabytes. So the installer's output is streamed as job
diagnostics, which is what the panel shows, and the numeric progress only ever
says "still going".
"""

from __future__ import annotations

import asyncio
import threading

from config import RUNTIME_ROOT
from services.app_lifecycle import note_restart_required
from services.jobs import (
    BackendJobCancelledError,
    BackendJobContext,
    BackendJobDefinition,
    BackendJobManager,
    BackendJobNotFoundError,
    BackendJobNotReadyError,
    BackendJobSnapshot,
    JobArtifactStore,
)

from . import get_capability, get_provider, invalidate_capability_cache
from .installs import (
    INSTALL_TIMEOUT_SECONDS,
    InstallFailedError,
    InstallNotAvailableError,
    InstallPlan,
    failing_package_modules,
    install_failure_message,
    install_plan_for_capability,
    install_target_description,
    run_install,
    validate_plan,
)
from .profiles import record_profile_install


INSTALL_JOB_OWNER = "vlo.runtime-installs"
INSTALL_JOB_OWNER_VERSION = "1"
INSTALL_JOB_TYPE = "install-capability"

#: The job's own limit sits above the runner's, so a run that overshoots is
#: stopped by the runner — which can say what it was doing — rather than by the
#: job manager, which cannot.
INSTALL_JOB_TIMEOUT_SECONDS = INSTALL_TIMEOUT_SECONDS + 60.0

#: The job manager's own cap on one diagnostic message.
_MAX_DIAGNOSTIC = 1000


class CapabilityInstallNotFoundError(BackendJobNotFoundError):
    """The capability or its install job does not exist."""


class CapabilityInstallNotAvailableError(BackendJobNotReadyError):
    """This capability has no install command that can be run here."""


class CapabilityInstallBusyError(BackendJobNotReadyError):
    """Another install is already writing to the environment."""


def restart_reason_id(capability_id: str) -> str:
    return f"capability:{capability_id}"


def _plan_for(capability_id: str) -> InstallPlan | None:
    """The plan for what is failing *now*, not for what failed when asked.

    The same derivation the payload used, repeated here rather than carried in
    the request: a client sends an id, never a command, and the failing set is
    part of what the command is. ``deep_probe=False`` keeps this off the
    subprocess path — the checks the user just read are warm.
    """

    capability = get_capability(capability_id, deep_probe=False)
    return install_plan_for_capability(
        capability_id, failing_modules=failing_package_modules(capability)
    )


def _run_install_job(context: BackendJobContext, value: object) -> object:
    if not isinstance(value, dict) or not isinstance(value.get("capabilityId"), str):
        raise CapabilityInstallNotFoundError("Capability install input is invalid")

    capability_id = value["capabilityId"]
    provider = get_provider(capability_id)
    if provider is None:
        raise CapabilityInstallNotFoundError(
            f"Unknown runtime capability '{capability_id}'"
        )

    plan = _plan_for(capability_id)
    if plan is None:
        raise CapabilityInstallNotAvailableError(
            f"{provider.label} has no install command that can be run from here"
        )

    context.report_progress(0.02, f"Installing {provider.label}")
    # Truncated like every other log line: the job manager rejects a
    # diagnostic over 1000 characters, and a rejected one would fail the
    # install rather than the logging.
    context.report_diagnostic("info", f"$ {plan.display}"[:_MAX_DIAGNOSTIC])

    lines = 0

    def on_line(line: str) -> None:
        nonlocal lines
        lines += 1
        context.report_diagnostic("info", line)
        # Nothing here knows how much is left, so this only ever says the
        # installer is still talking to us. It stops well short of 1.0: the
        # job is not finished until the verification below has run.
        context.report_progress(min(0.85, 0.05 + lines * 0.01), line[:120])

    try:
        code, tail = run_install(
            plan,
            on_line=on_line,
            is_cancelled=lambda: context.cancelled,
        )
    except InstallNotAvailableError as exc:
        raise CapabilityInstallNotAvailableError(str(exc)) from exc

    if context.cancelled:
        _record_outcome(plan, status="failed", detail="Cancelled from the app")
        raise BackendJobCancelledError("The install was cancelled")

    if code != 0:
        message = install_failure_message(code, tail)
        _record_outcome(plan, status="failed", detail=message)
        raise InstallFailedError(message)

    _record_outcome(plan, status="installed", detail=None)

    # The environment on disk changed, so every cached answer about it is now
    # a claim about a machine that no longer exists.
    invalidate_capability_cache(capability_id)

    note_restart_required(
        restart_reason_id(capability_id),
        label=provider.label,
        summary=(
            f"{provider.label} was installed. Restart vlo so the backend can "
            "load it."
        ),
    )

    context.report_progress(0.98, f"{provider.label} installed")
    return {
        "capabilityId": capability_id,
        "installed": True,
        "command": plan.display,
        "summary": install_target_description(plan),
        "requiresRestart": plan.requires_restart,
    }


def _record_outcome(plan: InstallPlan, *, status: str, detail: str | None) -> None:
    """Keep the installer marker honest about what just happened.

    The marker is the only record of a profile that was asked for and did not
    install, and it is read to tell "never wanted" apart from "wanted and
    broken". An install started from the app is a second installer, so it
    writes the same record — otherwise repairing SAM2 here would leave the file
    still saying the SAM2 step failed.
    """

    if plan.profile_id is None:
        return
    record_profile_install(
        plan.profile_id, status=status, detail=detail, installer="vlo-app"
    )


class RuntimeCapabilityInstallJobs:
    """Owner-scoped install jobs, with one install in flight process-wide."""

    def __init__(self, manager: BackendJobManager) -> None:
        self._manager = manager
        self._lock = threading.RLock()
        self._active_jobs: dict[str, str] = {}
        self._pending_submissions: dict[str, asyncio.Task[BackendJobSnapshot]] = {}

    async def submit(self, capability_id: str) -> BackendJobSnapshot:
        provider = get_provider(capability_id)
        if provider is None:
            raise CapabilityInstallNotFoundError(
                f"Unknown runtime capability '{capability_id}'"
            )

        plan = _plan_for(capability_id)
        if plan is None:
            raise CapabilityInstallNotAvailableError(
                f"{provider.label} has no install command that can be run from "
                "here. Install it from a terminal instead."
            )
        # Checked before the job is created rather than inside it: a missing
        # requirements file is a broken deployment, and saying so in the
        # response beats burying it in a job that starts and immediately fails.
        try:
            validate_plan(plan)
        except InstallNotAvailableError as exc:
            raise CapabilityInstallNotAvailableError(str(exc)) from exc

        with self._lock:
            active = self._active_snapshot_locked(capability_id)
            if active is not None:
                return active
            busy = self._other_active_locked(capability_id)
            if busy is not None:
                raise CapabilityInstallBusyError(
                    f"An install for '{busy}' is already running. "
                    "Installs share one environment, so they run one at a time."
                )
            pending = self._pending_submissions.get(capability_id)
            if pending is None:
                pending = asyncio.create_task(
                    self._submit_new(capability_id),
                    name=f"capability-install-submit-{capability_id}",
                )
                self._pending_submissions[capability_id] = pending
                pending.add_done_callback(
                    lambda completed, id_=capability_id: self._discard_pending(
                        id_, completed
                    )
                )

        return await asyncio.shield(pending)

    def _discard_pending(
        self,
        capability_id: str,
        completed: asyncio.Task[BackendJobSnapshot],
    ) -> None:
        with self._lock:
            if self._pending_submissions.get(capability_id) is completed:
                self._pending_submissions.pop(capability_id, None)

    async def _submit_new(self, capability_id: str) -> BackendJobSnapshot:
        snapshot = await self._manager.submit(
            INSTALL_JOB_OWNER,
            INSTALL_JOB_TYPE,
            {"capabilityId": capability_id},
        )
        with self._lock:
            self._active_jobs[capability_id] = snapshot.identity.job_id
        return snapshot

    def get(self, capability_id: str, job_id: str) -> BackendJobSnapshot:
        snapshot = self._manager.get(INSTALL_JOB_OWNER, job_id)
        input_value = self._manager.get_input(INSTALL_JOB_OWNER, job_id)
        if (
            not isinstance(input_value, dict)
            or input_value.get("capabilityId") != capability_id
        ):
            raise CapabilityInstallNotFoundError(
                f"Install job '{job_id}' was not found for '{capability_id}'"
            )
        return snapshot

    async def cancel(self, capability_id: str, job_id: str) -> BackendJobSnapshot:
        # Ownership first: cancelling by job id alone would let a caller stop
        # an install it was never shown.
        self.get(capability_id, job_id)
        return await self._manager.cancel(INSTALL_JOB_OWNER, job_id)

    def _active_snapshot_locked(
        self, capability_id: str
    ) -> BackendJobSnapshot | None:
        job_id = self._active_jobs.get(capability_id)
        if job_id is None:
            return None
        try:
            snapshot = self._manager.get(INSTALL_JOB_OWNER, job_id)
        except BackendJobNotFoundError:
            self._active_jobs.pop(capability_id, None)
            return None
        if snapshot.status in {"queued", "running"}:
            return snapshot
        self._active_jobs.pop(capability_id, None)
        return None

    def active_capability_ids(self) -> tuple[str, ...]:
        """Capabilities whose install is running or about to be.

        Read by the restart guard, which must refuse to re-exec a process that
        is halfway through writing ``site-packages``.
        """

        with self._lock:
            active = [
                capability_id
                for capability_id in tuple(self._active_jobs)
                if self._active_snapshot_locked(capability_id) is not None
            ]
            active.extend(
                capability_id
                for capability_id in self._pending_submissions
                if capability_id not in active
            )
            return tuple(active)

    def _other_active_locked(self, capability_id: str) -> str | None:
        """The capability whose install is holding the environment, if any."""

        for other in tuple(self._active_jobs):
            if other == capability_id:
                continue
            if self._active_snapshot_locked(other) is not None:
                return other
        # A submission that has not landed yet holds the environment just as
        # firmly as a running one; it simply has no snapshot to find.
        for other in self._pending_submissions:
            if other != capability_id:
                return other
        return None

    async def shutdown(self) -> None:
        await self._manager.shutdown_all()


def _create_install_jobs() -> RuntimeCapabilityInstallJobs:
    manager = BackendJobManager(
        JobArtifactStore(RUNTIME_ROOT / "runtime-install-job-artifacts"),
        max_jobs_per_owner=16,
        executor_max_workers=1,
        max_concurrent_jobs_per_owner=1,
        evict_finished_jobs_at_capacity=True,
        thread_name_prefix="capability-install-job",
    )
    manager.register_owner(
        INSTALL_JOB_OWNER,
        INSTALL_JOB_OWNER_VERSION,
        (
            BackendJobDefinition(
                id=INSTALL_JOB_TYPE,
                label="Install AI runtime",
                run=_run_install_job,
                timeout_seconds=INSTALL_JOB_TIMEOUT_SECONDS,
            ),
        ),
    )
    return RuntimeCapabilityInstallJobs(manager)


_INSTALL_JOBS: RuntimeCapabilityInstallJobs | None = None
_INSTALL_JOBS_LOCK = threading.Lock()


def get_runtime_capability_install_jobs() -> RuntimeCapabilityInstallJobs:
    global _INSTALL_JOBS
    if _INSTALL_JOBS is None:
        with _INSTALL_JOBS_LOCK:
            if _INSTALL_JOBS is None:
                _INSTALL_JOBS = _create_install_jobs()
    return _INSTALL_JOBS


def active_install_capability_ids() -> tuple[str, ...]:
    """The same, without bringing the job manager into existence.

    The restart guard runs on a route the frontend polls. Creating a thread
    pool as a side effect of asking "is anything installing?" would be a
    strange way to answer "no".
    """

    jobs = _INSTALL_JOBS
    return () if jobs is None else jobs.active_capability_ids()


async def shutdown_runtime_capability_install_jobs() -> None:
    global _INSTALL_JOBS
    with _INSTALL_JOBS_LOCK:
        jobs = _INSTALL_JOBS
        _INSTALL_JOBS = None
    if jobs is not None:
        await jobs.shutdown()
