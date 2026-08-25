"""Installable profiles: the marker, the remediation, and installer agreement.

Two things are being pinned here. First, that a capability the installer was
asked for and failed to install reports as *blocked* rather than *unavailable* —
without the marker those two are indistinguishable, and "unavailable" reads as
"you never wanted this" when the truth is "your install failed and warned into a
scrollback you no longer have". Second, that the remediation command is one the
user can actually run: ``uv`` is bootstrapped into ``~/.local/bin`` without the
installer touching ``PATH``, so a hard-coded ``uv ...`` string is a command that
fails with "command not found" for exactly the people who need it most.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from services.ai_models.capabilities import (
    CapabilityState,
    CheckStatus,
    FailureCode,
    RemediationKind,
    get_capability,
    profiles,
)
from services.ai_models.capabilities.profiles import (
    BASE_PROFILE_ID,
    INSTALLABLE_PROFILE_IDS,
    PROFILES,
    SAM2_PROFILE_ID,
    SAM_AUDIO_PROFILE_ID,
    capability_was_requested,
    expand_profile_ids,
    failed_install_check,
    install_remediation,
    package_remediation,
    read_install_marker,
    write_install_marker,
)


REPO_ROOT = Path(__file__).resolve().parents[2]


def _check(capability, check_id: str):
    return next(check for check in capability.checks if check.id == check_id)


@pytest.fixture
def with_uv(monkeypatch: pytest.MonkeyPatch):
    """Pretend ``uv`` is on ``PATH``, whatever the machine actually has."""

    monkeypatch.setattr(profiles, "_find_on_path", lambda name: f"/usr/bin/{name}")
    return "uv"


@pytest.fixture
def without_uv(monkeypatch: pytest.MonkeyPatch):
    # Both seams, so neither PATH nor the bootstrap locations turn one up.
    # Neither patch touches a module other subsystems share.
    monkeypatch.setattr(profiles, "_find_on_path", lambda name: None)
    monkeypatch.setattr(profiles, "_uv_bootstrap_candidates", lambda: ())


# --------------------------------------------------------------------------
# Remediation
# --------------------------------------------------------------------------


def test_install_remediation_is_the_documented_command_when_uv_is_on_path(
    with_uv: str,
) -> None:
    remediation = install_remediation(SAM_AUDIO_PROFILE_ID)

    assert remediation is not None
    assert remediation.kind is RemediationKind.COMMAND
    assert remediation.command == (
        "uv pip install --python backend/.venv/bin/python "
        "-r backend/requirements-sam-audio.txt"
    )
    assert remediation.requires_restart is True


def test_install_remediation_quotes_the_recorded_uv_when_it_is_not_on_path(
    monkeypatch: pytest.MonkeyPatch,
    isolated_install_marker: Path,
    tmp_path: Path,
    without_uv: None,
) -> None:
    # The installer bootstraps uv without modifying the shell profile, so the
    # short command would not resolve for the very user who needs it.
    recorded = tmp_path / "local bin" / "uv"
    recorded.parent.mkdir(parents=True)
    recorded.write_text("#!/bin/sh\n")
    recorded.chmod(0o755)
    write_install_marker(
        {SAM2_PROFILE_ID: "installed"},
        uv_path=str(recorded),
        path=isolated_install_marker,
    )

    remediation = install_remediation(SAM2_PROFILE_ID)

    assert remediation is not None
    assert remediation.kind is RemediationKind.COMMAND
    assert remediation.command is not None
    assert remediation.command.startswith(f'"{recorded}" pip install')
    assert remediation.command.endswith("-r backend/requirements-sam2.txt")


def test_install_remediation_offers_the_docs_when_uv_cannot_be_found(
    without_uv: None,
) -> None:
    remediation = install_remediation(SAM_AUDIO_PROFILE_ID)

    assert remediation is not None
    # A command the user cannot run is worse than none, so this points at how
    # to get uv rather than pretending the paste would work.
    assert remediation.kind is RemediationKind.DOCS
    assert remediation.url == profiles.UV_INSTALL_DOCS
    assert "Install uv" in remediation.summary
    # Every surface renders a supplied command as a copy-paste block, so the
    # docs fallback must not carry one: it could only be a `uv ...` line that
    # fails with "command not found" on this exact machine.
    assert remediation.command is None
    # The useful half of the instruction survives in the summary.
    assert "backend/requirements-sam-audio.txt" in remediation.summary


def test_package_remediation_shares_the_same_uv_resolution(without_uv: None) -> None:
    remediation = package_remediation("Install madmom", "git+https://example.test/x")

    assert remediation.kind is RemediationKind.DOCS
    assert remediation.url == profiles.UV_INSTALL_DOCS
    assert remediation.command is None
    assert "git+https://example.test/x" in remediation.summary


# --------------------------------------------------------------------------
# The interpreter the command targets
# --------------------------------------------------------------------------


def _fake_interpreter(tmp_path: Path, prefix_name: str) -> tuple[Path, Path]:
    """An interpreter that exists on disk, outside the repository."""

    prefix = tmp_path / prefix_name
    executable = prefix / "bin" / "python"
    executable.parent.mkdir(parents=True)
    executable.write_text("#!/bin/sh\n")
    executable.chmod(0o755)
    return prefix, executable


def test_the_command_targets_a_conda_environment_it_is_running_in(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    with_uv: str,
) -> None:
    # A conda environment is a full installation: sys.prefix and sys.base_prefix
    # are equal, so a venv-only test sends the user to install into a
    # backend/.venv that nothing is running from — and that may not exist.
    prefix, executable = _fake_interpreter(tmp_path, "conda-env")
    monkeypatch.setattr(sys, "executable", str(executable))
    monkeypatch.setattr(sys, "prefix", str(prefix))
    monkeypatch.setattr(sys, "base_prefix", str(prefix))

    remediation = install_remediation(SAM_AUDIO_PROFILE_ID)

    assert remediation is not None
    assert remediation.command == (
        f"uv pip install --python {executable} "
        "-r backend/requirements-sam-audio.txt"
    )
    assert ".venv" not in (remediation.command or "")


def test_the_command_targets_a_system_interpreter_it_is_running_in(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    with_uv: str,
) -> None:
    prefix, executable = _fake_interpreter(tmp_path, "usr")
    monkeypatch.setattr(sys, "executable", str(executable))
    monkeypatch.setattr(sys, "prefix", str(prefix))
    monkeypatch.setattr(sys, "base_prefix", str(prefix))

    assert profiles.backend_python() == str(executable)
    # The ad-hoc single-package command resolves the interpreter the same way,
    # or madmom would install somewhere the backend cannot see it.
    ad_hoc = package_remediation("Install madmom", "madmom")
    assert str(executable) in (ad_hoc.command or "")


def test_an_interpreter_inside_the_repository_stays_pasteable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The documented case. The rest of the command is repository-relative, so
    # an absolute path here would read as though the two halves disagreed.
    venv_python = REPO_ROOT / "backend" / ".venv" / "bin" / "python"
    if not venv_python.is_file():  # pragma: no cover - depends on the checkout
        pytest.skip("no backend/.venv in this checkout")
    monkeypatch.setattr(sys, "executable", str(venv_python))

    assert profiles.backend_python() == "backend/.venv/bin/python"


def test_an_interpreter_that_cannot_name_itself_falls_back_to_the_venv_layout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A frozen or embedded build leaves sys.executable empty. The venv layout
    # uv sync produces is then the only answer left worth printing.
    monkeypatch.setattr(sys, "executable", "")

    assert profiles.backend_python().endswith(
        "python.exe" if os.name == "nt" else "backend/.venv/bin/python"
    )


def test_meta_profiles_have_no_command_of_their_own(with_uv: str) -> None:
    assert install_remediation("local-ai") is None
    assert expand_profile_ids("local-ai") == (SAM2_PROFILE_ID, SAM_AUDIO_PROFILE_ID)
    assert expand_profile_ids(["sam2", "nonsense"]) == (SAM2_PROFILE_ID,)


# --------------------------------------------------------------------------
# The marker
# --------------------------------------------------------------------------


def test_no_marker_reads_as_no_record_rather_than_a_declined_feature() -> None:
    marker = read_install_marker()

    assert marker.profiles == {}
    assert capability_was_requested("sam-audio") is False
    assert failed_install_check("sam-audio", package_failing=True) is None


def test_a_malformed_marker_is_ignored(isolated_install_marker: Path) -> None:
    isolated_install_marker.parent.mkdir(parents=True, exist_ok=True)
    isolated_install_marker.write_text("{not json", encoding="utf-8")
    profiles.invalidate_install_marker_cache()

    # The marker may only ever add evidence. A broken one must not be able to
    # take a capability away.
    assert read_install_marker().profiles == {}
    assert capability_was_requested("sam2") is False


def test_a_meta_profile_records_every_capability_it_covers(
    isolated_install_marker: Path,
) -> None:
    write_install_marker({"local-ai": "installed"}, path=isolated_install_marker)

    assert capability_was_requested("sam2") is True
    assert capability_was_requested("sam-audio") is True


def test_a_specific_record_beats_the_meta_profile_it_belongs_to(
    isolated_install_marker: Path,
) -> None:
    isolated_install_marker.parent.mkdir(parents=True, exist_ok=True)
    isolated_install_marker.write_text(
        json.dumps(
            {
                "version": 1,
                "profiles": {
                    "local-ai": {"status": "installed", "requested": True},
                    "sam2": {"status": "failed", "requested": True},
                },
            }
        ),
        encoding="utf-8",
    )
    profiles.invalidate_install_marker_cache()

    marker = read_install_marker()
    assert marker.record("sam2") is not None
    assert marker.record("sam2").status == "failed"
    assert marker.record("sam-audio").status == "installed"


def test_the_marker_cache_follows_the_file(isolated_install_marker: Path) -> None:
    write_install_marker({SAM2_PROFILE_ID: "skipped"}, path=isolated_install_marker)
    assert capability_was_requested("sam2") is False

    write_install_marker({SAM2_PROFILE_ID: "failed"}, path=isolated_install_marker)
    assert capability_was_requested("sam2") is True


# --------------------------------------------------------------------------
# What the registry does with it
# --------------------------------------------------------------------------


def test_a_requested_but_uninstalled_capability_is_blocked_not_unavailable(
    fake_environment,
    capability_dirs: dict[str, Path],
    isolated_install_marker: Path,
    with_uv: str,
) -> None:
    fake_environment.set_package(
        "sam_audio", installed=False, missing_module="sam_audio"
    )

    # Nothing on disk and nothing installed: without a marker this is a feature
    # nobody asked for.
    unrequested = get_capability("sam-audio", deep_probe=False)
    assert unrequested is not None
    assert unrequested.state is CapabilityState.UNAVAILABLE

    write_install_marker(
        {SAM_AUDIO_PROFILE_ID: "failed"}, path=isolated_install_marker
    )

    requested = get_capability("sam-audio", refresh=True, deep_probe=False)
    assert requested is not None
    assert requested.state is CapabilityState.BLOCKED
    assert requested.can_attempt is False


def test_a_failed_install_becomes_a_check_with_the_retry_command(
    fake_environment,
    capability_dirs: dict[str, Path],
    isolated_install_marker: Path,
    with_uv: str,
) -> None:
    fake_environment.set_package("sam2", installed=False, missing_module="sam2")
    write_install_marker({SAM2_PROFILE_ID: "failed"}, path=isolated_install_marker)

    capability = get_capability("sam2", refresh=True, deep_probe=False)

    assert capability is not None
    install_check = next(
        check for check in capability.checks if check.id == "install.profile"
    )
    assert install_check.status is CheckStatus.FAIL
    assert install_check.code is FailureCode.PACKAGE_MISSING
    assert install_check.remediation is not None
    assert "requirements-sam2.txt" in install_check.remediation.command


def test_repairing_the_install_by_hand_unblocks_the_capability(
    fake_environment,
    capability_dirs: dict[str, Path],
    isolated_install_marker: Path,
    with_uv: str,
) -> None:
    """The marker is history; the package probe is evidence.

    Running the remediation the card printed installs the package but does not
    rewrite the marker — nothing outside the installer ever does. A check that
    fired on the marker alone would leave the user staring at a blocked
    capability they had just repaired, with no way to clear it short of
    rerunning the whole installer.
    """

    write_install_marker({SAM2_PROFILE_ID: "failed"}, path=isolated_install_marker)
    fake_environment.set_package("sam2", installed=False, missing_module="sam2")

    blocked = get_capability("sam2", refresh=True)
    assert blocked is not None
    assert blocked.state is CapabilityState.BLOCKED
    assert any(check.id == "install.profile" for check in blocked.checks)

    # The user pastes the command and restarts. The marker still says "failed".
    fake_environment.set_package("sam2", installed=True, importable=True)

    repaired = get_capability("sam2", refresh=True)
    assert repaired is not None
    assert all(check.id != "install.profile" for check in repaired.checks)
    assert _check(repaired, "package.sam2").status is CheckStatus.PASS
    # A checkpoint is still missing, so SAM2 is not attemptable — but the
    # reason is now the model, not a stale record of an old install attempt.
    assert repaired.state is CapabilityState.BLOCKED
    assert {check.code for check in repaired.checks if check.failed} == {
        FailureCode.MODEL_MISSING
    }


def test_a_successful_install_adds_no_check(
    fake_environment,
    capability_dirs: dict[str, Path],
    isolated_install_marker: Path,
    with_uv: str,
) -> None:
    write_install_marker({SAM2_PROFILE_ID: "installed"}, path=isolated_install_marker)

    capability = get_capability("sam2", refresh=True, deep_probe=False)

    assert capability is not None
    assert all(check.id != "install.profile" for check in capability.checks)


def test_a_skipped_profile_adds_no_check_and_costs_no_verification(
    fake_environment,
    capability_dirs: dict[str, Path],
    isolated_install_marker: Path,
    with_uv: str,
) -> None:
    # A SKIPPED check here would stop the environment stage counting as
    # evaluated on every machine, quietly capping verifiedThrough at
    # "discovered" for capabilities that are perfectly fine.
    write_install_marker({SAM2_PROFILE_ID: "skipped"}, path=isolated_install_marker)

    with_marker = get_capability("sam2", refresh=True, deep_probe=False)
    profiles.invalidate_install_marker_cache()
    isolated_install_marker.unlink()
    without_marker = get_capability("sam2", refresh=True, deep_probe=False)

    assert with_marker is not None and without_marker is not None
    assert all(check.id != "install.profile" for check in with_marker.checks)
    assert with_marker.verified_through == without_marker.verified_through


def test_the_environment_snapshot_carries_the_profile_table(
    isolated_install_marker: Path,
    with_uv: str,
) -> None:
    write_install_marker(
        {SAM_AUDIO_PROFILE_ID: "failed"},
        uv_path="/opt/uv",
        installer="install.sh",
        path=isolated_install_marker,
    )

    snapshot = profiles.describe_profiles()

    assert snapshot["markerPresent"] is True
    assert snapshot["installer"] == "install.sh"
    # Presence only: a support export has no use for the absolute path of a
    # user's uv, and every other field here is already sanitized.
    assert snapshot["uvAvailable"] is True
    assert "uv" not in snapshot
    recorded = {entry["id"]: entry for entry in snapshot["profiles"]}
    assert recorded[SAM_AUDIO_PROFILE_ID]["record"]["status"] == "failed"
    assert recorded[BASE_PROFILE_ID]["optional"] is False


# --------------------------------------------------------------------------
# Installer agreement
# --------------------------------------------------------------------------


def test_every_profile_requirements_file_exists() -> None:
    for profile in PROFILES:
        if profile.requirements is None:
            continue
        assert (REPO_ROOT / profile.requirements).is_file(), profile.id


@pytest.mark.parametrize("installer", ["install.sh", "install.bat"])
def test_both_installers_cover_every_optional_profile(installer: str) -> None:
    """Adding a profile without wiring the installers fails here.

    The registry's remediation and the installer's command are generated from
    one table precisely so they cannot drift; this is the half of that promise
    a shell script cannot enforce for itself.
    """

    script = (REPO_ROOT / installer).read_text(encoding="utf-8")

    for profile_id in INSTALLABLE_PROFILE_IDS:
        profile = profiles.get_profile(profile_id)
        assert profile is not None and profile.requirements is not None
        assert profile_id in script, f"{installer} never mentions {profile_id}"
        assert Path(profile.requirements).name in script, (
            f"{installer} never installs {profile.requirements}"
        )


def test_install_sh_routes_every_prompt_through_the_non_interactive_helper() -> None:
    """No bare `read` may survive outside ``ask_yes_no``.

    Two failures at once if one does: the flags that promise an unattended run
    are ignored, and under ``set -e`` a `read` at EOF aborts the installer —
    which is precisely how a provisioning script invokes it.
    """

    script = (REPO_ROOT / "install.sh").read_text(encoding="utf-8").splitlines()
    prompts = [
        (number, line)
        for number, line in enumerate(script, start=1)
        if "read -r -p" in line
    ]

    assert len(prompts) == 1, f"prompts outside ask_yes_no: {prompts}"
    assert '"$prompt"' in prompts[0][1]


def test_install_sh_runs_unattended_with_stdin_closed(tmp_path: Path) -> None:
    """The documented flags must survive `set -e` with no terminal attached."""

    if not Path("/bin/bash").exists():  # pragma: no cover - platform guard
        pytest.skip("bash is required to exercise install.sh")

    script = (REPO_ROOT / "install.sh").read_text(encoding="utf-8")
    prelude = tmp_path / "prelude.sh"
    prelude.write_text(
        script[script.index("usage() {") : script.index("# -- 1. Check prerequisites")],
        encoding="utf-8",
    )
    harness = tmp_path / "harness.sh"
    harness.write_text(
        "\n".join(
            [
                "set -euo pipefail",
                f'SCRIPT_DIR="{tmp_path}"',
                'UV_BIN="/opt/uv/bin/uv"',
                "FORCE_INSTALL_VLO_NODE=0",
                "info() { :; }",
                "warn() { :; }",
                "error() { :; }",
                "set -- --profiles sam2",
                f'source "{prelude}"',
                # Both defaults are exercised: an unattended run must take them
                # rather than blocking or aborting on a closed stdin.
                'ask_yes_no "keep existing? " n keep',
                'ask_yes_no "install managed? " y managed',
                'printf "%s %s\\n" "$keep" "$managed"',
            ]
        ),
        encoding="utf-8",
    )

    completed = subprocess.run(
        ["/bin/bash", str(harness)],
        check=True,
        timeout=30,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
    )

    assert completed.stdout.strip().endswith("no yes")


def test_the_marker_install_sh_writes_is_one_this_module_can_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Run install.sh's own marker writer and parse what it produced.

    This is the seam the two halves meet at: a hand-written heredoc on one side
    and a parser on the other. Asserting on a fixture string would only prove
    the fixture matches the parser.
    """

    if not Path("/bin/bash").exists():  # pragma: no cover - platform guard
        pytest.skip("bash is required to exercise install.sh")

    script = (REPO_ROOT / "install.sh").read_text(encoding="utf-8")
    start = script.index("usage() {")
    end = script.index("# -- 1. Check prerequisites")
    prelude = tmp_path / "prelude.sh"
    prelude.write_text(script[start:end], encoding="utf-8")

    harness = tmp_path / "harness.sh"
    harness.write_text(
        "\n".join(
            [
                "set -euo pipefail",
                f'SCRIPT_DIR="{tmp_path}"',
                'UV_BIN="/opt/uv/bin/uv"',
                "FORCE_INSTALL_VLO_NODE=0",
                'info() { :; }',
                'warn() { :; }',
                'error() { :; }',
                "set -- --profiles local-ai",
                f'source "{prelude}"',
                "record_profile_status base installed",
                "record_profile_status sam2 failed",
                "record_profile_status sam-audio installed",
                "write_profile_marker",
            ]
        ),
        encoding="utf-8",
    )
    subprocess.run(["/bin/bash", str(harness)], check=True, timeout=30)

    written = tmp_path / "backend" / "runtime" / "install-profiles.json"
    monkeypatch.setattr(profiles, "PROFILE_MARKER_PATH", written)
    profiles.invalidate_install_marker_cache()
    marker = read_install_marker()

    assert marker.installer == "install.sh"
    assert marker.uv_path == "/opt/uv/bin/uv"
    assert marker.recorded_at is not None
    assert marker.record(SAM2_PROFILE_ID).status == "failed"
    assert marker.record(SAM2_PROFILE_ID).failed is True
    assert marker.record(SAM_AUDIO_PROFILE_ID).status == "installed"
    assert marker.record(BASE_PROFILE_ID).status == "installed"
    assert capability_was_requested("sam2") is True


