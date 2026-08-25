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
    FailureRecord,
    Remediation,
    VerificationStage,
    derive_state,
    derive_verified_through,
    utc_now,
)
from ..failures import get_last_failure, is_durable, sanitize_message
from ..subprocess_probe import (
    ModuleProbe,
    ProbeResult,
    ProbeSpec,
    cached_probe,
    probe_environment,
)


def probed_module(probe: ProbeResult | None, name: str) -> ModuleProbe | None:
    """One module's out-of-process result, or ``None`` when no probe ran.

    ``None`` means the import was never attempted — neither a pass nor a
    failure. The check downgrades to ``skipped`` on it, which is what keeps an
    unexamined package from reading as a healthy one.
    """

    return probe.module(name) if probe is not None else None


@dataclass(frozen=True)
class ProviderReport:
    """A provider's raw evidence, before it is collapsed into a state."""

    checks: tuple[Check, ...]
    expected: bool
    device: DeviceReport | None = None
    selected_model: str | None = None
    models: tuple[Mapping[str, Any], ...] = ()
    loaded: bool = False


class CapabilityProvider:
    """One capability's answer to "how far has this been proven to work?"."""

    id: str = ""
    label: str = ""

    def inspect(self, *, deep_probe: bool = True) -> ProviderReport:
        raise NotImplementedError

    def remediation_for(self, code: FailureCode) -> Remediation | None:
        """What to do about a failure a real load reported.

        A recorded failure arrives with a code but no remedy — the load path
        does not know how this capability is installed. The provider does.
        """

        return None

    def probe(
        self,
        spec: ProbeSpec,
        *,
        deep_probe: bool = True,
    ) -> ProbeResult | None:
        """This capability's out-of-process probe, cached per capability.

        Freshness is not a parameter here: a recheck invalidates the cache at
        the registry boundary, so no code path can ask four providers to each
        re-run the same probe.

        ``deep_probe=False`` promises never to spawn: it returns the last
        result for this key if there is one — stale or not, since an observed
        failure does not stop being true — and ``None`` otherwise, which marks
        the import checks unevaluated rather than passed.
        """

        if deep_probe:
            return probe_environment(self.id, spec)
        return cached_probe(self.id, spec)

    def build(self, *, deep_probe: bool = True) -> Capability:
        try:
            report = self.inspect(deep_probe=deep_probe)
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

        # A real load attempt outranks any static check: if the runtime failed
        # for a reason that will not fix itself, the capability is blocked
        # whatever the filesystem says. Cleared by a successful load or an
        # explicit recheck.
        last_failure = get_last_failure(self.id)
        checks = tuple(report.checks)
        if last_failure is not None and is_durable(last_failure.code):
            # Put the direct runtime evidence first. Consumers that need one
            # explanation should cite what the real attempt proved, not an
            # incidental inventory failure found by the later status read.
            checks = (self._failure_check(last_failure), *checks)

        state = derive_state(
            # A real attempt is direct evidence that the capability is wanted,
            # even if inventory no longer finds either half of an optional
            # install. In particular, a durable load failure must be blocked,
            # not collapsed back to "intentionally unavailable".
            expected=report.expected or last_failure is not None,
            checks=checks,
            loaded=report.loaded,
            degraded=report.device.fallback if report.device else False,
        )
        return Capability(
            id=self.id,
            label=self.label,
            state=state,
            checked_at=utc_now(),
            device=report.device,
            # How far the evidence actually goes is read off the checks: a
            # stage with a skipped check was not evaluated, so verification
            # stops below it.
            verified_through=derive_verified_through(checks),
            checks=checks,
            selected_model=report.selected_model,
            models=tuple(report.models),
            last_failure=last_failure,
        )

    def _failure_check(self, failure: FailureRecord) -> Check:
        return Check(
            id="runtime.lastFailure",
            status=CheckStatus.FAIL,
            stage=failure.stage,
            code=failure.code,
            summary=failure.summary,
            detail=failure.detail,
            remediation=self.remediation_for(failure.code),
        )
