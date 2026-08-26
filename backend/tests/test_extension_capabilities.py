"""Registering a runtime capability from a backend extension.

The contract these tests hold: an extension describes what it needs, and the
host owns the identity, the lifetime, and the admission rules. Everything runs
through the real activation path — a staged package, an approval, and
``BackendExtensionRuntime.start`` — because the failure this contract exists to
prevent is a half-registration, and half-registrations only happen in the seams
between activation, failure, and shutdown.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import FastAPI

from services.ai_models.capabilities import (
    CapabilityState,
    VerificationStage,
    descriptor_ids,
    get_capability,
    get_provider,
    list_capability_ids,
)
from services.extensions.capabilities import (
    ExtensionCapabilityError,
    ExtensionCapabilityRegistrar,
)


EXTENSION_ID = "example.tracking"
CAPABILITY_ID = f"{EXTENSION_ID}:tracker"


# --------------------------------------------------------------------------
# Harness
# --------------------------------------------------------------------------


def _capability_source(
    *,
    local_id: str = "tracker",
    models_dir: Path,
    cache_dir: Path,
    uses_local_gpu: bool = False,
    loader: str = "build",
    discovery_checks: bool = True,
    raise_after_register: bool = False,
) -> str:
    """A backend extension that registers one model runtime.

    Written the way an extension actually has to: every location is a value it
    supplies, the hooks are the functions it already holds, and nothing is
    imported from outside ``services.extensions``.
    """

    return f'''
from pathlib import Path

from services.extensions import (
    CapabilityDescriptor,
    Check,
    CheckStatus,
    DirectorySpec,
    DeviceSpec,
    Discovery,
    PackageSpec,
    RuntimeLoad,
    SearchPathSpec,
    VerificationStage,
)

MODELS = Path({str(models_dir)!r})
CACHE = Path({str(cache_dir)!r})


def discover(descriptor):
    found = sorted(MODELS.glob("*.pt"))
    checks = ()
    if {discovery_checks!r}:
        checks = (
            Check(
                id="model.default",
                status=CheckStatus.PASS if found else CheckStatus.FAIL,
                stage=VerificationStage.DISCOVERED,
                summary=(
                    f"{{len(found)}} tracker checkpoint(s) found"
                    if found
                    else "No tracker checkpoint was found"
                ),
            ),
        )
    return Discovery(
        checks=checks,
        models=tuple({{"name": path.stem}} for path in found),
        selected_model=found[0].stem if found else None,
        found=bool(found),
    )


def build(on_progress=None):
    if on_progress is not None:
        on_progress(0.5, "Loading the tracker")
    return RuntimeLoad(value={{"tracker": True}}, resolved_device="cpu")


def create_extension(context):
    context.capabilities.register(
        CapabilityDescriptor(
            id={local_id!r},
            label="Acme Tracker",
            packages=(
                PackageSpec(
                    module="acme_tracker",
                    distribution="acme-tracker",
                    install_target="acme-tracker>=1.0",
                    install_summary="Install the Acme tracker runtime",
                ),
            ),
            python_min=(3, 10),
            device=DeviceSpec(requested="cpu", env_var="ACME_TRACKER_DEVICE"),
            cache_dirs=(
                DirectorySpec(
                    id="acmeTracker.cache",
                    path=CACHE,
                    label="The Acme tracker cache directory",
                ),
            ),
            search_paths=(SearchPathSpec((MODELS,)),),
            uses_local_gpu={uses_local_gpu!r},
            loader={loader},
            discover_models=discover,
        )
    )
    if {raise_after_register!r}:
        raise RuntimeError("the factory changed its mind")
    return None
'''


@pytest.fixture
def tracker_dirs(tmp_path: Path) -> dict[str, Path]:
    models = tmp_path / "acme-models"
    cache = tmp_path / "acme-cache"
    models.mkdir()
    cache.mkdir()
    (models / "tracker-v1.pt").write_bytes(b"weights")
    return {"models": models, "cache": cache}


@pytest.fixture
def activate(activate_backend_extension):
    """The shared activation harness, under this module's historical name."""

    return activate_backend_extension


# --------------------------------------------------------------------------
# The governing case
# --------------------------------------------------------------------------


def test_an_extension_registers_a_capability_like_a_native_one(
    fake_environment,
    capability_dirs: dict[str, Path],
    activate,
    tracker_dirs: dict[str, Path],
) -> None:
    runtime, summary = activate(
        _capability_source(
            models_dir=tracker_dirs["models"],
            cache_dir=tracker_dirs["cache"],
        ),
    )
    assert [record.status for record in summary.records] == ["active"]
    assert CAPABILITY_ID in list_capability_ids()

    capability = get_capability(CAPABILITY_ID)
    assert capability is not None
    assert capability.label == "Acme Tracker"
    assert capability.selected_model == "tracker-v1"
    assert capability.verified_through is VerificationStage.ENVIRONMENT
    assert {check.id for check in capability.checks} == {
        "model.default",
        "python.version",
        "package.acme_tracker",
        "device.requested",
        "cache.directory",
    }
    assert capability.device is not None
    assert capability.device.requested == "cpu"

    # Deactivation takes the capability with it. Stopped here rather than left
    # to the fixture because that removal is the assertion.
    asyncio.run(runtime.stop())

    assert CAPABILITY_ID not in list_capability_ids()
    assert get_capability(CAPABILITY_ID) is None


