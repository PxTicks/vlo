"""Capability registration, scoped to one extension's activation.

An extension does not write to the descriptor table. It receives a registrar
on its :class:`BackendExtensionContext` and hands descriptors to that, because
three things about a registration are the host's to decide and not the
extension's:

* **The id.** Capability ids are global. An extension supplies a local name and
  the host namespaces it, so no extension can register ``sam2`` — or collide
  with a neighbour — whatever it passes.
* **The lifetime.** A registration lasts exactly as long as the activation that
  made it. Deactivation removes the capability, its memo cell, its recorded
  failure, and its load observation.
* **Wantedness.** An active extension is the evidence that its capability is
  wanted; there is no installer marker that could say so.

The descriptor itself stays the extension's: what it needs, where it looks, how
it loads. Only identity, lifetime, and the admission rules are taken away.
"""

from __future__ import annotations

import re
import threading
from dataclasses import replace

from services.ai_models.capabilities import (
    CapabilityDescriptor,
    register_descriptor,
    unregister_descriptor,
)
from services.ai_models.capabilities.validation import (
    describe_registration_problems,
)


#: What an extension may call its own capability. Deliberately narrow: the id
#: becomes a URL path segment, a JSON key, and a camelised snapshot key.
_LOCAL_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

#: Separates the owning extension from the capability it registered.
#:
#: Not ``/``. A capability id is addressed as one path segment
#: (``/app/runtime-capabilities/{capability_id}``), and a slash splits that
#: segment however it is encoded — reads, rechecks and Test-runtime probes
#: would all 404. ``:`` is a legal path character and cannot occur in either
#: half: extension ids are ``[a-z0-9._-]`` and local ids are narrower still.
NAMESPACE_SEPARATOR = ":"


class ExtensionCapabilityError(ValueError):
    """Raised when a descriptor cannot be registered as declared."""


def namespaced_capability_id(extension_id: str, local_id: str) -> str:
    return f"{extension_id}{NAMESPACE_SEPARATOR}{local_id}"


class ExtensionCapabilityRegistrar:
    """One extension's registered capabilities, for the life of its activation."""

    def __init__(self, extension_id: str) -> None:
        self._extension_id = extension_id
        self._lock = threading.RLock()
        self._registered: list[str] = []
        self._released = False

    @property
    def extension_id(self) -> str:
        return self._extension_id

    def registered(self) -> tuple[str, ...]:
        with self._lock:
            return tuple(self._registered)

    def register(self, descriptor: CapabilityDescriptor) -> str:
        """Register one runtime capability and return its namespaced id.

        ``descriptor.id`` is the *local* name — ``"tracker"``, not
        ``"acme.tracking/tracker"``. The returned id is what
        ``/app/runtime-capabilities`` reports and what
        :func:`services.ai_models.capabilities.lazy_runtime` is keyed by.

        Raises :class:`ExtensionCapabilityError` for anything that would make
        the registration incomplete. During activation that fails the extension
        with a message carrying its name, which is the point: a capability that
        registers half-way is the failure mode this whole contract exists to
        remove.
        """

        with self._lock:
            if self._released:
                # An abandoned activation thread outlives the host's wait for
                # it, and a shutdown callback runs while the extension is going
                # away. Either could register a capability nothing would ever
                # remove, so registration ends when the activation does.
                raise ExtensionCapabilityError(
                    f"'{self._extension_id}' is no longer active, so it cannot "
                    "register capabilities"
                )

        local_id = (descriptor.id or "").strip()
        if not _LOCAL_ID.fullmatch(local_id):
            raise ExtensionCapabilityError(
                f"'{descriptor.id}' is not a usable capability name: use "
                "lowercase letters, digits and hyphens, and do not include the "
                "extension id — the host adds it"
            )

        if descriptor.app_status_key is not None:
            # ``/app/status`` is a fixed legacy payload whose keys the frontend
            # reads by name, and the field list is a dict: a second descriptor
            # claiming ``sam2`` would silently replace the host's own entry.
            raise ExtensionCapabilityError(
                "app_status_key is a host field: /app/status carries a fixed "
                "set of legacy fields, and an extension capability is read "
                "from /app/runtime-capabilities instead"
            )

        if descriptor.profile is not None:
            # Profiles are the installer's contract, and every one of them
            # installs a host requirements file. Binding to one would tell the
            # user to reinstall the backend to fix an unrelated package.
            raise ExtensionCapabilityError(
                "profile names a host installer profile, which cannot install "
                "an extension's package: declare PackageSpec.install_target "
                "instead"
            )

        if descriptor.uses_local_gpu:
            # Declaring it would advertise a guarantee that holds only on the
            # Test-runtime probe: the probe takes a real exclusive lease, while
            # an extension's own jobs are not yet admitted by the coordinator.
            # See docs/backend-extension-contract-plan.md §4.4.
            raise ExtensionCapabilityError(
                "uses_local_gpu is not available to extensions yet: extension "
                "jobs do not pass through the model-work coordinator, so the "
                "flag would claim GPU exclusion that only the load test has"
            )

        prepared = replace(
            descriptor,
            id=namespaced_capability_id(self._extension_id, local_id),
            # The host's answer, not the extension's: see the module docstring.
            always_expected=True,
        )

        problems = describe_registration_problems(prepared, run_discovery=True)
        if problems:
            raise ExtensionCapabilityError(
                f"capability '{prepared.id}' is incompletely registered: "
                + "; ".join(problems)
            )

        # Held across the table write: releasing between the check above and
        # the append below would drop a registration on the floor, leaving a
        # capability behind with nothing tracking it.
        with self._lock:
            if self._released:
                raise ExtensionCapabilityError(
                    f"'{self._extension_id}' is no longer active, so it cannot "
                    "register capabilities"
                )
            register_descriptor(prepared)
            self._registered.append(prepared.id)
        return prepared.id

    def release(self) -> None:
        """Unregister everything this activation registered.

        Called by the host on deactivation and on a failed activation. Removing
        the descriptor also drops the runtime's memo cell, its recorded failure,
        and its load observation, so nothing this extension proved outlives it.
        """

        with self._lock:
            self._released = True
            registered = tuple(self._registered)
            self._registered.clear()
        for capability_id in reversed(registered):
            unregister_descriptor(capability_id)

    @property
    def released(self) -> bool:
        return self._released


__all__ = [
    "NAMESPACE_SEPARATOR",
    "ExtensionCapabilityError",
    "ExtensionCapabilityRegistrar",
    "namespaced_capability_id",
]
