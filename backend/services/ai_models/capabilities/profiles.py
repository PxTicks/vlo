"""Installable capability profiles, and what the installer recorded doing.

Three consumers need the same answer to "how is this optional feature
installed?", and they used to answer it separately:

* the installer, which runs the command;
* the diagnostics view, which tells the user the command to run;
* the registry, which decides whether an absent capability was *requested and
  broken* or simply never asked for.

Everything here is derived from one profile table, so the installer and the
remediation string cannot drift apart. The installer writes a small JSON marker
naming the profiles it was asked for and how each one went; that marker is the
only record of :file:`install.sh`'s soft ``warn``-and-continue failures, and
without it "nothing on disk" is indistinguishable from "the install failed
silently three weeks ago".

The remediation command is built rather than hard-coded because ``uv`` is not
reliably on ``PATH``: the installer bootstraps it into ``~/.local/bin`` without
touching the shell profile. A command the user cannot paste is worse than no
command, so when ``uv`` cannot be located this offers the docs instead.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .contract import (
    Check,
    CheckStatus,
    FailureCode,
    Remediation,
    RemediationKind,
    VerificationStage,
    iso_timestamp,
    utc_now,
)


#: Repository root — ``backend/`` sits directly under it.
PROJECT_ROOT = Path(__file__).resolve().parents[4]
BACKEND_ROOT = PROJECT_ROOT / "backend"

#: Written by ``install.sh`` / ``install.bat`` after the optional steps run.
PROFILE_MARKER_PATH = BACKEND_ROOT / "runtime" / "install-profiles.json"

#: Where to send someone who has no ``uv`` at all.
UV_INSTALL_DOCS = "https://docs.astral.sh/uv/getting-started/installation/"

BASE_PROFILE_ID = "base"
SAM2_PROFILE_ID = "sam2"
SAM_AUDIO_PROFILE_ID = "sam-audio"
LOCAL_AI_PROFILE_ID = "local-ai"


@dataclass(frozen=True)
class CapabilityProfile:
    """One installable unit the installer can be asked for by name."""

    id: str
    label: str
    summary: str
    #: Capabilities this profile makes available. Empty for a meta profile.
    capability_ids: tuple[str, ...] = ()
    #: Project-relative requirements file, or ``None`` for a meta profile.
    requirements: str | None = None
    #: Profiles a meta profile expands to.
    includes: tuple[str, ...] = ()
    #: ``False`` for the base environment, which is not optional.
    optional: bool = True

    def expand(self) -> tuple[str, ...]:
        """This profile's own id, or the ids a meta profile stands for."""

        return self.includes or (self.id,)


PROFILES: tuple[CapabilityProfile, ...] = (
    CapabilityProfile(
        id=BASE_PROFILE_ID,
        label="Backend environment",
        summary="The base backend dependencies, including Beat This!",
        capability_ids=("beat-this",),
        requirements="backend/requirements.txt",
        optional=False,
    ),
    CapabilityProfile(
        id=SAM2_PROFILE_ID,
        label="SAM2",
        summary="Video segmentation and masking",
        capability_ids=("sam2",),
        requirements="backend/requirements-sam2.txt",
    ),
    CapabilityProfile(
        id=SAM_AUDIO_PROFILE_ID,
        label="SAM-Audio",
        summary="Prompted audio separation",
        capability_ids=("sam-audio",),
        requirements="backend/requirements-sam-audio.txt",
    ),
    CapabilityProfile(
        id=LOCAL_AI_PROFILE_ID,
        label="All local AI",
        summary="Every optional local model runtime",
        includes=(SAM2_PROFILE_ID, SAM_AUDIO_PROFILE_ID),
    ),
)

_PROFILES_BY_ID: dict[str, CapabilityProfile] = {
    profile.id: profile for profile in PROFILES
}
_PROFILE_BY_CAPABILITY: dict[str, CapabilityProfile] = {
    capability_id: profile
    for profile in PROFILES
    for capability_id in profile.capability_ids
}