def test_an_extension_capability_reaches_the_environment_snapshot(
    fake_environment,
    capability_dirs: dict[str, Path],
    activate,
    tracker_dirs: dict[str, Path],
) -> None:
    from services.ai_models.capabilities import capabilities_payload
    from services.ai_models.capabilities.environment import display_path

    runtime, _summary = activate(
        _capability_source(
            models_dir=tracker_dirs["models"],
            cache_dir=tracker_dirs["cache"],
        ),
    )
    environment = capabilities_payload()["environment"]

    assert "acme-tracker" in environment["packages"]
    cache = next(
        entry
        for entry in environment["directories"]
        if entry["id"] == "acmeTracker.cache"
    )
    assert cache["writable"] is True
    assert environment["searchPaths"]["exampleTrackingTracker"] == [
        display_path(tracker_dirs["models"])
    ]


def test_a_missing_package_blocks_rather_than_disappearing(
    fake_environment,
    capability_dirs: dict[str, Path],
    activate,
    tracker_dirs: dict[str, Path],
) -> None:
    # An active extension is itself the evidence that its capability is wanted.
    # Without that, a missing package would read as "nobody asked for this" and
    # the install command would sit on a card the UI treats as unavailable.
    fake_environment.set_package("acme_tracker", installed=False, importable=False)

    runtime, _summary = activate(
        _capability_source(
            models_dir=tracker_dirs["models"],
            cache_dir=tracker_dirs["cache"],
        ),
    )
    capability = get_capability(CAPABILITY_ID)
    assert capability is not None
    assert capability.state is CapabilityState.BLOCKED
    package = next(
        check
        for check in capability.checks
        if check.id == "package.acme_tracker"
    )
    assert package.remediation is not None
    assert package.remediation.command == (
        "uv pip install --python backend/.venv/bin/python acme-tracker>=1.0"
    )


# --------------------------------------------------------------------------
# What the host keeps
# --------------------------------------------------------------------------


def test_an_extension_cannot_claim_a_host_capability_id(
    fake_environment,
    capability_dirs: dict[str, Path],
    activate,
    tracker_dirs: dict[str, Path],
) -> None:
    runtime, summary = activate(
        _capability_source(
            local_id="sam2",
            models_dir=tracker_dirs["models"],
            cache_dir=tracker_dirs["cache"],
        ),
    )
    assert [record.status for record in summary.records] == ["active"]
    # Namespaced, so the host's own SAM2 is untouched and still first.
    assert f"{EXTENSION_ID}:sam2" in list_capability_ids()
    assert descriptor_ids()[0] == "sam2"
    assert get_capability("sam2") is not None
    assert get_capability("sam2").label == "SAM2"


@pytest.mark.parametrize("local_id", ["", "Tracker", "acme/tracker", "acme.tracker"])
def test_an_unusable_capability_name_fails_activation(
    fake_environment,
    capability_dirs: dict[str, Path],
    activate,
    tracker_dirs: dict[str, Path],
    local_id: str,
) -> None:
    _runtime, summary = activate(
        _capability_source(
            local_id=local_id,
            models_dir=tracker_dirs["models"],
            cache_dir=tracker_dirs["cache"],
        ),
    )
    assert [record.status for record in summary.records] == ["failed"]
    assert "not a usable capability name" in summary.records[0].message


def test_uses_local_gpu_is_accepted_now_that_extension_jobs_are_admitted(
    fake_environment,
    capability_dirs: dict[str, Path],
    activate,
    tracker_dirs: dict[str, Path],
) -> None:
    # Refused until Phase E, because it would have advertised exclusion that
    # only the Test-runtime probe actually had. An extension's own jobs now
    # take the same exclusive lease, so the flag means what it says.
    _runtime, summary = activate(
        _capability_source(
            models_dir=tracker_dirs["models"],
            cache_dir=tracker_dirs["cache"],
            uses_local_gpu=True,
        ),
    )
    assert [record.status for record in summary.records] == ["active"]
    assert CAPABILITY_ID in list_capability_ids()
    provider = get_provider(CAPABILITY_ID)
    assert provider is not None
    # What the probe reads to decide whether to take the GPU lease.
    assert provider.uses_local_gpu is True


def test_a_discovery_hook_with_no_check_fails_activation(
    fake_environment,
    capability_dirs: dict[str, Path],
    activate,
    tracker_dirs: dict[str, Path],
) -> None:
    # A discovery hook returning no discovered-stage check caps the capability
    # at verifiedThrough: null forever, however healthy everything else is —
    # invisible unless registration says so.
    _runtime, summary = activate(
        _capability_source(
            models_dir=tracker_dirs["models"],
            cache_dir=tracker_dirs["cache"],
            discovery_checks=False,
        ),
    )
    assert [record.status for record in summary.records] == ["failed"]
    assert "no discovered-stage check" in summary.records[0].message


