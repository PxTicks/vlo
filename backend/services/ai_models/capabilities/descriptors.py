"""What a local model runtime declares about itself.

A capability used to be registered by hand in nine places — a provider class, a
package ``__init__``, the registry tuple, three lists in the environment
snapshot, a profile row, an ``/app/status`` entry, and a ``record_load_failures``
call somewhere inside the service's loader. Nothing checked that you did all
nine, and the one that mattered most was the one nothing could check: a service
that simply forgot to wrap its loader looked perfectly healthy while quietly
never learning about a real failure.

A descriptor replaces the first eight with data, and the registry-owned lazy
runtime (:mod:`.runtimes`) removes the ninth by owning the load boundary.

Everything here is pure data. Two fields — ``loader`` and ``discover_models`` —
name a callable as a ``"module:attr"`` string rather than importing it, because
this table is read on the ``/app/status`` startup path and a direct import would
drag an optional ML dependency graph into the serving process.

Not every capability fits: ComfyUI has no package to probe, no local device, no
model files, and a reachability test rather than a load. It keeps a hand-written
:class:`~.providers.base.CapabilityProvider`, which stays a supported way to
register. The descriptor is a convenience for local model runtimes, not the only
permitted shape.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from importlib import import_module
from pathlib import Path
from typing import Any, Union

from .contract import Check, Remediation


#: Every separator a capability id may use, folded when camelising.
_ID_SEPARATORS = re.compile(r"[-._/:]+")


@dataclass(frozen=True)
class FromConfig:
    """A value read from the ``config`` module by attribute name, at call time.

    The host's own capabilities are configured through ``config``, whose values
    are rebindable — tests point them at temporary directories, and a
    reconfiguration must be seen rather than baked in when this table is
    imported. Naming the attribute instead of importing it keeps the descriptor
    table free of ``config``, which creates directories at import.

    An extension has nothing in ``config`` and must not write to it, so it
    supplies its own values directly. See :data:`ValueSource`.
    """

    attribute: str


#: A callable a descriptor names: a ``"module:attr"`` string resolved on
#: demand, or the callable itself when the owner already holds it.
Reference = Union[str, Callable[..., Any]]

#: How a descriptor supplies a value that is not known when the table is built:
#: a literal, a zero-argument callable for something the owner recomputes, or a
#: :class:`FromConfig` reference for the host's own configuration.
ValueSource = Union[FromConfig, Callable[[], Any], Any]


@dataclass(frozen=True)
class PackageSpec:
    """One Python package a capability needs, and how to look for it.

    ``module`` is the top-level name ``find_spec`` looks up; ``import_target``
    is what the out-of-process probe actually imports, which is sometimes a
    submodule. SAM2 is the reason: the installer clones ``backend/sam2``, so a
    bare ``import sam2`` succeeds as an empty namespace package even when
    nothing was installed into the venv.
    """

    module: str
    distribution: str | None = None
    #: Submodule the subprocess probe imports; defaults to ``module``.
    import_target: str | None = None
    minimum_version: str | None = None
    #: An optional extra enables a feature rather than gating the capability,
    #: so its absence is a warning and never blocks.
    optional: bool = False
    #: What an optional package buys, phrased into its check summary.
    feature: str | None = None
    #: ``uv pip install`` target for a package no installer profile covers —
    #: an optional extra like madmom, and every package an extension brings,
    #: since the host ships no requirements file for one. Takes precedence over
    #: the descriptor's profile, being the more specific statement.
    install_target: str | None = None
    #: Imperative summary for that command; defaults to "Install <module>".
    install_summary: str | None = None

    @property
    def probe_target(self) -> str:
        return self.import_target or self.module

    @property
    def check_id(self) -> str:
        return f"package.{self.module}"

    @property
    def report_name(self) -> str:
        """The name this package is reported under in the environment snapshot."""

        return self.distribution or self.module


@dataclass(frozen=True)
class DirectorySpec:
    """A directory the capability owns, for the snapshot and (usually) a check.

    ``check_id`` of ``None`` puts the directory in the environment snapshot
    without asserting anything about it — a model directory is inventory, and
    the discovery stage already reports whether the models are there.

    ``path`` is a :data:`ValueSource`. A declared directory that cannot be
    resolved is a broken descriptor, not an absent directory: it fails the
    completeness sweep and reports a failing check at runtime rather than
    quietly disappearing from the capability's evidence.
    """

    id: str
    path: ValueSource
    label: str
    check_id: str | None = "cache.directory"
    require_writable: bool = True


@dataclass(frozen=True)
class SearchPathSpec:
    """Where a capability looks for its models, for the environment snapshot.

    ``paths`` resolves to a sequence of directories rather than a single one.
    """

    paths: ValueSource


@dataclass(frozen=True)
class DeviceSpec:
    """The compute device this capability is configured to use.

    ``env_var`` names the setting in remediation text ("Set SAM2_DEVICE=auto").
    It defaults to the ``config`` attribute when ``requested`` is a
    :class:`FromConfig`, because the host's device attributes are read from the
    environment variable of the same name.
    """

    requested: ValueSource
    env_var: str | None = None

    @property
    def setting_name(self) -> str:
        if self.env_var is not None:
            return self.env_var
        if isinstance(self.requested, FromConfig):
            return self.requested.attribute
        return "the configured device"


@dataclass(frozen=True)
class SysPathSpec:
    """Paths a service adds to ``sys.path`` before importing its package.

    Without these the presence check would report a package as missing that the
    real load path resolves perfectly well — from ``SAM2_PYTHONPATH``, from a
    sibling source checkout, or from the backend root.
    """

    #: Environment variable holding an explicit path, searched first.
    env_var: str | None = None
    #: The backend package root, where ``config`` and ``services`` live.
    include_backend_root: bool = False
    #: Directories under the user's home, such as a ``~/sam-audio`` checkout.
    home_relative: tuple[str, ...] = ()

    def resolve(self, backend_root: Path) -> tuple[str, ...]:
        paths: list[str] = []
        if self.env_var:
            explicit = os.environ.get(self.env_var, "").strip()
            if explicit:
                paths.append(explicit)
        if self.include_backend_root:
            paths.append(str(backend_root))
        paths.extend(str(Path.home() / name) for name in self.home_relative)
        return tuple(paths)


@dataclass(frozen=True)
class Discovery:
    """What a capability's bespoke model discovery found.

    This is the one stage that is genuinely different per capability and it is
    deliberately not flattened: SAM2 resolves loose checkpoints plus a Hydra
    config, SAM-Audio wants two named files in a directory, Beat This! inspects
    a ``torch.hub`` cache. Everything around it is derived from the descriptor.

    ``found`` answers "is a model for this capability on the machine" — one of
    the three ways an optional capability counts as wanted.
    """

    checks: tuple[Check, ...] = ()
    models: tuple[Mapping[str, Any], ...] = ()
    selected_model: str | None = None
    found: bool = False


@dataclass(frozen=True)
class CapabilityDescriptor:
    """Everything the registry needs to know to register a local runtime."""

    id: str
    label: str

    # Install and remediation
    #: Profile id from :mod:`.profiles`, or ``None`` for a capability no
    #: installer step covers.
    profile: str | None = None
    packages: tuple[PackageSpec, ...] = ()

    # Environment stage — entirely declarative
    python_min: tuple[int, int] | None = None
    device: DeviceSpec | None = None
    cache_dirs: tuple[DirectorySpec, ...] = ()
    search_paths: tuple[SearchPathSpec, ...] = ()
    sys_path: SysPathSpec = field(default_factory=SysPathSpec)
    #: Modules the real load path fakes when absent; the probe stubs them too,
    #: so an importability check answers the same question the service does.
    import_stubs: tuple[str, ...] = ()

    # Legacy surface
    app_status_key: str | None = None
    unavailable_message: str = ""

    # Behaviour
    #: Whether this capability counts as wanted whatever is installed, which is
    #: ``derive_state``'s ``expected``. A host capability earns it by being in a
    #: non-optional install profile. An extension's capability earns it by the
    #: extension being active — that *is* the user asking for the feature — so
    #: the registrar sets it and an absent package reads as a broken install
    #: rather than a feature nobody wanted.
    always_expected: bool = False
    uses_local_gpu: bool = False
    #: The factory that builds the runtime. The registry wraps it in the lazy
    #: cell, so there is no unrecorded way to load it.
    loader: Reference | None = None
    #: ``(descriptor) -> Discovery``.
    discover_models: Reference | None = None
    #: An exception class that means "cancelled", which is not a failure and
    #: must pass through the load boundary unrecorded.
    cancel_exception: Reference | None = None
    #: Offered for a model-shaped failure, which no install command can fix.
    download_remediation: Remediation | None = None

    @property
    def primary_package(self) -> PackageSpec | None:
        """The package whose absence means the capability cannot run at all."""

        for package in self.packages:
            if not package.optional:
                return package
        return None

    @property
    def snapshot_key(self) -> str:
        """This capability's key in the environment snapshot's ``searchPaths``.

        ``sam-audio`` → ``samAudio``, matching the camelCase the rest of the
        payload uses. Extension ids are namespaced (``acme.tracking``), so every
        separator a capability id can carry is folded, not just the hyphen —
        otherwise a dotted id leaks a ``.`` into a payload key.

        Two ids differing only in their separators collapse to one key.
        Registration rejects that collision rather than letting one capability's
        search paths overwrite another's.
        """

        parts = [part for part in _ID_SEPARATORS.split(self.id) if part]
        if not parts:
            return self.id
        head, *rest = parts
        return head + "".join(part[:1].upper() + part[1:] for part in rest)


def resolve_ref(reference: Reference) -> Any:
    """Produce the callable a descriptor named, importing it if necessary.

    A ``"module:attr"`` string is resolved on demand and deferred on purpose:
    the descriptor table is read on the ``/app/status`` startup path, and
    resolving a loader eagerly would import an optional ML dependency graph
    into the serving process.

    An already-resolved value passes straight through. That is the form an
    extension uses: its module is loaded under a digest-derived name it cannot
    predict, and it is already imported by the time it registers anything, so
    the deferral the string form buys is worth nothing to it.
    """

    if not isinstance(reference, str):
        return reference

    module_name, _, attribute = reference.partition(":")
    if not module_name or not attribute:
        raise ValueError(
            f"Expected a 'module:attr' reference, got {reference!r}"
        )
    target: Any = import_module(module_name)
    for part in attribute.split("."):
        target = getattr(target, part)
    return target


__all__ = [
    "CapabilityDescriptor",
    "DeviceSpec",
    "DirectorySpec",
    "Discovery",
    "FromConfig",
    "PackageSpec",
    "Reference",
    "SearchPathSpec",
    "SysPathSpec",
    "ValueSource",
    "resolve_ref",
]
