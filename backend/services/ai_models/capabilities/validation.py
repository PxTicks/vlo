"""Is this descriptor completely registered?

A descriptor names two callables as ``"module:attr"`` strings, which are less
greppable than a call. That indirection is only affordable because every one of
them is resolved somewhere that turns a typo into a failure with a name on it.

For the capabilities this build ships, that somewhere is the completeness sweep
in the test suite. An extension is not in the host's test suite, so its
descriptor is validated at registration instead — same rules, same messages,
enforced when the extension activates rather than never.
"""

from __future__ import annotations

import inspect

from .contract import CheckStatus, VerificationStage
from .descriptors import CapabilityDescriptor, Discovery, resolve_ref
from .environment import (
    UNRESOLVED,
    resolve_directory,
    resolve_search_paths,
    resolve_source,
)
from .profiles import get_profile


#: Raised by resolution when a ``"module:attr"`` reference is wrong in any of
#: the ways a typo makes it wrong.
_RESOLUTION_ERRORS = (ImportError, AttributeError, ValueError, TypeError)


def describe_registration_problems(
    descriptor: CapabilityDescriptor,
    *,
    run_discovery: bool = False,
) -> tuple[str, ...]:
    """Everything that would make this descriptor a half-registration.

    ``run_discovery`` additionally calls the discovery hook once. Discovery is
    cheap by contract — it runs on every status read — and calling it here
    catches the trap that is otherwise invisible: a hook that returns no
    discovered-stage check leaves ``verifiedThrough`` at ``null`` forever, no
    matter how healthy everything else is, because a stage with no checks is a
    stage that was never evaluated.
    """

    problems: list[str] = []

    if not descriptor.id:
        problems.append("no id")
    if not descriptor.label:
        problems.append("no label")

    loader = _resolved_callable(descriptor.loader, "loader", problems)
    discover = _resolved_callable(
        descriptor.discover_models, "discover_models", problems
    )
    del loader

    if discover is not None:
        parameters = inspect.signature(discover).parameters
        if len(parameters) != 1:
            problems.append(
                "discover_models must take exactly one argument, the descriptor"
            )
        elif run_discovery:
            problems.extend(_discovery_problems(descriptor, discover))

    if descriptor.cancel_exception is not None:
        try:
            cancel = resolve_ref(descriptor.cancel_exception)
        except _RESOLUTION_ERRORS as exc:
            problems.append(f"cancel_exception does not resolve ({exc})")
        else:
            if not (isinstance(cancel, type) and issubclass(cancel, BaseException)):
                problems.append("cancel_exception is not an exception type")

    # ``None`` is a legitimate answer — a capability no installer step covers,
    # which is every extension — but a name that is not in the profile table is
    # a typo.
    if descriptor.profile is not None and get_profile(descriptor.profile) is None:
        problems.append(f"unknown install profile {descriptor.profile!r}")

    if descriptor.app_status_key and not descriptor.unavailable_message:
        problems.append("an app_status_key with no unavailable_message")

    if descriptor.packages and descriptor.primary_package is None:
        problems.append("every declared package is optional")

    # A declared location that cannot be produced is a broken descriptor, not
    # an absent directory. Resolving every one here is what stops the silent
    # variant: a capability that quietly reports one fewer check than its
    # neighbours and looks perfectly healthy doing it.
    for directory in descriptor.cache_dirs:
        if resolve_directory(directory) is None:
            problems.append(f"cache directory {directory.id!r} does not resolve")
    for index, search_path in enumerate(descriptor.search_paths):
        if resolve_search_paths(search_path) is None:
            problems.append(f"search path #{index} does not resolve")
    if (
        descriptor.device is not None
        and resolve_source(descriptor.device.requested) is UNRESOLVED
    ):
        problems.append("device source does not resolve")

    return tuple(problems)


def _resolved_callable(
    reference: str | None,
    field: str,
    problems: list[str],
) -> object | None:
    if reference is None:
        problems.append(f"{field} is not declared")
        return None
    try:
        target = resolve_ref(reference)
    except _RESOLUTION_ERRORS as exc:
        problems.append(f"{field} {reference!r} does not resolve ({exc})")
        return None
    if not callable(target):
        problems.append(f"{field} {reference!r} is not callable")
        return None
    return target


def _discovery_problems(
    descriptor: CapabilityDescriptor,
    discover: object,
) -> list[str]:
    try:
        discovery = discover(descriptor)  # type: ignore[operator]
    except Exception as exc:
        return [f"discover_models raised {type(exc).__name__}: {exc}"]

    if not isinstance(discovery, Discovery):
        return [
            "discover_models must return a Discovery, got "
            f"{type(discovery).__name__}"
        ]

    discovered = [
        check
        for check in discovery.checks
        if check.stage is VerificationStage.DISCOVERED
    ]
    if not discovered:
        return [
            "discover_models returned no discovered-stage check, so this "
            "capability could never report verifiedThrough above null"
        ]
    if any(check.status is CheckStatus.SKIPPED for check in discovered):
        # Legal, and worth saying out loud: it caps verification at nothing
        # until whatever the hook was waiting for is present.
        return []
    return []


__all__ = ["describe_registration_problems"]