#: Optional profiles an installer actually installs, in presentation order.
#: Meta profiles are excluded: they name a set, they do not install anything.
INSTALLABLE_PROFILE_IDS: tuple[str, ...] = tuple(
    profile.id
    for profile in PROFILES
    if profile.optional and profile.requirements is not None
)

#: Everything ``--profiles`` accepts, meta profiles included.
SELECTABLE_PROFILE_IDS: tuple[str, ...] = tuple(
    profile.id for profile in PROFILES if profile.optional
)


def get_profile(profile_id: str) -> CapabilityProfile | None:
    return _PROFILES_BY_ID.get(profile_id)


def profile_for_capability(capability_id: str) -> CapabilityProfile | None:
    return _PROFILE_BY_CAPABILITY.get(capability_id)


def expand_profile_ids(requested: object) -> tuple[str, ...]:
    """Resolve requested profile names to concrete, installable ones.

    Meta profiles expand; unknown names are dropped rather than raising, so a
    stale marker from an older installer cannot break a status read.
    """

    if isinstance(requested, str):
        names: list[str] = [requested]
    elif isinstance(requested, (list, tuple)):
        names = [str(name) for name in requested]
    else:
        return ()

    resolved: list[str] = []
    for name in names:
        profile = _PROFILES_BY_ID.get(name.strip())
        if profile is None:
            continue
        for expanded in profile.expand():
            if expanded not in resolved:
                resolved.append(expanded)
    return tuple(resolved)


# --------------------------------------------------------------------------
# The installer's marker
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ProfileRecord:
    """What the installer did about one profile."""

    id: str
    #: ``installed`` | ``failed`` | ``skipped``
    status: str
    requested: bool
    detail: str | None = None
    recorded_at: datetime | None = None

    @property
    def failed(self) -> bool:
        return self.requested and self.status == "failed"

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "status": self.status,
            "requested": self.requested,
        }
        if self.detail is not None:
            payload["detail"] = self.detail
        if self.recorded_at is not None:
            payload["recordedAt"] = iso_timestamp(self.recorded_at)
        return payload


@dataclass(frozen=True)
class InstallMarker:
    """The installer's record of a run, or the absence of one."""

    recorded_at: datetime | None
    profiles: Mapping[str, ProfileRecord]
    uv_path: str | None = None
    python_path: str | None = None
    installer: str | None = None

    def record(self, profile_id: str) -> ProfileRecord | None:
        return self.profiles.get(profile_id)

    def to_json(self) -> dict[str, Any]:
        return {
            "recordedAt": (
                iso_timestamp(self.recorded_at)
                if self.recorded_at is not None
                else None
            ),
            "installer": self.installer,
            "profiles": [
                record.to_json()
                for record in sorted(
                    self.profiles.values(), key=lambda item: item.id
                )
            ],
        }


_EMPTY_MARKER = InstallMarker(recorded_at=None, profiles={})

_MARKER_LOCK = threading.Lock()
_MARKER_CACHE: tuple[tuple[int, int] | None, InstallMarker] | None = None


