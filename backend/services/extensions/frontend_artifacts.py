"""Content-addressed storage for approved frontend extension bundles."""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from uuid import uuid4

from services.extensions.manager import ExtensionInventoryItem
from services.extensions.manifest import validate_package_relative_path
from services.extensions.package_digest import (
    UnsafeExtensionPackageError,
    compute_package_digest,
    inspect_package_snapshot,
    is_package_digest,
    read_package_files_bytes,
)

_METADATA_FILE_NAME = ".vlo-artifact.json"
_METADATA_SCHEMA_VERSION = 1
_EXTENSION_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$")


class FrontendArtifactError(ValueError):
    """Raised when approved frontend artifacts cannot be staged or read safely."""


@dataclass(frozen=True)
class StagedFrontendArtifacts:
    extension_id: str
    digest: str
    entry_path: str


class FrontendArtifactStore:
    def __init__(self, root: Path, extensions_root: Path) -> None:
        resolved_root = root.resolve()
        resolved_extensions = extensions_root.resolve()
        if (
            resolved_root == resolved_extensions
            or resolved_extensions in resolved_root.parents
        ):
            raise FrontendArtifactError(
                "frontend artifact storage must be outside the extensions root"
            )
        self._root = root

    @property
    def root(self) -> Path:
        return self._root

    def stage(
        self,
        item: ExtensionInventoryItem,
        expected_digest: str,
    ) -> StagedFrontendArtifacts | None:
        manifest = item.manifest
        if manifest is None or manifest.frontend is None:
            return None
        if item.digest != expected_digest or not is_package_digest(expected_digest):
            raise FrontendArtifactError("package digest changed before artifact staging")

        entry = PurePosixPath(manifest.frontend.entry)
        bundle_root = entry.parent
        entry_path = entry.relative_to(bundle_root).as_posix()
        package_snapshot = inspect_package_snapshot(item.package_dir)
        artifact_paths = [
            snapshot.relative_path
            for snapshot in package_snapshot
            if PurePosixPath(snapshot.relative_path).is_relative_to(bundle_root)
        ]
        if manifest.frontend.entry not in artifact_paths:
            raise FrontendArtifactError("frontend entry disappeared before staging")

        destination = self._destination(item.extension_id, expected_digest)
        staged = StagedFrontendArtifacts(
            extension_id=item.extension_id,
            digest=expected_digest,
            entry_path=entry_path,
        )
        if destination.exists():
            self._validate_staged_metadata(destination, staged)
            return staged

        destination.parent.mkdir(parents=True, exist_ok=True)
        if self._root.is_symlink() or destination.parent.is_symlink():
            raise FrontendArtifactError("frontend artifact storage cannot be a symbolic link")

        temporary = destination.parent / f".{destination.name}.{uuid4().hex}.tmp"
        temporary.mkdir(mode=0o700)
        try:
            contents = read_package_files_bytes(item.package_dir, artifact_paths)
            for package_relative in artifact_paths:
                source_relative = PurePosixPath(package_relative)
                staged_relative = source_relative.relative_to(bundle_root)
                self._write_staged_file(
                    temporary,
                    staged_relative,
                    contents[package_relative],
                )

            if compute_package_digest(item.package_dir) != expected_digest:
                raise FrontendArtifactError(
                    "package changed while frontend artifacts were staged"
                )

            self._write_metadata(temporary, staged)
            try:
                os.replace(temporary, destination)
            except OSError:
                if not destination.exists():
                    raise
                self._validate_staged_metadata(destination, staged)
            self._fsync_directory(destination.parent)
        except (OSError, UnsafeExtensionPackageError) as exc:
            raise FrontendArtifactError(f"cannot stage frontend artifacts: {exc}") from exc
        finally:
            if temporary.exists():
                shutil.rmtree(temporary, ignore_errors=True)

        return staged

    def prune_other_digests(self, extension_id: str, keep_digest: str) -> None:
        """Remove superseded staged bundles after a new approval is durable."""

        extension_root = self._extension_root(extension_id)
        keep = self._destination(extension_id, keep_digest)
        self._assert_artifact_directory(extension_root)
        if not extension_root.exists():
            return

        children = list(extension_root.iterdir())
        for child in children:
            if child.is_symlink() or not child.is_dir():
                raise FrontendArtifactError(
                    "frontend artifact storage contains an unsafe entry"
                )
        for child in children:
            if child == keep:
                continue
            shutil.rmtree(child)
        self._fsync_directory(extension_root)

    def remove_extension(self, extension_id: str) -> None:
        """Remove every staged bundle when an extension approval is revoked."""

        extension_root = self._extension_root(extension_id)
        self._assert_artifact_directory(extension_root)
        if not extension_root.exists():
            return
        shutil.rmtree(extension_root)
        self._fsync_directory(self._root)

    def has(self, extension_id: str, digest: str) -> bool:
        try:
            destination = self._destination(extension_id, digest)
            self._assert_no_symlink_path(self._root, destination)
            metadata = self._read_metadata(destination)
        except FrontendArtifactError:
            return False
        entry_path = metadata.get("entryPath")
        if (
            metadata.get("extensionId") != extension_id
            or metadata.get("digest") != digest
            or not isinstance(entry_path, str)
        ):
            return False
        try:
            normalized_entry = validate_package_relative_path(
                entry_path,
                "staged frontend entry",
            )
            entry = destination.joinpath(*PurePosixPath(normalized_entry).parts)
            self._assert_no_symlink_path(destination, entry)
            return entry.is_file()
        except (FrontendArtifactError, ValueError):
            return False

    def read(self, extension_id: str, digest: str, artifact_path: str) -> bytes:
        try:
            normalized_path = validate_package_relative_path(
                artifact_path,
                "frontend artifact path",
            )
        except ValueError as exc:
            raise FrontendArtifactError("invalid frontend artifact path") from exc
        if PurePosixPath(normalized_path).name == _METADATA_FILE_NAME:
            raise FrontendArtifactError("frontend artifact does not exist")

        destination = self._destination(extension_id, digest)
        self._assert_no_symlink_path(self._root, destination)
        metadata = self._read_metadata(destination)
        if (
            metadata.get("extensionId") != extension_id
            or metadata.get("digest") != digest
        ):
            raise FrontendArtifactError("staged frontend artifact metadata is invalid")

        artifact = destination.joinpath(*PurePosixPath(normalized_path).parts)
        self._assert_no_symlink_path(destination, artifact)
        try:
            expected = artifact.lstat()
        except OSError as exc:
            raise FrontendArtifactError("frontend artifact does not exist") from exc
        if not stat.S_ISREG(expected.st_mode):
            raise FrontendArtifactError("frontend artifact is not a regular file")

        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(artifact, flags)
        except OSError as exc:
            raise FrontendArtifactError("cannot safely open frontend artifact") from exc
        try:
            opened = os.fstat(descriptor)
            if not self._same_file(expected, opened):
                raise FrontendArtifactError("frontend artifact changed while opening")
            with os.fdopen(descriptor, "rb") as artifact_file:
                descriptor = -1
                content = artifact_file.read()
                if not self._same_file(expected, os.fstat(artifact_file.fileno())):
                    raise FrontendArtifactError("frontend artifact changed while reading")
        finally:
            if descriptor >= 0:
                os.close(descriptor)
        return content

    def _destination(self, extension_id: str, digest: str) -> Path:
        if not is_package_digest(digest):
            raise FrontendArtifactError("invalid package digest")
        return self._extension_root(extension_id) / digest.removeprefix("sha256:")

    def _extension_root(self, extension_id: str) -> Path:
        if not _EXTENSION_ID_PATTERN.fullmatch(extension_id):
            raise FrontendArtifactError("invalid extension ID")
        return self._root / extension_id

    def _assert_artifact_directory(self, directory: Path) -> None:
        if self._root.is_symlink() or directory.is_symlink():
            raise FrontendArtifactError(
                "frontend artifact storage cannot be a symbolic link"
            )
        if self._root.exists() and not self._root.is_dir():
            raise FrontendArtifactError(
                "frontend artifact storage must be a directory"
            )
        if directory.exists() and not directory.is_dir():
            raise FrontendArtifactError(
                "frontend extension artifact storage must be a directory"
            )

    @staticmethod
    def _write_staged_file(
        root: Path,
        relative_path: PurePosixPath,
        content: bytes,
    ) -> None:
        destination = root.joinpath(*relative_path.parts)
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
        staged: StagedFrontendArtifacts,
    ) -> None:
        payload = {
            "schemaVersion": _METADATA_SCHEMA_VERSION,
            "extensionId": staged.extension_id,
            "digest": staged.digest,
            "entryPath": staged.entry_path,
        }
        metadata_path = destination / _METADATA_FILE_NAME
        content = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode(
            "utf-8"
        )
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
            raise FrontendArtifactError("staged frontend artifacts cannot be symlinks")
        try:
            raw = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise FrontendArtifactError("staged frontend artifacts are unavailable") from exc
        if (
            not isinstance(raw, dict)
            or raw.get("schemaVersion") != _METADATA_SCHEMA_VERSION
        ):
            raise FrontendArtifactError("staged frontend artifact metadata is invalid")
        return raw

    @classmethod
    def _validate_staged_metadata(
        cls,
        destination: Path,
        expected: StagedFrontendArtifacts,
    ) -> None:
        raw = cls._read_metadata(destination)
        if raw != {
            "schemaVersion": _METADATA_SCHEMA_VERSION,
            "extensionId": expected.extension_id,
            "digest": expected.digest,
            "entryPath": expected.entry_path,
        }:
            raise FrontendArtifactError("staged frontend artifact metadata is invalid")

    @staticmethod
    def _assert_no_symlink_path(root: Path, path: Path) -> None:
        if root.is_symlink():
            raise FrontendArtifactError("frontend artifact root is a symlink")
        current = root
        for part in path.relative_to(root).parts:
            current /= part
            if current.is_symlink():
                raise FrontendArtifactError("frontend artifact path contains a symlink")

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
