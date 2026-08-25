"""The runtime-capability contract.

A capability answers one question honestly: *how far has this feature actually
been proven to work?* The answer is staged — file discovery is cheap and proves
little, a successful model load is expensive and proves a lot — so the payload
reports the highest stage that has genuinely passed rather than one ambiguous
``ready`` boolean.

Everything here is pure data. Providers build these objects; the router
serialises them. No probing lives in this module.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class FailureCode(str, Enum):
    """The closed set of machine-readable failure causes.

    The frontend switches on these, so the set is closed on purpose: an
    unrecognised runtime failure classifies as ``RUNTIME_LOAD_FAILED`` rather
    than inventing a new code, which keeps every consumer's switch total.
    """

    PYTHON_VERSION_UNSUPPORTED = "python_version_unsupported"
    PACKAGE_MISSING = "package_missing"
    PACKAGE_IMPORT_FAILED = "package_import_failed"
    DEPENDENCY_INCOMPATIBLE = "dependency_incompatible"
    DEPENDENCY_DOWNLOAD_FAILED = "dependency_download_failed"
    MODEL_MISSING = "model_missing"
    MODEL_INVALID = "model_invalid"
    CONFIG_MISSING = "config_missing"
    OUT_OF_MEMORY = "out_of_memory"
    RUNTIME_LOAD_FAILED = "runtime_load_failed"
    DEVICE_UNAVAILABLE = "device_unavailable"
    CACHE_UNWRITABLE = "cache_unwritable"
    AUTHENTICATION_REQUIRED = "authentication_required"


class CheckStatus(str, Enum):
    PASS = "pass"
    WARN = "warn"
    FAIL = "fail"
    SKIPPED = "skipped"


class VerificationStage(str, Enum):
    """Stages in increasing order of what they actually establish."""

    DISCOVERED = "discovered"
    ENVIRONMENT = "environment"
    LOADED = "loaded"
    OPERATIONAL = "operational"


#: Stage precedence. ``verifiedThrough`` walks this in order and stops at the
#: first stage that either failed or has not been evaluated yet.
STAGE_ORDER: tuple[VerificationStage, ...] = (
    VerificationStage.DISCOVERED,
    VerificationStage.ENVIRONMENT,
    VerificationStage.LOADED,
    VerificationStage.OPERATIONAL,
)


class CapabilityState(str, Enum):
    UNAVAILABLE = "unavailable"
    BLOCKED = "blocked"
    AVAILABLE_UNVERIFIED = "available_unverified"
    READY = "ready"
    DEGRADED = "degraded"
    CHECKING = "checking"


#: The states in which starting a job is reasonable. Feature UIs gate on the
#: derived ``canAttempt`` field instead of re-deriving this set per call site.
ATTEMPTABLE_STATES: frozenset[CapabilityState] = frozenset(
    {
        CapabilityState.AVAILABLE_UNVERIFIED,
        CapabilityState.READY,
        CapabilityState.DEGRADED,
    }
)


class RemediationKind(str, Enum):
    COMMAND = "command"
    DOWNLOAD = "download"
    SETTINGS = "settings"
    DOCS = "docs"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class Remediation:
    """What the user can actually do about a failed check."""

    kind: RemediationKind
    summary: str
    command: str | None = None
    url: str | None = None
    requires_restart: bool = False

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "kind": self.kind.value,
            "summary": self.summary,
            "requiresRestart": self.requires_restart,
        }
        if self.command is not None:
            payload["command"] = self.command
        if self.url is not None:
            payload["url"] = self.url
        return payload


@dataclass(frozen=True)
class Check:
    """One verifiable statement about a capability's environment."""

    id: str
    status: CheckStatus
    summary: str
    stage: VerificationStage = VerificationStage.ENVIRONMENT
    code: FailureCode | None = None
    detail: str | None = None
    remediation: Remediation | None = None

    @property
    def failed(self) -> bool:
        return self.status is CheckStatus.FAIL

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "status": self.status.value,
            "stage": self.stage.value,
            "summary": self.summary,
        }
        if self.code is not None:
            payload["code"] = self.code.value
        if self.detail is not None:
            payload["detail"] = self.detail
        if self.remediation is not None:
            payload["remediation"] = self.remediation.to_json()
        return payload