def _parse_timestamp(raw: object) -> datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _parse_marker(payload: object) -> InstallMarker:
    if not isinstance(payload, dict):
        return _EMPTY_MARKER

    raw_profiles = payload.get("profiles")
    records: dict[str, ProfileRecord] = {}

    entries: list[tuple[CapabilityProfile, Mapping[str, Any]]] = []
    if isinstance(raw_profiles, dict):
        candidates = [
            (str(profile_id), entry)
            for profile_id, entry in raw_profiles.items()
            if isinstance(entry, dict)
        ]
    elif isinstance(raw_profiles, list):
        candidates = [
            (str(entry["id"]), entry)
            for entry in raw_profiles
            if isinstance(entry, dict) and entry.get("id")
        ]
    else:
        candidates = []

    for profile_id, entry in candidates:
        profile = _PROFILES_BY_ID.get(profile_id)
        if profile is not None:
            entries.append((profile, entry))

    # A meta profile only supplies a default. An explicit record for one of the
    # capabilities it covers is the more specific statement and must win,
    # whichever order the installer happened to write them in.
    entries.sort(key=lambda item: len(item[0].expand()), reverse=True)

    for profile, entry in entries:
        status = str(entry.get("status", "skipped")).strip().lower()
        if status not in {"installed", "failed", "skipped"}:
            status = "skipped"
        detail = entry.get("detail")
        for expanded in profile.expand():
            records[expanded] = ProfileRecord(
                id=expanded,
                status=status,
                requested=bool(entry.get("requested", status != "skipped")),
                detail=str(detail) if detail else None,
                recorded_at=_parse_timestamp(entry.get("recordedAt")),
            )

    def _text(key: str) -> str | None:
        value = payload.get(key)
        return str(value) if isinstance(value, str) and value.strip() else None

    return InstallMarker(
        recorded_at=_parse_timestamp(payload.get("recordedAt")),
        profiles=records,
        uv_path=_text("uv"),
        python_path=_text("python"),
        installer=_text("installer"),
    )


def read_install_marker() -> InstallMarker:
    """The installer's marker, cached on the file's identity and mtime.

    Missing, unreadable, or malformed markers all read as "no record" — the
    marker adds evidence when present and must never be able to remove any.
    """

    global _MARKER_CACHE

    try:
        stat = PROFILE_MARKER_PATH.stat()
        stamp: tuple[int, int] | None = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        stamp = None

    with _MARKER_LOCK:
        cached = _MARKER_CACHE
        if cached is not None and cached[0] == stamp:
            return cached[1]

    if stamp is None:
        marker = _EMPTY_MARKER
    else:
        try:
            marker = _parse_marker(
                json.loads(PROFILE_MARKER_PATH.read_text(encoding="utf-8"))
            )
        except (OSError, ValueError):
            marker = _EMPTY_MARKER

    with _MARKER_LOCK:
        _MARKER_CACHE = (stamp, marker)
    return marker


def invalidate_install_marker_cache() -> None:
    """Forget the parsed marker. Called by an explicit recheck, and by tests."""

    global _MARKER_CACHE
    with _MARKER_LOCK:
        _MARKER_CACHE = None


def capability_profile_record(capability_id: str) -> ProfileRecord | None:
    profile = profile_for_capability(capability_id)
    if profile is None:
        return None
    return read_install_marker().record(profile.id)


def capability_was_requested(capability_id: str) -> bool:
    """Did the installer record being asked for this capability?

    ``False`` when no marker exists: absence of a record is not a record of
    absence, and an install predating the marker must not start reporting its
    optional features as deliberately declined.
    """

    record = capability_profile_record(capability_id)
    return record is not None and record.requested


# --------------------------------------------------------------------------
# Remediation
# --------------------------------------------------------------------------


def _project_relative(path: Path | str) -> str:
    """A path the user can paste from the repository root, when it is inside it.

    ``abspath`` is tried before ``resolve`` because a venv's ``bin/python`` is a
    symlink to the interpreter it was built from: resolving first would follow
    it out of the project and hand back an absolute path to the system Python,
    which is not the interpreter the install has to target.
    """

    candidate = Path(path)
    for absolute in (Path(os.path.abspath(candidate)), _safe_resolve(candidate)):
        if absolute is None:
            continue
        try:
            return absolute.relative_to(PROJECT_ROOT).as_posix()
        except ValueError:
            continue
    return str(candidate)


def _safe_resolve(path: Path) -> Path | None:
    try:
        return path.resolve()
    except OSError:
        return None


def _quote(command: str) -> str:
    return f'"{command}"' if " " in command else command


