"""Running a capability's install command, rather than only printing it.

The diagnostics surfaces have always been able to say *what* to run. This
module is what turns that sentence into something the app can carry out: one
:class:`InstallPlan` per capability, built from the same profile and package
table the printed remediation comes from, so the command shown and the command
run cannot be different commands.

Three properties are load-bearing:

* **The plan is derived, never received.** A caller asks to install a
  *capability id*; the argv is rebuilt here from the descriptor. Nothing a
  client sends reaches a process argument, so there is no command to inject
  into and no way to install something other than what the card offered.
* **No shell.** The command is an argument vector, run without a shell, so a
  package target containing spaces or shell metacharacters is a package target
  and nothing else. A target that begins with a dash is refused outright: that
  is a flag, never a distribution.
* **The interpreter is this process's.** Whatever is serving the request is the
  environment the missing package has to land in — the same reasoning
  :func:`~.profiles.backend_python` already uses for the printed command.

``uv`` is preferred, because it is what the installer uses and what the backend
venv was built with. ``python -m pip`` is the fallback for an environment that
has no ``uv`` — a conda environment, a container, a system interpreter with the
backend's dependencies beside it. It is genuinely a fallback: the venv ``uv
sync`` produces has no ``pip`` in it at all, so on an ordinary vlo install this
path does not exist and the absence of both tools means no runnable plan.
"""

from __future__ import annotations

import os
import shlex
import subprocess
import threading
import time
from collections.abc import Callable, Collection, Sequence
from dataclasses import dataclass
from importlib.util import find_spec
from pathlib import Path
from typing import Any

from services.app_lifecycle import requires_restart

from .catalogue import get_descriptor
from .contract import Capability
from .descriptors import CapabilityDescriptor, PackageSpec
from .profiles import (
    PROJECT_ROOT,
    backend_python,
    backend_python_executable,
    get_profile,
    uv_executable,
)


#: How long an install may run before it is killed. Generous on purpose: this
#: is the path that installs torch, and a cold download on a slow link is
#: measured in tens of minutes, not seconds.
INSTALL_TIMEOUT_SECONDS = 45 * 60.0

#: How often the watchdog looks at the cancel flag and the deadline.
_WATCHDOG_INTERVAL_SECONDS = 0.25

#: Grace between asking the installer to stop and killing it.
_TERMINATE_GRACE_SECONDS = 5.0

#: Longest log line kept. The job manager caps a diagnostic at 1000 characters,
#: and a resolver printing a wall of text is not more informative for it.
_MAX_LINE_LENGTH = 500


class InstallNotAvailableError(RuntimeError):
    """This capability has no runnable install command."""


class InstallFailedError(RuntimeError):
    """The install command ran and did not succeed."""


@dataclass(frozen=True)
class InstallPlan:
    """One runnable install, and how to describe it."""

    capability_id: str
    summary: str
    argv: tuple[str, ...]
    #: ``uv`` or ``pip`` — which installer the argv drives.
    tool: str
    #: The profile this installs, when it installs one. ``None`` for a package
    #: target no installer profile covers: an optional extra, or anything an
    #: extension brought with it.
    profile_id: str | None = None
    requires_restart: bool = True

    @property
    def display(self) -> str:
        """The argv as a single line, quoted the way a shell would need it.

        This is what the user is shown before agreeing to run it, so it is
        rendered from the argv itself rather than written out a second time.
        """

        return shlex.join(self.argv)

    def to_json(self) -> dict[str, Any]:
        return {
            "available": True,
            "summary": self.summary,
            "command": self.display,
            "tool": self.tool,
            "profileId": self.profile_id,
            "requiresRestart": self.requires_restart,
        }


def _pip_available() -> bool:
    """Whether ``python -m pip`` would work in the target interpreter.

    Checked in this process, which *is* the target interpreter in every case
    that matters; the one exception — an interpreter that cannot name itself,
    where :func:`backend_python_executable` falls back to the venv layout — has
    no better answer available.
    """

    try:
        return find_spec("pip") is not None
    except (ImportError, ValueError):  # pragma: no cover - broken installs
        return False


def _installer_argv() -> tuple[tuple[str, ...], str] | None:
    """The leading argv of an install command, and which tool it drives."""

    uv = uv_executable()
    if uv is not None:
        return (
            (uv, "pip", "install", "--python", backend_python_executable()),
            "uv",
        )
    if _pip_available():
        return ((backend_python_executable(), "-m", "pip", "install"), "pip")
    return None


def _requirements_path(requirements: str) -> Path:
    """A project-relative requirements file, resolved for ``argv``.

    The printed command keeps the relative form, which is what a user pasting
    it at the repository root wants. The runner cannot assume that working
    directory, so it uses the absolute path.
    """

    return PROJECT_ROOT / requirements