@dataclass(frozen=True)
class FailureRecord:
    """The last real failure observed for a capability.

    Populated by the probe path and (from the rollout's later step) by real
    load attempts, so a probe and a genuine failure can never disagree about
    what went wrong.
    """

    code: FailureCode
    summary: str
    stage: VerificationStage
    occurred_at: datetime = field(default_factory=utc_now)
    detail: str | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "code": self.code.value,
            "summary": self.summary,
            "stage": self.stage.value,
            "occurredAt": _iso(self.occurred_at),
        }
        if self.detail is not None:
            payload["detail"] = self.detail
        return payload


@dataclass(frozen=True)
class DeviceReport:
    """Requested vs. resolved compute device.

    ``resolved`` is the device the runtime is actually on when it has loaded;
    before that it is the device this configuration is expected to resolve to,
    with ``proven`` saying which of the two you are looking at.
    """

    requested: str
    resolved: str | None = None
    proven: bool = False
    fallback: bool = False

    def to_json(self) -> dict[str, Any]:
        return {
            "requested": self.requested,
            "resolved": self.resolved,
            "proven": self.proven,
            "fallback": self.fallback,
        }


@dataclass(frozen=True)
class Capability:
    id: str
    label: str
    state: CapabilityState
    checked_at: datetime
    # ``None`` for capabilities that do not run on a local device at all, such
    # as an external ComfyUI server.
    device: DeviceReport | None = None
    verified_through: VerificationStage | None = None
    checks: tuple[Check, ...] = ()
    selected_model: str | None = None
    models: tuple[Mapping[str, Any], ...] = ()
    last_failure: FailureRecord | None = None

    @property
    def can_attempt(self) -> bool:
        return self.state in ATTEMPTABLE_STATES

    def failed_checks(self) -> tuple[Check, ...]:
        return tuple(check for check in self.checks if check.failed)

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "state": self.state.value,
            "canAttempt": self.can_attempt,
            "verifiedThrough": (
                self.verified_through.value if self.verified_through else None
            ),
            "checkedAt": _iso(self.checked_at),
            "selectedModel": self.selected_model,
            "device": self.device.to_json() if self.device is not None else None,
            "models": [dict(model) for model in self.models],
            "checks": [check.to_json() for check in self.checks],
            "lastFailure": (
                self.last_failure.to_json() if self.last_failure else None
            ),
        }


def derive_verified_through(
    checks: Iterable[Check],
    evaluated_stages: Sequence[VerificationStage],
) -> VerificationStage | None:
    """Highest stage that was both evaluated and free of failures.

    A stage that was never evaluated stops the walk just like a failing one:
    "not checked" is not "passed".
    """

    checks = tuple(checks)
    evaluated = set(evaluated_stages)
    verified: VerificationStage | None = None
    for stage in STAGE_ORDER:
        if stage not in evaluated:
            break
        if any(check.failed and check.stage is stage for check in checks):
            break
        verified = stage
    return verified


def derive_state(
    *,
    expected: bool,
    checks: Iterable[Check],
    loaded: bool = False,
    degraded: bool = False,
) -> CapabilityState:
    """Collapse the evidence into the single top-level state.

    ``expected`` is the provider's answer to "did the user ask for this
    feature at all" — an optional capability nobody installed is
    ``unavailable``, not ``blocked``. Only once a feature is wanted does a
    failing requirement become a problem worth reporting.
    """

    if not expected:
        return CapabilityState.UNAVAILABLE
    if any(check.failed for check in checks):
        return CapabilityState.BLOCKED
    if degraded:
        return CapabilityState.DEGRADED
    if loaded:
        return CapabilityState.READY
    return CapabilityState.AVAILABLE_UNVERIFIED
