"""Restarting the backend from inside it, and knowing when that is needed.

Installing a Python package into the environment a running process is already
importing from does not make the process able to use it. Some of the time it
would work — a package that was never imported can be imported now — but not
reliably enough to tell a user it did: an extension module compiled against a
different ABI, a dependency whose version just moved under an already-imported
package, a namespace package that resolved to nothing at startup. So an install
declares that a restart is required, and this module owns both halves of that:
the ledger of what is waiting for one, and the restart itself.

The restart is a re-exec, not a graceful shutdown-and-start: nothing outside
the process supervises it, so the process has to become the new one. That makes
it destructive to anything in flight, which is why it is refused while the GPU
ledger has work on it — losing a running export or segmentation to a restart
that could have waited a minute is not a trade the user was offered.

Whether a re-exec is even possible is a property of how the process was
launched, and it is reported rather than assumed: a supervised container, a
frozen build, or a deployment that sets ``VLO_DISABLE_INPROCESS_RESTART`` all
degrade to telling the user to restart it themselves.
"""

from __future__ import annotations

import logging
import multiprocessing
import os
import sys
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


logger = logging.getLogger(__name__)

#: Identifies this process to a client waiting for a restart to complete.
#: A client that sees a different id has reached a genuinely new process; a
#: client that sees the same one is talking to the process it asked to restart,
#: which has not gone anywhere.
INSTANCE_ID = uuid.uuid4().hex

#: Set to disable the in-app restart where something else owns the process.
DISABLE_ENV_VAR = "VLO_DISABLE_INPROCESS_RESTART"

#: How long to wait before re-execing, so the HTTP response reaches the client
#: that asked for it. The client is polling for a new instance id, so this only
#: has to outlast the response, not the poll.
RESTART_DELAY_SECONDS = 0.75


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class RestartReason:
    """One thing that is waiting for a restart to take effect."""

    id: str
    label: str
    summary: str
    noted_at: datetime

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "summary": self.summary,
            "notedAt": _iso(self.noted_at),
        }


