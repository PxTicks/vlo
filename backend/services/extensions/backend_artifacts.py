"""Immutable, verified staging for approved backend extension source."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Collection
from uuid import uuid4

from services.extensions.manager import ExtensionInventoryItem
from services.extensions.package_digest import (
    UnsafeExtensionPackageError,
    compute_package_digest,
    inspect_package_snapshot,
    is_package_digest,
    read_package_files_bytes,
)

_METADATA_FILE_NAME = ".vlo-backend-artifact.json"
_METADATA_SCHEMA_VERSION = 1
_EXTENSION_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$")


class BackendArtifactError(ValueError):
    """Raised when approved backend files cannot be staged or verified safely."""


@dataclass(frozen=True)
class StagedBackendArtifacts:
    extension_id: str
    digest: str
    package_dir: Path
    entry: str


class BackendArtifactStore:
    def __init__(self, root: Path, extensions_root: Path) -> None:
        resolved_root = root.resolve()
        resolved_extensions = extensions_root.resolve()
        if (
            resolved_root == resolved_extensions
            or resolved_extensions in resolved_root.parents
        ):
            raise BackendArtifactError(
                "backend artifact storage must be outside the extensions root"
            )
        self._root = root

    @property
    def root(self) -> Path:
        return self._root

    def stage(
        self,
        item: ExtensionInventoryItem,
        expected_digest: str,
    ) -> StagedBackendArtifacts | None:
        manifest = item.manifest
        if manifest is None or manifest.backend is None:
            return None
        if item.digest != expected_digest or not is_package_digest(expected_digest):
            raise BackendArtifactError("package digest changed before backend staging")

        package_snapshot = inspect_package_snapshot(item.package_dir)
        backend_paths = [
            snapshot.relative_path
            for snapshot in package_snapshot
            if PurePosixPath(snapshot.relative_path).parts[:1] == ("backend",)
        ]
        module_name, _factory_name = manifest.backend.entry.split(":", 1)
        module_path = module_name.replace(".", "/")
        entry_candidates = {f"{module_path}.py", f"{module_path}/__init__.py"}
        if not entry_candidates.intersection(backend_paths):
            raise BackendArtifactError("backend entry disappeared before staging")

        destination = self._destination(item.extension_id, expected_digest)
        staged = StagedBackendArtifacts(
            extension_id=item.extension_id,
            digest=expected_digest,
            package_dir=destination,
            entry=manifest.backend.entry,
        )
        if destination.exists():
            self._validate_destination(destination, staged)
            return staged

        extension_root = destination.parent
        self._assert_artifact_directory(extension_root)
        extension_root.mkdir(parents=True, exist_ok=True)
        self._assert_artifact_directory(extension_root)
        temporary = extension_root / f".{destination.name}.{uuid4().hex}.tmp"
        temporary.mkdir(mode=0o700)
        try:
            contents = read_package_files_bytes(item.package_dir, backend_paths)
            file_hashes: dict[str, str] = {}
            for relative_path in backend_paths:
                content = contents[relative_path]
                self._write_staged_file(temporary, relative_path, content)
                file_hashes[relative_path] = hashlib.sha256(content).hexdigest()

            if compute_package_digest(item.package_dir) != expected_digest:
                raise BackendArtifactError(
                    "package changed while backend files were staged"
                )

            self._write_metadata(temporary, staged, file_hashes)
            self._fsync_directory(temporary)
            try:
                os.replace(temporary, destination)
            except OSError:
                if not destination.exists():
                    raise
                self._validate_destination(destination, staged)
            self._fsync_directory(extension_root)
        except (OSError, UnsafeExtensionPackageError) as exc:
            raise BackendArtifactError(f"cannot stage backend artifacts: {exc}") from exc
        finally:
            if temporary.exists():
                shutil.rmtree(temporary, ignore_errors=True)

        self._validate_destination(destination, staged)
        return staged

    def verify(
        self,
        extension_id: str,
        digest: str,
        entry: str,
    ) -> StagedBackendArtifacts:
        destination = self._destination(extension_id, digest)
        staged = StagedBackendArtifacts(
            extension_id=extension_id,
            digest=digest,
            package_dir=destination,
            entry=entry,
        )
        self._validate_destination(destination, staged)
        return staged

    def prune_other_digests(self, extension_id: str, keep_digest: str) -> None:
        self.prune_digests(extension_id, {keep_digest})

    def prune_digests(
        self,
        extension_id: str,
        keep_digests: Collection[str],
    ) -> None:
        extension_root = self._extension_root(extension_id)
        keep = {
            self._destination(extension_id, digest)
            for digest in keep_digests
        }
        self._assert_artifact_directory(extension_root)
        if not extension_root.exists():
            return

        children = list(extension_root.iterdir())
        for child in children:
            if child.is_symlink() or not child.is_dir():
                raise BackendArtifactError(
                    "backend artifact storage contains an unsafe entry"
                )
        for child in children:
            if child not in keep:
                shutil.rmtree(child)
        self._fsync_directory(extension_root)

    def remove_extension(self, extension_id: str) -> None:
        extension_root = self._extension_root(extension_id)
        self._assert_artifact_directory(extension_root)
        if not extension_root.exists():
            return
        shutil.rmtree(extension_root)
        self._fsync_directory(self._root)

    def _validate_destination(
        self,
        destination: Path,
        expected: StagedBackendArtifacts,
    ) -> None:
        self._assert_no_symlink_path(self._root, destination)
        metadata = self._read_metadata(destination)
        expected_metadata = {
            "schemaVersion": _METADATA_SCHEMA_VERSION,
            "extensionId": expected.extension_id,
            "digest": expected.digest,
            "entry": expected.entry,
        }
        if any(metadata.get(key) != value for key, value in expected_metadata.items()):
            raise BackendArtifactError("staged backend artifact metadata is invalid")

        raw_hashes = metadata.get("files")
        if not isinstance(raw_hashes, dict) or not raw_hashes:
            raise BackendArtifactError("staged backend artifact file list is invalid")
        file_hashes: dict[str, str] = {}
        for relative_path, expected_hash in raw_hashes.items():
            if (
                not isinstance(relative_path, str)
                or not relative_path.startswith("backend/")
                or not isinstance(expected_hash, str)
                or len(expected_hash) != 64
            ):
                raise BackendArtifactError(
                    "staged backend artifact file list is invalid"
                )
            file_hashes[relative_path] = expected_hash

        observed_paths = self._list_staged_files(destination)
        if observed_paths != set(file_hashes):
            raise BackendArtifactError("staged backend artifact files do not match metadata")
        for relative_path, expected_hash in file_hashes.items():
            content = self._read_staged_file(destination, relative_path)
            if hashlib.sha256(content).hexdigest() != expected_hash:
                raise BackendArtifactError(
                    f"staged backend artifact is corrupt: {relative_path}"
                )

    def _destination(self, extension_id: str, digest: str) -> Path:
        if not is_package_digest(digest):
            raise BackendArtifactError("invalid package digest")
        return self._extension_root(extension_id) / digest.removeprefix("sha256:")

    def _extension_root(self, extension_id: str) -> Path:
        if not _EXTENSION_ID_PATTERN.fullmatch(extension_id):
            raise BackendArtifactError("invalid extension ID")
        return self._root / extension_id

    def _assert_artifact_directory(self, directory: Path) -> None:
        if self._root.is_symlink() or directory.is_symlink():
            raise BackendArtifactError(
                "backend artifact storage cannot be a symbolic link"
            )
        if self._root.exists() and not self._root.is_dir():
            raise BackendArtifactError("backend artifact storage must be a directory")
        if directory.exists() and not directory.is_dir():
            raise BackendArtifactError(
                "backend extension artifact storage must be a directory"
            )

    @staticmethod
    def _write_staged_file(root: Path, relative_path: str, content: bytes) -> None:
        destination = root.joinpath(*PurePosixPath(relative_path).parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "wb") as artifact_file:
            artifact_file.write(content)
            artifact_file.flush()
            os.fsync(artifact_file.fileno())

    @staticmethod
    def _write_metadata(
        destination: Path,
        staged: StagedBackendArtifacts,
        file_hashes: dict[str, str],
    ) -> None:
        payload = {
            "schemaVersion": _METADATA_SCHEMA_VERSION,
            "extensionId": staged.extension_id,
            "digest": staged.digest,
            "entry": staged.entry,
            "files": dict(sorted(file_hashes.items())),
        }
        content = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode(
            "utf-8"
        )
        metadata_path = destination / _METADATA_FILE_NAME
        descriptor = os.open(
            metadata_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "wb") as metadata_file:
            metadata_file.write(content)
            metadata_file.flush()
            os.fsync(metadata_file.fileno())

    @staticmethod
    def _read_metadata(destination: Path) -> dict[str, object]:
        metadata_path = destination / _METADATA_FILE_NAME
        if destination.is_symlink() or metadata_path.is_symlink():
            raise BackendArtifactError("staged backend artifacts cannot be symlinks")
        try:
            raw = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise BackendArtifactError("staged backend artifacts are unavailable") from exc
        if not isinstance(raw, dict):
            raise BackendArtifactError("staged backend artifact metadata is invalid")
        return raw

    def _list_staged_files(self, root: Path) -> set[str]:
        files: set[str] = set()
        for current_root, directory_names, file_names in os.walk(
            root,
            topdown=True,
            followlinks=False,
        ):
            current = Path(current_root)
            for directory_name in directory_names:
                if (current / directory_name).is_symlink():
                    raise BackendArtifactError(
                        "staged backend artifacts cannot contain symlinks"
                    )
            # Imports performed lazily by an approved extension may create bytecode
            # after activation. It is derived, non-executable approval state and is
            # excluded from package digests, so do not let it poison the next boot.
            directory_names[:] = [
                name for name in directory_names if name != "__pycache__"
            ]
            for file_name in file_names:
                path = current / file_name
                if path.is_symlink() or not path.is_file():
                    raise BackendArtifactError(
                        "staged backend artifacts must contain regular files"
                    )
                if path.suffix in {".pyc", ".pyo"}:
                    continue
                relative = path.relative_to(root).as_posix()
                if relative != _METADATA_FILE_NAME:
                    files.add(relative)
        return files

    def _read_staged_file(self, root: Path, relative_path: str) -> bytes:
        path = root.joinpath(*PurePosixPath(relative_path).parts)
        self._assert_no_symlink_path(root, path)
        try:
            expected = path.lstat()
        except OSError as exc:
            raise BackendArtifactError("staged backend artifact is unavailable") from exc
        if not stat.S_ISREG(expected.st_mode):
            raise BackendArtifactError("staged backend artifact is not regular")

        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags)
        except OSError as exc:
            raise BackendArtifactError("cannot safely open backend artifact") from exc
        try:
            opened = os.fstat(descriptor)
            if not self._same_file(expected, opened):
                raise BackendArtifactError("backend artifact changed while opening")
            with os.fdopen(descriptor, "rb") as artifact_file:
                descriptor = -1
                content = artifact_file.read()
                if not self._same_file(expected, os.fstat(artifact_file.fileno())):
                    raise BackendArtifactError("backend artifact changed while reading")
        finally:
            if descriptor >= 0:
                os.close(descriptor)
        return content

    @staticmethod
    def _assert_no_symlink_path(root: Path, path: Path) -> None:
        if root.is_symlink():
            raise BackendArtifactError("backend artifact root is a symlink")
        current = root
        for part in path.relative_to(root).parts:
            current /= part
            if current.is_symlink():
                raise BackendArtifactError("backend artifact path contains a symlink")

    @staticmethod
    def _same_file(expected: os.stat_result, observed: os.stat_result) -> bool:
        return (
            stat.S_ISREG(observed.st_mode)
            and expected.st_dev == observed.st_dev
            and expected.st_ino == observed.st_ino
            and expected.st_size == observed.st_size
            and expected.st_mtime_ns == observed.st_mtime_ns
            and expected.st_ctime_ns == observed.st_ctime_ns
        )

    @staticmethod
    def _fsync_directory(directory: Path) -> None:
        directory_flag = getattr(os, "O_DIRECTORY", 0)
        if os.name == "nt" or directory_flag == 0:
            return
        descriptor = -1
        try:
            descriptor = os.open(directory, os.O_RDONLY | directory_flag)
            os.fsync(descriptor)
        except OSError:
            return
        finally:
            if descriptor >= 0:
                os.close(descriptor)