#: How a failing package check is named, so a failure can be read back to the
#: package that produced it. Mirrors :attr:`PackageSpec.check_id`.
_PACKAGE_CHECK_PREFIX = "package."


def failing_package_modules(capability: Capability | None) -> frozenset[str]:
    """The modules whose package checks are currently failing.

    A capability can declare several required packages, and only the missing
    ones should be installed. Without this the plan would always name the
    *primary* package — reinstalling something already present while the
    package that actually failed stayed missing, with its own remediation
    hidden behind a button that could not fix it.
    """

    if capability is None:
        return frozenset()
    return frozenset(
        check.id[len(_PACKAGE_CHECK_PREFIX) :]
        for check in capability.checks
        if check.failed and check.id.startswith(_PACKAGE_CHECK_PREFIX)
    )


def _selected_packages(
    descriptor: CapabilityDescriptor,
    failing_modules: Collection[str] | None,
) -> tuple[PackageSpec, ...]:
    """Which of a capability's packages this install is for.

    Optional packages never take part: their absence is a warning that enables
    a feature, not a failure that blocks one, so sweeping madmom into an
    install of Beat This! would install something nobody asked for.

    Evidence narrows the set; the absence of evidence does not empty it. When
    nothing is known to be failing — a bare call, or checks that name no
    package — every required package is the honest answer.
    """

    required = tuple(
        package for package in descriptor.packages if not package.optional
    )
    if not failing_modules:
        return required
    selected = tuple(
        package
        for package in required
        if package.module in failing_modules
        or package.probe_target in failing_modules
    )
    return selected or required


def _targets_summary(packages: Sequence[PackageSpec]) -> str:
    if len(packages) == 1:
        package = packages[0]
        return package.install_summary or f"Install {package.module}"
    return "Install " + ", ".join(package.module for package in packages)


def _package_plan(
    descriptor: CapabilityDescriptor,
    packages: Sequence[PackageSpec],
) -> InstallPlan | None:
    targets = tuple(
        package.install_target for package in packages if package.install_target
    )
    if not targets:
        return None
    if any(target.startswith("-") for target in targets):
        # A target that starts with a dash is an installer flag, whatever the
        # descriptor meant by it. Refusing keeps a declared package target from
        # becoming a way to reconfigure the installer.
        return None
    installer = _installer_argv()
    if installer is None:
        return None
    leading, tool = installer
    targeted = [package for package in packages if package.install_target]
    return InstallPlan(
        capability_id=descriptor.id,
        summary=_targets_summary(targeted),
        argv=(*leading, *targets),
        tool=tool,
    )


def install_plan_for_capability(
    capability_id: str,
    *,
    failing_modules: Collection[str] | None = None,
) -> InstallPlan | None:
    """The install this capability's failure can actually be repaired with.

    Mirrors :func:`~.environment_checks.package_install_remediation`, and for
    the same reason: a package that names its own ``install_target`` is the
    more specific statement and wins over the descriptor's profile. It mirrors
    it per *package* too — that function is called with the package whose check
    failed, and a plan built from a different one would install something the
    user was never shown.
    """

    descriptor = get_descriptor(capability_id)
    if descriptor is None:
        return None

    packages = _selected_packages(descriptor, failing_modules)
    plan = _package_plan(descriptor, packages)
    if plan is not None:
        return plan

    profile = (
        get_profile(descriptor.profile) if descriptor.profile is not None else None
    )
    if profile is None or profile.requirements is None:
        return None

    installer = _installer_argv()
    if installer is None:
        return None
    leading, tool = installer
    return InstallPlan(
        capability_id=capability_id,
        summary=(
            f"Install {profile.label} into the backend virtual environment"
            if profile.optional
            else "Reinstall the backend requirements"
        ),
        argv=(*leading, "-r", str(_requirements_path(profile.requirements))),
        tool=tool,
        profile_id=profile.id,
    )


def restart_reason_id(capability_id: str) -> str:
    """The ledger key an installed capability waits for a restart under.

    Lives here rather than beside the job that writes it, because the payload
    that *reads* it must not import the job module — that one imports the
    registry, and the registry builds the payload.
    """

    return f"capability:{capability_id}"


def capability_requires_restart(capability_id: str) -> bool:
    return requires_restart(restart_reason_id(capability_id))


def describe_install(capability: Capability) -> dict[str, Any] | None:
    """The install half of a capability payload, or ``None`` when there is none.

    Takes the capability rather than its id because the answer depends on what
    is failing right now: a descriptor with two required packages has two
    possible installs, and the right one is the one for the check the user is
    being shown.

    Absent rather than ``{"available": false}``: a capability with nothing to
    install and a capability whose install cannot be run here are the same
    thing to every consumer, and neither should render a button.
    """

    plan = install_plan_for_capability(
        capability.id, failing_modules=failing_package_modules(capability)
    )
    return None if plan is None else plan.to_json()


