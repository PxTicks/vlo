"""Ephemeral, owner-scoped byte exchange for host and extension jobs."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import threading
import time
from dataclasses import dataclass, replace
from pathlib import Path, PurePath
from typing import Callable, Literal
from uuid import uuid4


DEFAULT_MAX_JOB_ARTIFACT_BYTES = 512 * 1024 * 1024
_OWNER_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$")
_ARTIFACT_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")

ArtifactRole = Literal["input", "output"]


class JobArtifactError(ValueError):
    """Raised when an ephemeral job artifact is invalid or unavailable."""


class JobArtifactNotFoundError(JobArtifactError):
    """Raised when an artifact is absent or belongs to another owner or job."""


class JobArtifactTooLargeError(JobArtifactError):
    """Raised before publishing an artifact over the configured byte limit."""


@dataclass(frozen=True)
class JobArtifactRecord:
    artifact_id: str
    owner_id: str
    role: ArtifactRole
    filename: str
    content_type: str
    size: int
    sha256: str
    created_at: float
    job_id: str | None = None

    @property
    def extension_id(self) -> str:
        """Compatibility alias for the public extension job contract."""

        return self.owner_id

    def to_dict(self) -> dict[str, object]:
        return {
            "artifactId": self.artifact_id,
            "role": self.role,
            "filename": self.filename,
            "contentType": self.content_type,
            "size": self.size,
            "sha256": self.sha256,
        }


class JobArtifactStore:
    """Disk-backed artifacts with opaque handles and in-memory ownership metadata.

    Artifacts are intentionally ephemeral. The root is cleared when the backend
    starts, so handles never survive a process restart and cannot be confused with
    project assets or approved package source.
    """

    def __init__(
        self,
        root: Path,
        *,
        max_artifact_bytes: int = DEFAULT_MAX_JOB_ARTIFACT_BYTES,
        now: Callable[[], float] = time.time,
    ) -> None:
        if max_artifact_bytes <= 0:
            raise ValueError("max_artifact_bytes must be positive")
        self._root = root
        self._max_artifact_bytes = max_artifact_bytes
        self._now = now
        self._lock = threading.RLock()
        self._records: dict[str, JobArtifactRecord] = {}
        self._prepare_empty_root()

    @property
    def root(self) -> Path:
        return self._root

    @property
    def max_artifact_bytes(self) -> int:
        return self._max_artifact_bytes

    def create_input(
        self,
        owner_id: str,
        content: bytes,
        *,
        filename: str,
        content_type: str,
    ) -> JobArtifactRecord:
        return self._create(
            owner_id,
            content,
            role="input",
            filename=filename,
            content_type=content_type,
            job_id=None,
        )

    def create_output(
        self,
        owner_id: str,
        job_id: str,
        content: bytes,
        *,
        filename: str,
        content_type: str,
    ) -> JobArtifactRecord:
        if not job_id:
            raise JobArtifactError("job_id must be non-empty")
        return self._create(
            owner_id,
            content,
            role="output",
            filename=filename,
            content_type=content_type,
            job_id=job_id,
        )

    def claim_inputs(
        self,
        owner_id: str,
        job_id: str,
        artifact_ids: tuple[str, ...],
    ) -> tuple[JobArtifactRecord, ...]:
        if len(set(artifact_ids)) != len(artifact_ids):
            raise JobArtifactError("input artifact IDs must be unique")
        with self._lock:
            records: list[JobArtifactRecord] = []
            for artifact_id in artifact_ids:
                record = self._get_record(owner_id, artifact_id)
                if record.role != "input":
                    raise JobArtifactError(
                        f"artifact '{artifact_id}' is not a job input"
                    )
                if record.job_id not in (None, job_id):
                    raise JobArtifactError(
                        f"artifact '{artifact_id}' is already claimed"
                    )
                records.append(record)
            claimed = tuple(replace(record, job_id=job_id) for record in records)
            for record in claimed:
                self._records[record.artifact_id] = record
            return claimed

    def read_for_job(
        self,
        owner_id: str,
        job_id: str,
        artifact_id: str,
    ) -> bytes:
        with self._lock:
            record = self._get_record(owner_id, artifact_id)
            if record.job_id != job_id:
                raise JobArtifactNotFoundError(
                    f"artifact '{artifact_id}' does not belong to job '{job_id}'"
                )
            path = self._artifact_path(record.owner_id, record.artifact_id)
            try:
                content = path.read_bytes()
            except OSError as exc:
                raise JobArtifactNotFoundError(
                    f"artifact '{artifact_id}' is unavailable"
                ) from exc
            if (
                len(content) != record.size
                or hashlib.sha256(content).hexdigest() != record.sha256
            ):
                raise JobArtifactError(
                    f"artifact '{artifact_id}' failed its integrity check"
                )
            return content

    def get_for_delivery(
        self,
        owner_id: str,
        artifact_id: str,
    ) -> tuple[JobArtifactRecord, bytes]:
        with self._lock:
            record = self._get_record(owner_id, artifact_id)
            if record.job_id is None:
                raise JobArtifactNotFoundError(
                    f"artifact '{artifact_id}' has not been assigned to a job"
                )
            return record, self.read_for_job(owner_id, record.job_id, artifact_id)

    def list_for_job(
        self,
        owner_id: str,
        job_id: str,
        *,
        role: ArtifactRole | None = None,
    ) -> tuple[JobArtifactRecord, ...]:
        with self._lock:
            return tuple(
                sorted(
                    (
                        record
                        for record in self._records.values()
                        if record.owner_id == owner_id
                        and record.job_id == job_id
                        and (role is None or record.role == role)
                    ),
                    key=lambda record: record.created_at,
                )
            )

    def count_unclaimed(self, owner_id: str) -> int:
        self._validate_owner_id(owner_id)
        with self._lock:
            return sum(
                1
                for record in self._records.values()
                if record.owner_id == owner_id and record.job_id is None
            )

    def remove_job(self, owner_id: str, job_id: str) -> None:
        with self._lock:
            artifact_ids = [
                record.artifact_id
                for record in self._records.values()
                if record.owner_id == owner_id and record.job_id == job_id
            ]
            for artifact_id in artifact_ids:
                self._remove_record(artifact_id)

    def remove_unclaimed_older_than(self, cutoff: float) -> None:
        with self._lock:
            artifact_ids = [
                record.artifact_id
                for record in self._records.values()
                if record.job_id is None and record.created_at < cutoff
            ]
            for artifact_id in artifact_ids:
                self._remove_record(artifact_id)

    def remove_owner(self, owner_id: str) -> None:
        self._validate_owner_id(owner_id)
        with self._lock:
            artifact_ids = [
                record.artifact_id
                for record in self._records.values()
                if record.owner_id == owner_id
            ]
            for artifact_id in artifact_ids:
                self._records.pop(artifact_id, None)
            owner_root = self._root / owner_id
            if owner_root.exists():
                if owner_root.is_symlink():
                    raise JobArtifactError(
                        "job artifact owner root cannot be a symlink"
                    )
                shutil.rmtree(owner_root)

    def _create(
        self,
        owner_id: str,
        content: bytes,
        *,
        role: ArtifactRole,
        filename: str,
        content_type: str,
        job_id: str | None,
    ) -> JobArtifactRecord:
        self._validate_owner_id(owner_id)
        if not isinstance(content, bytes):
            raise TypeError("job artifact content must be bytes")
        if len(content) > self._max_artifact_bytes:
            raise JobArtifactTooLargeError(
                f"artifact exceeds {self._max_artifact_bytes} bytes"
            )
        normalized_name = self._normalize_filename(filename)
        normalized_type = self._normalize_content_type(content_type)
        artifact_id = uuid4().hex
        owner_root = self._root / owner_id
        with self._lock:
            self._assert_safe_root()
            owner_root.mkdir(mode=0o700, parents=True, exist_ok=True)
            if owner_root.is_symlink() or not owner_root.is_dir():
                raise JobArtifactError(
                    "job artifact owner root must be a directory"
                )
            path = self._artifact_path(owner_id, artifact_id)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            flags |= getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(path, flags, 0o600)
            try:
                with os.fdopen(descriptor, "wb") as output:
                    output.write(content)
                    output.flush()
                    os.fsync(output.fileno())
            except Exception:
                path.unlink(missing_ok=True)
                raise
            record = JobArtifactRecord(
                artifact_id=artifact_id,
                owner_id=owner_id,
                role=role,
                filename=normalized_name,
                content_type=normalized_type,
                size=len(content),
                sha256=hashlib.sha256(content).hexdigest(),
                created_at=float(self._now()),
                job_id=job_id,
            )
            self._records[artifact_id] = record
            return record

    def _get_record(
        self,
        owner_id: str,
        artifact_id: str,
    ) -> JobArtifactRecord:
        self._validate_owner_id(owner_id)
        if not _ARTIFACT_ID_PATTERN.fullmatch(artifact_id):
            raise JobArtifactNotFoundError("artifact was not found")
        record = self._records.get(artifact_id)
        if record is None or record.owner_id != owner_id:
            raise JobArtifactNotFoundError("artifact was not found")
        return record

    def _remove_record(self, artifact_id: str) -> None:
        record = self._records.pop(artifact_id, None)
        if record is None:
            return
        self._artifact_path(record.owner_id, artifact_id).unlink(missing_ok=True)
        owner_root = self._root / record.owner_id
        try:
            owner_root.rmdir()
        except OSError:
            pass

    def _artifact_path(self, owner_id: str, artifact_id: str) -> Path:
        return self._root / owner_id / f"{artifact_id}.blob"

    def _prepare_empty_root(self) -> None:
        if self._root.is_symlink():
            raise JobArtifactError("job artifact root cannot be a symlink")
        if self._root.exists() and not self._root.is_dir():
            raise JobArtifactError("job artifact root must be a directory")
        self._root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._assert_safe_root()
        for child in self._root.iterdir():
            if child.is_symlink():
                child.unlink()
            elif child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()

    def _assert_safe_root(self) -> None:
        if self._root.is_symlink() or not self._root.is_dir():
            raise JobArtifactError("job artifact root is unsafe")

    @staticmethod
    def _validate_owner_id(owner_id: str) -> None:
        if not _OWNER_ID_PATTERN.fullmatch(owner_id):
            raise JobArtifactError("invalid job owner ID")

    def remove_extension(self, extension_id: str) -> None:
        """Compatibility alias for extension-host callers."""

        self.remove_owner(extension_id)

    @staticmethod
    def _normalize_filename(filename: str) -> str:
        normalized = filename.strip()
        if (
            not normalized
            or len(normalized) > 255
            or PurePath(normalized).name != normalized
            or normalized in {".", ".."}
        ):
            raise JobArtifactError("artifact filename is invalid")
        return normalized

    @staticmethod
    def _normalize_content_type(content_type: str) -> str:
        normalized = content_type.strip().lower()
        if not normalized or len(normalized) > 200 or any(
            character in normalized for character in "\r\n"
        ):
            raise JobArtifactError("artifact content type is invalid")
        return normalized
