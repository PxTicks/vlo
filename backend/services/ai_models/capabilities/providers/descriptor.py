"""The provider a descriptor builds.

One class serves every local model runtime. It contributes nothing of its own
beyond assembling the pieces in the order the reporting surfaces depend on:
the capability's bespoke discovery first, then the derived environment checks.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from ..contract import FailureCode, Remediation
from ..descriptors import CapabilityDescriptor, Discovery, resolve_ref
from ..environment_checks import (
    build_environment_checks,
    package_install_remediation,
    probe_spec_for,
)
from ..profiles import capability_was_requested, get_profile
from ..runtimes import lazy_runtime
from .base import CapabilityProvider, ProviderReport


#: Failures an install command can actually repair.
_INSTALL_CODES = frozenset(
    {
        FailureCode.PACKAGE_MISSING,
        FailureCode.PACKAGE_IMPORT_FAILED,
        FailureCode.DEPENDENCY_INCOMPATIBLE,
    }
)

#: Failures no install command can repair, because the model is the problem.
_MODEL_CODES = frozenset({FailureCode.MODEL_MISSING, FailureCode.MODEL_INVALID})


class DescriptorProvider(CapabilityProvider):
    """A capability registered by :class:`~..descriptors.CapabilityDescriptor`."""

    def __init__(self, descriptor: CapabilityDescriptor) -> None:
        self.descriptor = descriptor
        self.id = descriptor.id
        self.label = descriptor.label
        self.uses_local_gpu = descriptor.uses_local_gpu

    def inspect(self, *, deep_probe: bool = True) -> ProviderReport:
        descriptor = self.descriptor
        spec = probe_spec_for(descriptor)
        probe = self.probe(spec, deep_probe=deep_probe) if spec is not None else None

        discovery = self._discover()
        environment = build_environment_checks(
            descriptor, probe=probe, deep_probe=deep_probe
        )

        return ProviderReport(
            checks=(*discovery.checks, *environment.checks),
            expected=self._expected(discovery, environment.package_present),
            device=environment.device,
            selected_model=discovery.selected_model,
            models=discovery.models,
        )

    def remediation_for(self, code: FailureCode) -> Remediation | None:
        # A failure reported by a real load carries no remedy of its own: the
        # load path does not know how this capability is installed, and the
        # descriptor does.
        if code in _INSTALL_CODES:
            return package_install_remediation(self.descriptor)
        if code in _MODEL_CODES:
            return self.descriptor.download_remediation
        return None

    def load_runtime(
        self,
        report_progress: Callable[[float, str], None] | None = None,
    ) -> Mapping[str, Any]:
        # The same cell real work loads through, so the probe cannot reach a
        # different conclusion than a genuine request would.
        cell = lazy_runtime(self.id)
        cell.get(on_progress=report_progress)
        return {"resolvedDevice": cell.resolved_device}

    def _discover(self) -> Discovery:
        """The one genuinely bespoke stage, resolved on demand.

        Deferred import: discovery reaches into a service module, and this
        provider is built on the ``/app/status`` startup path.
        """

        reference = self.descriptor.discover_models
        if reference is None:
            return Discovery()
        return resolve_ref(reference)(self.descriptor)

    def _expected(self, discovery: Discovery, package_present: bool) -> bool:
        """Did the user ask for this feature at all?

        An optional capability nobody installed is ``unavailable``, not
        ``blocked``; it counts as wanted once any one of three things is true —
        a model is on the machine, the package is installed (even if it is
        broken, which is wanted-and-broken rather than deliberately absent), or
        the installer was asked for it and never managed to finish.

        A capability in a non-optional profile is always wanted, so a missing
        package there is a broken install rather than a declined feature. So is
        one an extension registered: an approved, running extension is itself
        the evidence, and there is no installer marker that could say so.
        """

        if self.descriptor.always_expected:
            return True

        profile = (
            get_profile(self.descriptor.profile)
            if self.descriptor.profile is not None
            else None
        )
        if profile is not None and not profile.optional:
            return True
        return (
            discovery.found
            or package_present
            or capability_was_requested(self.descriptor.id)
        )


__all__ = ["DescriptorProvider"]
