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
            # How far the evidence actually goes is read off the checks: a
            # stage with a skipped check was not evaluated, so verification
            # stops below it.
            verified_through=derive_verified_through(report.checks),
            checks=tuple(report.checks),
            selected_model=report.selected_model,
            models=tuple(report.models),
            last_failure=get_last_failure(self.id),
        )
