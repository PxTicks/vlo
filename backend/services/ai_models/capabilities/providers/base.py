"""Provider base: how a capability's evidence becomes a :class:`Capability`."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from ..contract import (
    Capability,
    CapabilityState,
    Check,
    CheckStatus,
    DeviceReport,
    FailureCode,
    VerificationStage,
    derive_state,
    derive_verified_through,
    utc_now,
)
from ..failures import get_last_failure, sanitize_message
from ..subprocess_probe import ProbeResult, ProbeSpec, probe_environment


#: What the cheap path can evaluate. ``loaded``/``operational`` are established
#: by an explicit runtime probe or a real job, never by a status request.
CHEAP_STAGES: tuple[VerificationStage, ...] = (
    VerificationStage.DISCOVERED,
    VerificationStage.ENVIRONMENT,
)


@dataclass(frozen=True)
class ProviderReport:
    """A provider's raw evidence, before it is collapsed into a state."""

    checks: tuple[Check, ...]
    expected: bool
    device: DeviceReport | None = None
    evaluated_stages: tuple[VerificationStage, ...] = CHEAP_STAGES
    selected_model: str | None = None
    models: tuple[Mapping[str, Any], ...] = ()
    loaded: bool = False


class CapabilityProvider:
    """One capability's answer to "how far has this been proven to work?"."""

    id: str = ""
    label: str = ""

    def inspect(self) -> ProviderReport:
        raise NotImplementedError

    def probe(self, spec: ProbeSpec) -> ProbeResult:
        """Run this capability's out-of-process probe, cached per capability.

        Freshness is not a parameter here: a recheck invalidates the cache at
        the registry boundary, so no code path can ask four providers to each
        re-run the same probe.
        """

        return probe_environment(self.id, spec)

    def build(self) -> Capability:
        try:
            report = self.inspect()
        except Exception as exc:  # pragma: no cover - defensive: a broken provider
            # A status endpoint that 500s teaches the user nothing. Report the
            # provider's own breakage as the capability's blocking failure.
            return Capability(
                id=self.id,
                label=self.label,
                state=CapabilityState.BLOCKED,
                checked_at=utc_now(),
                checks=(
                    Check(
                        id="provider.inspect",
                        status=CheckStatus.FAIL,
                        stage=VerificationStage.DISCOVERED,
                        code=FailureCode.RUNTIME_LOAD_FAILED,
                        summary="Could not inspect this capability",
                        detail=sanitize_message(str(exc)),
                    ),
                ),
                last_failure=get_last_failure(self.id),
            )

        state = derive_state(
            expected=report.expected,
            checks=report.checks,
            loaded=report.loaded,
            degraded=report.device.fallback if report.device else False,
        )
        return Capability(
            id=self.id,
            label=self.label,
            state=state,
            checked_at=utc_now(),
            device=report.device,
            verified_through=derive_verified_through(
                report.checks, report.evaluated_stages
            ),
            checks=tuple(report.checks),
            selected_model=report.selected_model,
            models=tuple(report.models),
            last_failure=get_last_failure(self.id),
        )