def test_install_sh_records_declined_profiles_as_not_requested(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not Path("/bin/bash").exists():  # pragma: no cover - platform guard
        pytest.skip("bash is required to exercise install.sh")

    script = (REPO_ROOT / "install.sh").read_text(encoding="utf-8")
    prelude = tmp_path / "prelude.sh"
    prelude.write_text(
        script[script.index("usage() {") : script.index("# -- 1. Check prerequisites")],
        encoding="utf-8",
    )
    harness = tmp_path / "harness.sh"
    harness.write_text(
        "\n".join(
            [
                "set -euo pipefail",
                f'SCRIPT_DIR="{tmp_path}"',
                'UV_BIN="/opt/uv/bin/uv"',
                "FORCE_INSTALL_VLO_NODE=0",
                "info() { :; }",
                "warn() { :; }",
                "error() { :; }",
                "set -- --no-optional",
                f'source "{prelude}"',
                "record_profile_status base installed",
                "write_profile_marker",
            ]
        ),
        encoding="utf-8",
    )
    subprocess.run(["/bin/bash", str(harness)], check=True, timeout=30)

    monkeypatch.setattr(
        profiles,
        "PROFILE_MARKER_PATH",
        tmp_path / "backend" / "runtime" / "install-profiles.json",
    )
    profiles.invalidate_install_marker_cache()

    # Declined is not the same as failed: nothing should be blocked by it.
    assert capability_was_requested("sam2") is False
    assert capability_was_requested("sam-audio") is False
    assert failed_install_check("sam2", package_failing=True) is None
