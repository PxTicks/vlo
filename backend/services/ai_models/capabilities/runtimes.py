"""The registry-owned load boundary.

Recording a real load failure used to be something a service *volunteered* to
do::

    with record_load_failures(SAM2_CAPABILITY_ID):
        self._predictor = self._load_predictor()
    note_capability_success(SAM2_CAPABILITY_ID)

Three services happened to do it. Nothing verified a fourth would — omit it and
everything still compiles, every test still passes, and the capability appears
in the diagnostics UI looking perfectly healthy while never learning about a
real failure, so ``lastFailure`` stays empty and the durable-failure gate never
engages.

The registry owns the memo cell instead. A service obtains its runtime through
:meth:`LazyRuntime.get`, which is the only accessor, so the guarantee stops
depending on anyone remembering anything.

This also collapses the separate probe entry point each service used to expose.
The Test-runtime job calls the same ``.get()``, which turns *"a probe and a
genuine failure can never disagree"* from a property both paths happened to have
into a fact about the call graph.

The cell is deliberately unkeyed. Beat This! rebuilds when its
``(checkpoint, device, dbn)`` triple changes; it keeps that key *above* the
cell and resets it, rather than the cell growing a key parameter for one caller.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any

from .catalogue import add_change_listener, get_descriptor
from .descriptors import CapabilityDescriptor, resolve_ref
from .failures import clear_failures, note_capability_success, record_load_failures
from .observations import clear_load_success


_UNSET = object()


@dataclass(frozen=True)
class RuntimeLoad:
    """What a loader hands back: the runtime, and what the load established."""

    value: Any
    #: The device the runtime actually landed on, which is stronger evidence
    #: than the device the configuration was expected to resolve to.
    resolved_device: str | None = None
    detail: str | None = None


class LazyRuntime:
    """One capability's runtime, loaded at most once and always recorded."""

    def __init__(
        self,
        capability_id: str,
        loader: str,
        *,
        cancel_exception: str | None = None,
    ) -> None:
        self._capability_id = capability_id
        self._loader_ref = loader
        self._cancel_ref = cancel_exception
        self._lock = threading.RLock()
        self._value: Any = _UNSET
        self._resolved_device: str | None = None

    @property
    def capability_id(self) -> str:
        return self._capability_id

    def describes(self, descriptor: CapabilityDescriptor) -> bool:
        """Was this cell built from this descriptor's load contract?

        Compared by contract rather than by identity: a descriptor replaced by
        an equivalent one has no state worth throwing away, while one that
        names a different loader must not be served a runtime the old loader
        built.
        """

        return (
            self._loader_ref == descriptor.loader
            and self._cancel_ref == descriptor.cancel_exception
        )

    @property
    def loaded(self) -> bool:
        """Is the runtime in memory?

        Read without the lock on purpose: this feeds advisory health fields,
        and blocking a status request behind an in-progress model load would
        be a far worse answer than a slightly stale boolean.
        """

        return self._value is not _UNSET

    @property
    def resolved_device(self) -> str | None:
        return self._resolved_device

    def get(self, **kwargs: Any) -> Any:
        """The runtime, loading it first if necessary.

        Every failure that escapes the loader is classified and recorded
        against this capability before it is re-raised — the caller still fails
        exactly as it would have. A success clears whatever an earlier attempt
        recorded.

        ``kwargs`` reach the loader only on a cold load; once the cell holds a
        value it is returned as-is.
        """

        # Double-checked: the common case is a warm cell, and serialising every
        # inference behind the load lock would make the model a bottleneck.
        if self._value is not _UNSET:
            return self._value

        with self._lock:
            if self._value is not _UNSET:
                return self._value

            with record_load_failures(
                self._capability_id, ignore=self._cancel_exceptions()
            ):
                loaded = resolve_ref(self._loader_ref)(**kwargs)
                # Inside the recorded region on purpose: a loader that returns
                # the wrong shape has failed to load exactly as surely as one
                # that raised, and the guarantee is that *no* way of failing
                # here leaves the capability without a ``lastFailure``.
                if not isinstance(loaded, RuntimeLoad):
                    raise TypeError(
                        f"The loader for '{self._capability_id}' must return a "
                        f"RuntimeLoad, got {type(loaded).__name__}"
                    )

            self._value = loaded.value
            self._resolved_device = loaded.resolved_device
            note_capability_success(
                self._capability_id,
                resolved_device=loaded.resolved_device,
                detail=loaded.detail,
            )
            return self._value

    def reset(self) -> None:
        """Drop the loaded runtime so the next ``get`` builds a fresh one."""

        with self._lock:
            self._value = _UNSET
            self._resolved_device = None

    def _cancel_exceptions(self) -> tuple[type[BaseException], ...]:
        """Exception types that mean "cancelled", resolved on first use.

        Cancellation is not failure: it must pass through the boundary without
        becoming the capability's ``lastFailure``.
        """

        if self._cancel_ref is None:
            return ()
        resolved = resolve_ref(self._cancel_ref)
        return resolved if isinstance(resolved, tuple) else (resolved,)


_CELLS: dict[str, LazyRuntime] = {}
_CELLS_LOCK = threading.Lock()


def lazy_runtime(capability_id: str) -> LazyRuntime:
    """The one cell for a capability's runtime, built from its descriptor.

    Every caller — the service doing real work and the Test-runtime probe alike
    — gets the same object, which is what makes the two unable to disagree.
    """

    descriptor = get_descriptor(capability_id)
    if descriptor is None:
        raise LookupError(f"No capability descriptor for '{capability_id}'")
    if descriptor.loader is None:
        raise LookupError(f"The '{capability_id}' descriptor declares no loader")

    with _CELLS_LOCK:
        cell = _CELLS.get(capability_id)
        # A cell whose descriptor has since been replaced would hand back a
        # runtime the current loader never built, so it is rebuilt rather than
        # reused. Long-lived holders (a service that took its cell at import)
        # keep the old object; that is fine because the shipped table is
        # static, and re-registration is a test and extension concern.
        if cell is not None and cell.describes(descriptor):
            return cell

        cell = LazyRuntime(
            capability_id,
            descriptor.loader,
            cancel_exception=descriptor.cancel_exception,
        )
        _CELLS[capability_id] = cell
        return cell


def evict_lazy_runtime(capability_id: str) -> None:
    """Forget everything this process learned about a capability's runtime.

    Registered as a catalogue listener, so registering or unregistering a
    descriptor cannot leave a loaded runtime, a resolved device or a recorded
    failure behind from the descriptor that used to hold that id.
    """

    with _CELLS_LOCK:
        cell = _CELLS.pop(capability_id, None)
    if cell is not None:
        cell.reset()
    clear_failures(capability_id)
    clear_load_success(capability_id)


def reset_lazy_runtimes() -> None:
    """Drop every loaded runtime. For tests and for a full recheck."""

    with _CELLS_LOCK:
        cells = list(_CELLS.values())
    for cell in cells:
        cell.reset()


add_change_listener(evict_lazy_runtime)


__all__ = [
    "LazyRuntime",
    "RuntimeLoad",
    "evict_lazy_runtime",
    "lazy_runtime",
    "reset_lazy_runtimes",
]