def test_an_unresolvable_loader_fails_activation(
    fake_environment,
    capability_dirs: dict[str, Path],
    activate,
    tracker_dirs: dict[str, Path],
) -> None:
    _runtime, summary = activate(
        _capability_source(
            models_dir=tracker_dirs["models"],
            cache_dir=tracker_dirs["cache"],
            loader='"does.not.exist:build"',
        ),
    )
    assert [record.status for record in summary.records] == ["failed"]
    assert "loader" in summary.records[0].message
    assert CAPABILITY_ID not in list_capability_ids()


def test_a_factory_that_fails_after_registering_leaves_nothing_behind(
    fake_environment,
    capability_dirs: dict[str, Path],
    activate,
    tracker_dirs: dict[str, Path],
) -> None:
    _runtime, summary = activate(
        _capability_source(
            models_dir=tracker_dirs["models"],
            cache_dir=tracker_dirs["cache"],
            raise_after_register=True,
        ),
    )
    assert [record.status for record in summary.records] == ["failed"]
    assert CAPABILITY_ID not in list_capability_ids()
    assert get_capability(CAPABILITY_ID) is None


def test_a_namespaced_capability_is_addressable_over_http(
    fake_environment,
    capability_dirs: dict[str, Path],
    activate,
    tracker_dirs: dict[str, Path],
) -> None:
    # A capability id is one path segment. A separator that splits it makes
    # every individual read, recheck and Test-runtime probe 404 — which the
    # in-process assertions above would never notice.
    from fastapi.testclient import TestClient

    from routers.runtime_capabilities import router

    activate(
        _capability_source(
            models_dir=tracker_dirs["models"],
            cache_dir=tracker_dirs["cache"],
        ),
    )

    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        response = client.get(f"/app/runtime-capabilities/{CAPABILITY_ID}")

    assert response.status_code == 200, response.text
    assert response.json()["capability"]["id"] == CAPABILITY_ID


# --------------------------------------------------------------------------
# The registrar on its own
# --------------------------------------------------------------------------


def test_release_is_idempotent_and_unregisters_in_reverse() -> None:
    registrar = ExtensionCapabilityRegistrar("example.two")
    assert registrar.registered() == ()
    registrar.release()
    registrar.release()
    assert registrar.registered() == ()


def test_register_reports_every_problem_at_once() -> None:
    from services.ai_models.capabilities import CapabilityDescriptor

    registrar = ExtensionCapabilityRegistrar("example.broken")
    with pytest.raises(ExtensionCapabilityError) as exc_info:
        registrar.register(CapabilityDescriptor(id="broken", label="Broken"))

    message = str(exc_info.value)
    assert "loader is not declared" in message
    assert "discover_models is not declared" in message
    assert registrar.registered() == ()


def test_a_released_registrar_refuses_further_registrations(
    tracker_dirs: dict[str, Path],
) -> None:
    # The host abandons a synchronous factory it has stopped waiting for, and
    # Python cannot terminate it; a shutdown callback runs while the extension
    # is going away. Either could otherwise register a capability that nothing
    # is left to remove.
    from services.ai_models.capabilities import (
        CapabilityDescriptor,
        Discovery,
        RuntimeLoad,
    )

    registrar = ExtensionCapabilityRegistrar("example.late")
    assert registrar.released is False
    registrar.release()
    assert registrar.released is True

    with pytest.raises(ExtensionCapabilityError, match="no longer active"):
        registrar.register(
            CapabilityDescriptor(
                id="late",
                label="Late",
                loader=lambda on_progress=None: RuntimeLoad(value=None),
                discover_models=lambda descriptor: Discovery(found=True),
            )
        )

    assert registrar.registered() == ()
    assert "example.late:late" not in list_capability_ids()


@pytest.mark.parametrize(
    ("field", "value", "expected"),
    [
        ("app_status_key", "sam2", "app_status_key is a host field"),
        ("profile", "base", "profile names a host installer profile"),
    ],
)
def test_host_owned_descriptor_fields_are_refused(
    field: str,
    value: str,
    expected: str,
) -> None:
    # Both would let an extension reach into a host surface: one overwrites the
    # native SAM2 entry in /app/status, the other tells the user to reinstall
    # the backend requirements to fix an extension's own package.
    from services.ai_models.capabilities import (
        CapabilityDescriptor,
        Discovery,
        RuntimeLoad,
    )

    registrar = ExtensionCapabilityRegistrar("example.greedy")
    with pytest.raises(ExtensionCapabilityError, match=expected):
        registrar.register(
            CapabilityDescriptor(
                id="greedy",
                label="Greedy",
                loader=lambda on_progress=None: RuntimeLoad(value=None),
                discover_models=lambda descriptor: Discovery(found=True),
                unavailable_message="unused",
                **{field: value},
            )
        )
    assert registrar.registered() == ()
