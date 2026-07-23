"""Atomic persistence for extension approvals outside extension packages."""

from __future__ import annotations

import json
import math
import os
import re
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from time import time
from typing import Callable
from uuid import uuid4

from services.extensions.package_digest import is_package_digest

_STATE_SCHEMA_VERSION = 1
_EXTENSION_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$")


class ExtensionApprovalStateError(ValueError):
    """Raised when approval state is malformed or cannot be persisted safely."""


@dataclass(frozen=True)
class ExtensionApproval:
    digest: str
    version: str
    approved_at: float
    enabled: bool


class ExtensionApprovalStore:
    def __init__(self, state_path: Path, *, now: Callable[[], float] = time) -> None:
        self._state_path = state_path
        self._now = now
        self._lock = threading.Lock()

    @property
    def state_path(self) -> Path:
        return self._state_path

    def list(self) -> dict[str, ExtensionApproval]:
        with self._lock:
            return self._read_unlocked()

    def get(self, extension_id: str) -> ExtensionApproval | None:
        return self.list().get(extension_id)

    def approve(self, extension_id: str, digest: str, version: str) -> ExtensionApproval:
        return self._record_decision(extension_id, digest, version, enabled=True)

    def decline(self, extension_id: str, digest: str, version: str) -> ExtensionApproval:
        """Remember a refusal for exactly this digest.

        A declined package is indistinguishable from a disabled one: the user
        knows about it and it must not activate. Binding the record to the
        reviewed digest is what stops the prompt from returning until the
        package changes again.
        """

        return self._record_decision(extension_id, digest, version, enabled=False)

    def _record_decision(
        self,
        extension_id: str,
        digest: str,
        version: str,
        *,
        enabled: bool,
    ) -> ExtensionApproval:
        if not _EXTENSION_ID_PATTERN.fullmatch(extension_id):
            raise ExtensionApprovalStateError("extension ID is invalid")
        if not is_package_digest(digest):
            raise ExtensionApprovalStateError(
                "approval digest is not a valid SHA-256 package digest"
            )
        if not version.strip():
            raise ExtensionApprovalStateError("extension version cannot be empty")

        with self._lock:
            approvals = self._read_unlocked()
            approved_at = float(self._now())
            if not math.isfinite(approved_at):
                raise ExtensionApprovalStateError("approval timestamp must be finite")
            approval = ExtensionApproval(
                digest=digest,
                version=version,
                approved_at=approved_at,
                enabled=enabled,
            )
            approvals[extension_id] = approval
            self._write_unlocked(approvals)
            return approval

    def disable(self, extension_id: str) -> bool:
        with self._lock:
            approvals = self._read_unlocked()
            current = approvals.get(extension_id)
            if current is None:
                return False
            approvals[extension_id] = ExtensionApproval(
                digest=current.digest,
                version=current.version,
                approved_at=current.approved_at,
                enabled=False,
            )
            self._write_unlocked(approvals)
            return True

    def revoke(self, extension_id: str) -> bool:
        with self._lock:
            approvals = self._read_unlocked()
            if extension_id not in approvals:
                return False
            del approvals[extension_id]
            self._write_unlocked(approvals)
            return True

    def _read_unlocked(self) -> dict[str, ExtensionApproval]:
        if not self._state_path.exists():
            return {}
        if self._state_path.is_symlink() or not self._state_path.is_file():
            raise ExtensionApprovalStateError("approval state must be a regular file")

        try:
            raw = json.loads(
                self._state_path.read_text(encoding="utf-8"),
                object_pairs_hook=_reject_duplicate_keys,
            )
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ExtensionApprovalStateError(f"cannot read approval state: {exc}") from exc

        if (
            not isinstance(raw, dict)
            or set(raw) != {"schemaVersion", "approvals"}
            or raw.get("schemaVersion") != _STATE_SCHEMA_VERSION
        ):
            raise ExtensionApprovalStateError("approval state has an unsupported schema")
        raw_approvals = raw.get("approvals")
        if not isinstance(raw_approvals, dict):
            raise ExtensionApprovalStateError("approval state is missing approvals")

        approvals: dict[str, ExtensionApproval] = {}
        for extension_id, value in raw_approvals.items():
            if (
                not isinstance(extension_id, str)
                or not _EXTENSION_ID_PATTERN.fullmatch(extension_id)
                or not isinstance(value, dict)
                or set(value) != {"digest", "version", "approved_at", "enabled"}
            ):
                raise ExtensionApprovalStateError(
                    "approval state contains an invalid entry"
                )
            try:
                digest = value["digest"]
                version = value["version"]
                approved_at = value["approved_at"]
                enabled = value["enabled"]
            except KeyError as exc:
                raise ExtensionApprovalStateError(
                    f"approval for '{extension_id}' is incomplete"
                ) from exc
            if (
                not isinstance(digest, str)
                or not is_package_digest(digest)
                or not isinstance(version, str)
                or not version
                or not isinstance(approved_at, (int, float))
                or isinstance(approved_at, bool)
                or not math.isfinite(float(approved_at))
                or not isinstance(enabled, bool)
            ):
                raise ExtensionApprovalStateError(
                    f"approval for '{extension_id}' contains invalid values"
                )
            approvals[extension_id] = ExtensionApproval(
                digest=digest,
                version=version,
                approved_at=float(approved_at),
                enabled=enabled,
            )
        return approvals

    def _write_unlocked(self, approvals: dict[str, ExtensionApproval]) -> None:
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        if self._state_path.parent.is_symlink():
            raise ExtensionApprovalStateError(
                "approval state directory cannot be a symbolic link"
            )

        payload = {
            "schemaVersion": _STATE_SCHEMA_VERSION,
            "approvals": {
                extension_id: asdict(approval)
                for extension_id, approval in sorted(approvals.items())
            },
        }
        temporary_path = self._state_path.with_name(
            f".{self._state_path.name}.{uuid4().hex}.tmp"
        )
        try:
            # 0o600 is enforced on POSIX. Windows ignores POSIX mode bits but
            # still gets the same exclusive-create and atomic-replace flow.
            descriptor = os.open(
                temporary_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as state_file:
                json.dump(payload, state_file, indent=2, sort_keys=True)
                state_file.write("\n")
                state_file.flush()
                os.fsync(state_file.fileno())
            os.replace(temporary_path, self._state_path)
            _fsync_directory(self._state_path.parent)
        except OSError as exc:
            raise ExtensionApprovalStateError(f"cannot write approval state: {exc}") from exc
        finally:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ExtensionApprovalStateError(
                f"approval state contains duplicate key '{key}'"
            )
        result[key] = value
    return result


def _fsync_directory(directory: Path) -> None:
    """Best-effort rename durability on platforms that support directory fsync."""

    directory_flag = getattr(os, "O_DIRECTORY", 0)
    if os.name == "nt" or directory_flag == 0:
        return

    descriptor = -1
    try:
        descriptor = os.open(directory, os.O_RDONLY | directory_flag)
        os.fsync(descriptor)
    except OSError:
        # The approval file has already been atomically replaced. Some filesystems
        # reject directory fsync, so lack of this extra durability is non-fatal.
        return
    finally:
        if descriptor >= 0:
            os.close(descriptor)