def backend_python() -> str:
    """The interpreter an install must target.

    That is *this* process, unconditionally: whatever is serving the request is
    the environment the missing package has to land in, so the command and the
    thing it is meant to repair cannot disagree.

    This used to be gated on ``sys.prefix != sys.base_prefix``, which only
    recognises PEP 405 venvs. A conda environment is a full installation and
    reports the two as equal, as does a system interpreter with the backend's
    dependencies installed beside it — both were handed the ``backend/.venv``
    guess instead of the interpreter they were actually running, and that guess
    was printed whether or not the path existed on the machine.

    The venv layout ``uv sync`` produces survives only as the fallback for an
    interpreter that cannot name itself: a frozen or embedded build leaves
    ``sys.executable`` empty.
    """

    executable = sys.executable
    if executable and Path(executable).is_file():
        return _project_relative(executable)

    venv = BACKEND_ROOT / ".venv"
    candidate = (
        venv / "Scripts" / "python.exe" if os.name == "nt" else venv / "bin" / "python"
    )
    return _project_relative(candidate)


def _find_on_path(name: str) -> str | None:
    """``shutil.which``, behind a seam.

    Tests need to control whether ``uv`` is discoverable, and patching
    ``shutil.which`` itself would reach every other PATH lookup in the process
    — ffmpeg, git — because ``shutil`` is one shared module object. This gives
    them something local to replace instead.
    """

    return shutil.which(name)


def _uv_bootstrap_candidates() -> tuple[Path, ...]:
    """Where ``uv`` lands when installed without touching the shell profile."""

    home = Path.home()
    return (
        home / ".local" / "bin" / "uv",
        home / ".cargo" / "bin" / "uv",
    )


def uv_command() -> str | None:
    """How to invoke ``uv``, or ``None`` when it cannot be found.

    ``uv`` on ``PATH`` wins, so the documented command stays the short one. The
    installer's recorded absolute path is the fallback, because it bootstraps
    ``uv`` into ``~/.local/bin`` without modifying the shell profile — the exact
    case where the short command would fail.
    """

    if _find_on_path("uv"):
        return "uv"

    recorded = read_install_marker().uv_path
    if recorded and Path(recorded).is_file() and os.access(recorded, os.X_OK):
        return _quote(recorded)

    for candidate in _uv_bootstrap_candidates():
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return _quote(str(candidate))

    return None


def install_command(profile: CapabilityProfile, *, uv: str | None) -> str | None:
    """The one command that installs a profile, or ``None`` for a meta profile."""

    if profile.requirements is None:
        return None
    return (
        f"{uv or 'uv'} pip install --python {backend_python()} "
        f"-r {profile.requirements}"
    )


def install_remediation(profile_id: str) -> Remediation | None:
    """What to tell the user to run to install a profile.

    Falls back to the ``uv`` documentation rather than printing a command that
    would only fail with "uv: command not found".
    """

    profile = _PROFILES_BY_ID.get(profile_id)
    if profile is None or profile.requirements is None:
        return None

    uv = uv_command()
    command = install_command(profile, uv=uv)
    if uv is None:
        # No ``command``: every surface renders one as a copy-paste block, and
        # a block that fails with "uv: command not found" is worse than none.
        # The requirements file moves into the summary so the useful half of
        # the instruction survives.
        return Remediation(
            kind=RemediationKind.DOCS,
            summary=(
                f"Install uv, then install {profile.label} into the backend "
                f"virtual environment from {profile.requirements}"
            ),
            url=UV_INSTALL_DOCS,
            requires_restart=True,
        )

    return Remediation(
        kind=RemediationKind.COMMAND,
        summary=(
            f"Install {profile.label} into the backend virtual environment"
            if profile.optional
            else "Reinstall the backend requirements"
        ),
        command=command,
        requires_restart=True,
    )


