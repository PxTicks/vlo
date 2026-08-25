"""Legacy readiness fields, derived from the runtime-capability contract.

``/app/status`` and each feature's ``/health`` route predate the capability
registry and are still what the current frontend reads. They now answer from
the same evidence the capability cards do, so there is exactly one definition
of "available" in the backend: ``canAttempt``.

Two properties matter here:

* **Availability is never inferred from inventory.** The old adapter reported
  ``available`` when a model file existed, which is discovery — the weakest
  possible signal — counted twice. A checkpoint on disk with no package
  installed is now ``unavailable`` with the real reason attached.
* **Nothing on these paths spawns or imports.** Every lookup runs with
  ``deep_probe=False``: static checks plus whatever probe result the
  diagnostics view already warmed. ``/app/status`` is on the startup path.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from services.ai_models.capabilities import (
    Capability,
    Check,
    CheckStatus,
    get_capability,
    sanitize_message,
)


def _first_failure(capability: Capability) -> Check | None:
    """The check that best explains why a capability cannot be attempted.

    Checks are ordered cheapest-stage-first, so the first failure is the most
    fundamental one — a missing model before a missing package before a
    device problem.
    """

    for check in capability.checks:
        if check.status is CheckStatus.FAIL:
            return check
    return None


def capability_runtime_health(capability_id: str) -> dict[str, Any]:
    """Readiness fields for a feature's legacy ``runtime`` payload.

    ``error`` is finally populated: it used to be a key nothing ever set, so
    every SAM-Audio failure rendered as the static string "No SAM-Audio model
    configured" no matter what was actually wrong.
    """

    try:
        capability = get_capability(capability_id, deep_probe=False)
    except Exception as exc:  # pragma: no cover - defensive health fallback
        return {
            "ready": False,
            "state": "blocked",
            "verifiedThrough": None,
            "error": sanitize_message(str(exc)),
            "code": None,
        }

    if capability is None:  # pragma: no cover - registry/id mismatch
        return {
            "ready": False,
            "state": "unavailable",
            "verifiedThrough": None,
            "error": f"Unknown runtime capability '{capability_id}'",
            "code": None,
        }

    failure = _first_failure(capability)
    return {
        "ready": capability.can_attempt,
        "state": capability.state.value,
        "verifiedThrough": (
            capability.verified_through.value if capability.verified_through else None
        ),
        "error": failure.summary if failure is not None else None,
        "code": failure.code.value if failure is not None and failure.code else None,
    }


@dataclass(frozen=True)
class AppStatusProvider:
    """One capability's ``/app/status`` field.

    ``available`` iff ``canAttempt`` — the single gate every surface shares.
    """

    response_key: str
    capability_id: str
    unavailable_message: str

    def to_app_status(self) -> dict[str, str | None]:
        try:
            capability = get_capability(self.capability_id, deep_probe=False)
        except Exception as exc:  # pragma: no cover - defensive status fallback
            return {"status": "unavailable", "error": sanitize_message(str(exc))}

        if capability is None:  # pragma: no cover - registry/id mismatch
            return {"status": "unavailable", "error": self.unavailable_message}

        if capability.can_attempt:
            return {"status": "available", "error": None}

        failure = _first_failure(capability)
        return {
            "status": "unavailable",
            "error": failure.summary if failure is not None else self.unavailable_message,
        }