class RestartLedger:
    """What has asked for a restart since this process started.

    Deliberately in memory only. The whole record describes a difference
    between this process and the environment on disk, and a restart is exactly
    what makes that difference go away — persisting it would mean writing a
    file whose only purpose is to be wrong after the next start.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._reasons: dict[str, RestartReason] = {}

    def note(self, reason_id: str, *, label: str, summary: str) -> RestartReason:
        reason = RestartReason(
            id=reason_id, label=label, summary=summary, noted_at=_utc_now()
        )
        with self._lock:
            self._reasons[reason_id] = reason
        return reason

    def clear(self, reason_id: str | None = None) -> None:
        with self._lock:
            if reason_id is None:
                self._reasons.clear()
            else:
                self._reasons.pop(reason_id, None)

    def reasons(self) -> tuple[RestartReason, ...]:
        with self._lock:
            return tuple(
                sorted(self._reasons.values(), key=lambda reason: reason.noted_at)
            )

    def requires_restart(self, reason_id: str) -> bool:
        with self._lock:
            return reason_id in self._reasons


_LEDGER = RestartLedger()


def note_restart_required(reason_id: str, *, label: str, summary: str) -> None:
    _LEDGER.note(reason_id, label=label, summary=summary)


def clear_restart_required(reason_id: str | None = None) -> None:
    _LEDGER.clear(reason_id)


def restart_reasons() -> tuple[RestartReason, ...]:
    return _LEDGER.reasons()


def requires_restart(reason_id: str) -> bool:
    return _LEDGER.requires_restart(reason_id)


def _relaunch_argv() -> list[str] | None:
    """The command that would start this process again, or ``None``.

    ``sys.argv`` does not record ``-m``: a process started as ``python -m
    uvicorn`` has the path of uvicorn's ``__main__.py`` as ``argv[0]``, and
    re-execing that runs a module as a loose script. The ``__main__`` spec is
    what remembers, so the module form is reconstructed from it where it
    exists.
    """

    executable = sys.executable
    if not executable or not os.path.isfile(executable):
        return None

    spec = getattr(sys.modules.get("__main__"), "__spec__", None)
    module = getattr(spec, "parent", None) or getattr(spec, "name", None)
    if module:
        return [executable, "-m", module, *sys.argv[1:]]
    if not sys.argv or not sys.argv[0]:
        return None
    return [executable, *sys.argv]


def restart_unsupported_reason() -> str | None:
    """Why this process must not re-exec itself, or ``None``.

    The subtle case is a **supervised child**. Under ``--reload`` (and under
    ``--workers``) the process serving this request is a spawned child: the
    listening socket belongs to the supervisor, and ``sys.argv`` still says
    ``--reload``. Re-execing the child would start a *second* supervisor that
    cannot bind the port, leaving the client waiting for an instance id that
    never changes. ``multiprocessing`` is what knows the difference — the
    ``__main__`` spec does not survive the spawn, so it cannot be read off the
    launch command.
    """

    if os.environ.get(DISABLE_ENV_VAR, "").strip().lower() in {"1", "true", "yes"}:
        return f"In-app restart is disabled here ({DISABLE_ENV_VAR})."
    if multiprocessing.current_process().name != "MainProcess":
        return (
            "This backend runs under a supervisor (uvicorn --reload, or "
            "--workers), which owns the port. Restart the server itself."
        )
    if "--reload" in sys.argv:
        # Belt and braces: a reloader that ever ran in-process would be the
        # same hazard without the spawned child to give it away.
        return (
            "This backend was started with --reload. Restart the dev server "
            "instead; it reloads code on its own."
        )
    if _relaunch_argv() is None:
        return (
            "This backend cannot name the command that started it, so it "
            "cannot start itself again."
        )
    return None


def restart_supported() -> bool:
    return restart_unsupported_reason() is None


def restart_blocker() -> str | None:
    """Why a restart must not happen right now, or ``None``.

    A re-exec takes the process's work with it, and the GPU ledger is the one
    place that knows whether any of that work is real. Read defensively: a
    coordinator that cannot answer is not a reason to refuse, since it is also
    not evidence that anything is running.
    """

    installing = _installing_capability_ids()
    if installing:
        # Nothing about a re-exec is graceful: the installer is a child of this
        # process, writing into the environment this process runs from. Losing
        # it halfway is how a venv ends up with a half-unpacked distribution.
        return (
            f"An install is still running ({', '.join(sorted(installing))}). "
            "Restarting now could leave the environment half-written."
        )

    try:
        from services.model_work import get_model_work_coordinator

        snapshot = get_model_work_coordinator().snapshot()
    except Exception:  # pragma: no cover - never block on a broken read
        logger.debug("Could not read model-work occupancy before restart", exc_info=True)
        return None

    active = [
        entry
        for entry in snapshot.entries
        if entry.job_status in {"queued", "running"}
    ]
    if not active:
        return None

    labels = ", ".join(sorted({entry.label for entry in active})[:3])
    plural = "jobs are" if len(active) > 1 else "job is"
    return (
        f"{len(active)} GPU {plural} still running ({labels}). "
        "Restarting now would cancel them."
    )


def _installing_capability_ids() -> tuple[str, ...]:
    """Deferred import: the install jobs import this module to record a reason."""

    try:
        from services.ai_models.capabilities.install_jobs import (
            active_install_capability_ids,
        )

        return active_install_capability_ids()
    except Exception:  # pragma: no cover - a broken read is not a green light
        logger.warning(
            "Could not read install activity before restart; refusing",
            exc_info=True,
        )
        return ("unknown",)


def restart_state() -> dict[str, Any]:
    """Everything a client needs to decide what to offer, in one read."""

    reasons = restart_reasons()
    unsupported = restart_unsupported_reason()
    return {
        "instanceId": INSTANCE_ID,
        "restartRequired": bool(reasons),
        "reasons": [reason.to_json() for reason in reasons],
        "restartSupported": unsupported is None,
        "restartUnsupportedReason": unsupported,
        "blockedReason": restart_blocker(),
    }


class RestartNotSupportedError(RuntimeError):
    """This process cannot restart itself."""


class RestartBlockedError(RuntimeError):
    """Something is in flight that a restart would destroy."""


def request_restart(*, force: bool = False) -> dict[str, Any]:
    """Schedule a re-exec, after the response to this request has been sent.

    Returns the state a client should compare against: the ``instanceId`` here
    is the *old* one, and the restart is complete when a poll comes back with a
    different id.
    """

    unsupported = restart_unsupported_reason()
    argv = _relaunch_argv()
    if unsupported is not None or argv is None:
        raise RestartNotSupportedError(
            f"{unsupported or 'This backend cannot restart itself.'} "
            "Stop it and start it again — on a managed deployment, restart "
            "the service."
        )

    if not force:
        blocker = restart_blocker()
        if blocker is not None:
            raise RestartBlockedError(blocker)

    logger.warning("Restarting the vlo backend on request: %s", " ".join(argv))

    def relaunch() -> None:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:  # pragma: no cover - flushing a closed stream
            pass
        try:
            os.execv(argv[0], argv)
        except OSError:  # pragma: no cover - exec failure leaves us running
            logger.exception("The vlo backend could not restart itself")

    timer = threading.Timer(RESTART_DELAY_SECONDS, relaunch)
    timer.name = "vlo-restart"
    timer.daemon = True
    timer.start()

    return {
        "restarting": True,
        "instanceId": INSTANCE_ID,
        "delaySeconds": RESTART_DELAY_SECONDS,
    }