def _install_environment() -> dict[str, str]:
    """The child's environment: the parent's, minus the interactive bits.

    Progress bars are turned off rather than filtered, because they are written
    with carriage returns and would otherwise arrive as one enormous line. The
    installer is also told plainly that there is no terminal here, so nothing
    it runs stops to ask a question nobody can answer.
    """

    environment = dict(os.environ)
    environment.update(
        {
            "PYTHONUNBUFFERED": "1",
            "UV_NO_PROGRESS": "1",
            "PIP_PROGRESS_BAR": "off",
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "PIP_NO_INPUT": "1",
            "UV_NO_PROMPT": "1",
        }
    )
    return environment


def validate_plan(plan: InstallPlan) -> None:
    """Fail before starting the installer, where the message can be useful.

    A requirements file that is not on disk produces an installer error the
    user cannot act on ("No such file or directory: -r"), and it is the one
    precondition worth stating in the capability's own terms.
    """

    for index, argument in enumerate(plan.argv):
        if argument == "-r" and index + 1 < len(plan.argv):
            requirements = Path(plan.argv[index + 1])
            if not requirements.is_file():
                raise InstallNotAvailableError(
                    f"The requirements file for this install is missing: "
                    f"{requirements}"
                )


def run_install(
    plan: InstallPlan,
    *,
    on_line: Callable[[str], None] | None = None,
    is_cancelled: Callable[[], bool] | None = None,
    timeout_seconds: float = INSTALL_TIMEOUT_SECONDS,
) -> tuple[int, tuple[str, ...]]:
    """Run the plan, streaming its output. Returns the exit code and a tail.

    The reader loop cannot poll for cancellation — it is blocked on the child's
    output, which a download produces nothing of for minutes at a time — so a
    watchdog thread owns stopping the process, and the loop simply ends when
    the pipe closes.
    """

    validate_plan(plan)

    cancelled = is_cancelled or (lambda: False)
    tail: list[str] = []
    deadline = time.monotonic() + timeout_seconds

    try:
        process = subprocess.Popen(  # noqa: S603 - argv is built here, no shell
            plan.argv,
            cwd=PROJECT_ROOT,
            env=_install_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            bufsize=1,
        )
    except OSError as exc:
        raise InstallFailedError(
            f"Could not start the installer ({plan.argv[0]}): {exc}"
        ) from exc

    stop_watchdog = threading.Event()
    timed_out = threading.Event()

    def watchdog() -> None:
        while not stop_watchdog.wait(_WATCHDOG_INTERVAL_SECONDS):
            expired = time.monotonic() > deadline
            if not expired and not cancelled():
                continue
            if expired:
                timed_out.set()
            process.terminate()
            # A resolver that ignores SIGTERM still has to go: the venv it is
            # writing into is the one the backend is running out of.
            if not stop_watchdog.wait(_TERMINATE_GRACE_SECONDS):
                process.kill()
            return

    watcher = threading.Thread(
        target=watchdog, name="capability-install-watchdog", daemon=True
    )
    watcher.start()

    drained = False
    try:
        assert process.stdout is not None
        for raw in process.stdout:
            line = raw.rstrip()
            if not line:
                continue
            line = line[:_MAX_LINE_LENGTH]
            tail.append(line)
            del tail[:-40]
            if on_line is not None:
                on_line(line)
        drained = True
    finally:
        stop_watchdog.set()
        if process.stdout is not None:
            process.stdout.close()
        # Leaving through an exception — a cancelled job raises from inside
        # ``on_line`` — means the watchdog has just been told to stand down
        # while the installer is still running. Nothing else would stop it, and
        # the wait below would block on it until the job's own timeout.
        # Only on that path: a drained pipe means the process is on its way
        # out, and terminating it there would turn a success into a failure.
        if not drained and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=_TERMINATE_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                process.kill()
        code = process.wait()
        watcher.join(timeout=_TERMINATE_GRACE_SECONDS + 1)

    if timed_out.is_set():
        raise InstallFailedError(
            f"The install did not finish within "
            f"{int(timeout_seconds // 60)} minutes and was stopped"
        )
    return code, tuple(tail)


def install_failure_message(code: int, tail: tuple[str, ...]) -> str:
    """What to tell the user when the installer exits non-zero.

    The last few lines rather than the first: a resolver reports the reason it
    gave up at the end, and the beginning of the log is the part that was going
    fine.
    """

    interesting = [line for line in tail[-6:] if line]
    if not interesting:
        return f"The install command exited with status {code}"
    return (
        f"The install command exited with status {code}: "
        + " / ".join(interesting)
    )


def install_target_description(plan: InstallPlan) -> str:
    """A short phrase naming what an install put into which interpreter."""

    return f"{plan.summary} ({backend_python()})"