def package_remediation(summary: str, target: str) -> Remediation:
    """An ad-hoc ``uv pip install`` for a single package outside any profile.

    Same ``uv`` resolution as the profile commands, so an optional extra such as
    madmom cannot end up quoting a ``uv`` the user does not have.
    """

    uv = uv_command()
    if uv is None:
        # As above: no command, because the only one we could print would not
        # run on this machine.
        return Remediation(
            kind=RemediationKind.DOCS,
            summary=f"Install uv, then: {summary.lower()} ({target})",
            url=UV_INSTALL_DOCS,
            requires_restart=True,
        )

    command = f"{uv} pip install --python {backend_python()} {target}"
    return Remediation(
        kind=RemediationKind.COMMAND,
        summary=summary,
        command=command,
        requires_restart=True,
    )


def capability_install_remediation(capability_id: str) -> Remediation | None:
    profile = profile_for_capability(capability_id)
    return install_remediation(profile.id) if profile is not None else None


def failed_install_check(
    capability_id: str,
    *,
    package_failing: bool,
) -> Check | None:
    """A check explaining an install failure the live probe can still see.

    ``package_failing`` is not optional, because the whole risk here is
    forgetting to pass it. The marker is a *historical* record: running the
    remediation repairs the install without rewriting it, so a check that fired
    on the marker alone would keep a repaired capability blocked until the user
    happened to rerun the installer. This never adds a failure of its own — it
    only says why the failure the package check already found is there.

    Returned only when there is something to say. A ``skipped`` check here would
    be worse than nothing: it would stop the environment stage from counting as
    evaluated for every capability on every machine without a marker.
    """

    if not package_failing:
        return None
    profile = profile_for_capability(capability_id)
    if profile is None:
        return None
    record = read_install_marker().record(profile.id)
    if record is None or not record.failed:
        return None

    when = (
        f" on {iso_timestamp(record.recorded_at)}"
        if record.recorded_at is not None
        else ""
    )
    return Check(
        id="install.profile",
        status=CheckStatus.FAIL,
        stage=VerificationStage.ENVIRONMENT,
        code=FailureCode.PACKAGE_MISSING,
        summary=f"The {profile.label} install did not complete{when}",
        detail=record.detail,
        remediation=install_remediation(profile.id),
    )


def describe_profiles() -> dict[str, Any]:
    """The profile half of the environment snapshot, for the support export."""

    marker = read_install_marker()
    uv = uv_command()
    return {
        "markerPath": _project_relative(PROFILE_MARKER_PATH),
        "markerPresent": marker.recorded_at is not None or bool(marker.profiles),
        "recordedAt": (
            iso_timestamp(marker.recorded_at)
            if marker.recorded_at is not None
            else None
        ),
        "installer": marker.installer,
        # Presence only. The absolute path of a user's uv is not diagnostic
        # enough to be worth putting in a support file.
        "uvAvailable": uv is not None,
        "backendPython": backend_python(),
        "profiles": [
            {
                "id": profile.id,
                "label": profile.label,
                "summary": profile.summary,
                "optional": profile.optional,
                "capabilities": list(profile.capability_ids),
                "requirements": profile.requirements,
                "includes": list(profile.includes),
                "record": (
                    record.to_json()
                    if (record := marker.record(profile.id)) is not None
                    else None
                ),
            }
            for profile in PROFILES
        ],
    }


def write_install_marker(
    records: Mapping[str, str],
    *,
    uv_path: str | None = None,
    python_path: str | None = None,
    installer: str | None = None,
    path: Path | None = None,
) -> Path:
    """Write the marker. Used by the installers and by tests.

    ``records`` maps a profile id to ``installed`` | ``failed`` | ``skipped``.
    """

    target = path or PROFILE_MARKER_PATH
    now = iso_timestamp(utc_now())
    payload = {
        "version": 1,
        "recordedAt": now,
        "installer": installer,
        "uv": uv_path,
        "python": python_path,
        "profiles": {
            profile_id: {
                "status": status,
                "requested": status != "skipped",
                "recordedAt": now,
            }
            for profile_id, status in records.items()
            if profile_id in _PROFILES_BY_ID
        },
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    invalidate_install_marker_cache()
    return target
