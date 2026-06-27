"""Deterministic extension package hashing with fail-closed path handling."""

from __future__ import annotations

import hashlib
import os
import stat
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

_DIGEST_PREFIX = "sha256:"
_IGNORED_DIRECTORY_NAMES = {".git", ".venv", "__pycache__", "venv"}
_IGNORED_FILE_NAMES = {".DS_Store"}
_IGNORED_FILE_SUFFIXES = {".pyc", ".pyo"}
_HASH_DOMAIN = b"vlo-extension-package-v1\0"


class UnsafeExtensionPackageError(ValueError):
    """Raised when a package contains links or non-regular filesystem entries."""


class ExtensionPackageChangedError(UnsafeExtensionPackageError):
    """Raised when package contents change while they are being inspected."""


@dataclass(frozen=True)
class PackageFileSnapshot:
    relative_path: str
    device: int
    inode: int
    size: int
    modified_ns: int
    changed_ns: int


PackageSnapshot = tuple[PackageFileSnapshot, ...]


@dataclass(frozen=True)
class _PackageFile:
    path: Path
    snapshot: PackageFileSnapshot


class _DigestWriter(Protocol):
    def update(self, data: bytes, /) -> None: ...


def is_package_digest(value: str) -> bool:
    if not value.startswith(_DIGEST_PREFIX):
        return False
    encoded = value.removeprefix(_DIGEST_PREFIX)
    return len(encoded) == 64 and all(
        character in "0123456789abcdef" for character in encoded
    )


def _snapshot_file(relative_path: str, file_stat: os.stat_result) -> PackageFileSnapshot:
    return PackageFileSnapshot(
        relative_path=relative_path,
        device=file_stat.st_dev,
        inode=file_stat.st_ino,
        size=file_stat.st_size,
        modified_ns=file_stat.st_mtime_ns,
        changed_ns=file_stat.st_ctime_ns,
    )


def _iter_package_files(package_dir: Path) -> list[_PackageFile]:
    if package_dir.is_symlink() or not package_dir.is_dir():
        raise UnsafeExtensionPackageError(
            "extension package must be a regular directory"
        )

    files: list[_PackageFile] = []
    for current_root, directory_names, file_names in os.walk(
        package_dir,
        topdown=True,
        followlinks=False,
    ):
        current_path = Path(current_root)

        retained_directories: list[str] = []
        for directory_name in sorted(directory_names):
            directory_path = current_path / directory_name
            if directory_path.is_symlink():
                relative = directory_path.relative_to(package_dir).as_posix()
                raise UnsafeExtensionPackageError(
                    f"symbolic links are not allowed in extension packages: {relative}"
                )
            if directory_name in _IGNORED_DIRECTORY_NAMES:
                continue
            retained_directories.append(directory_name)
        directory_names[:] = retained_directories

        for file_name in sorted(file_names):
            file_path = current_path / file_name
            relative = file_path.relative_to(package_dir).as_posix()
            file_stat = file_path.lstat()
            if stat.S_ISLNK(file_stat.st_mode):
                raise UnsafeExtensionPackageError(
                    f"symbolic links are not allowed in extension packages: {relative}"
                )
            if not stat.S_ISREG(file_stat.st_mode):
                raise UnsafeExtensionPackageError(
                    f"only regular files are allowed in extension packages: {relative}"
                )
            if (
                file_name in _IGNORED_FILE_NAMES
                or file_path.suffix in _IGNORED_FILE_SUFFIXES
            ):
                continue
            files.append(
                _PackageFile(
                    path=file_path,
                    snapshot=_snapshot_file(relative, file_stat),
                )
            )

    files.sort(key=lambda item: item.snapshot.relative_path)
    return files


def inspect_package_snapshot(package_dir: Path) -> PackageSnapshot:
    """Return cheap metadata used to invalidate the in-memory digest cache."""

    return tuple(package_file.snapshot for package_file in _iter_package_files(package_dir))


def _assert_same_file(
    expected: PackageFileSnapshot,
    observed: os.stat_result,
) -> None:
    if not stat.S_ISREG(observed.st_mode):
        raise UnsafeExtensionPackageError(
            f"package file is no longer regular: {expected.relative_path}"
        )

    observed_snapshot = _snapshot_file(expected.relative_path, observed)
    if observed_snapshot != expected:
        raise ExtensionPackageChangedError(
            f"package changed while being hashed: {expected.relative_path}"
        )


def _hash_file(
    digest: _DigestWriter,
    package_file: _PackageFile,
) -> None:
    expected = package_file.snapshot
    encoded_path = expected.relative_path.encode("utf-8")
    # O_NOFOLLOW closes the final-component swap race on platforms that expose
    # it. Windows falls back to the explicit lstat plus before/after fstat
    # identity checks below; that path should be re-audited before Windows is a
    # supported extension-host platform.
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)

    try:
        descriptor = os.open(package_file.path, flags)
    except OSError as exc:
        raise UnsafeExtensionPackageError(
            f"cannot safely open package file '{expected.relative_path}': {exc}"
        ) from exc

    try:
        opened_stat = os.fstat(descriptor)
        _assert_same_file(expected, opened_stat)

        digest.update(len(encoded_path).to_bytes(8, byteorder="big"))
        digest.update(encoded_path)
        digest.update(opened_stat.st_size.to_bytes(8, byteorder="big"))

        with os.fdopen(descriptor, "rb") as opened_file:
            descriptor = -1
            while chunk := opened_file.read(1024 * 1024):
                digest.update(chunk)
            _assert_same_file(expected, os.fstat(opened_file.fileno()))
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _read_package_file(package_file: _PackageFile) -> bytes:
    expected = package_file.snapshot
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(package_file.path, flags)
    except OSError as exc:
        raise UnsafeExtensionPackageError(
            f"cannot safely open package file '{expected.relative_path}': {exc}"
        ) from exc

    try:
        _assert_same_file(expected, os.fstat(descriptor))
        with os.fdopen(descriptor, "rb") as opened_file:
            descriptor = -1
            content = opened_file.read()
            _assert_same_file(expected, os.fstat(opened_file.fileno()))
    finally:
        if descriptor >= 0:
            os.close(descriptor)

    return content


def read_package_files_bytes(
    package_dir: Path,
    relative_paths: Iterable[str],
) -> dict[str, bytes]:
    """Read selected package files from one verified filesystem snapshot."""

    requested_paths = tuple(relative_paths)
    if len(requested_paths) != len(set(requested_paths)):
        raise UnsafeExtensionPackageError("package file paths must be unique")

    package_files = _iter_package_files(package_dir)
    initial_snapshot = tuple(item.snapshot for item in package_files)
    indexed_files = {
        package_file.snapshot.relative_path: package_file
        for package_file in package_files
    }
    missing_paths = [path for path in requested_paths if path not in indexed_files]
    if missing_paths:
        raise UnsafeExtensionPackageError(
            f"package file does not exist: {missing_paths[0]}"
        )

    contents = {
        path: _read_package_file(indexed_files[path])
        for path in requested_paths
    }

    if inspect_package_snapshot(package_dir) != initial_snapshot:
        raise ExtensionPackageChangedError(
            "package changed while reading selected files"
        )
    return contents


def read_package_file_bytes(package_dir: Path, relative_path: str) -> bytes:
    """Read one regular package file while detecting path/content races."""

    return read_package_files_bytes(package_dir, (relative_path,))[relative_path]


def compute_package_digest(package_dir: Path) -> str:
    """Hash canonical paths, sizes, and bytes for one stable package snapshot.

    This is intentionally a content digest: file permission bits and empty
    directories are not included because they do not affect JS/Python module
    contents. Approval and activation must always call this full byte-hash path,
    even when inventory listing uses its metadata cache.
    """

    package_files = _iter_package_files(package_dir)
    initial_snapshot = tuple(item.snapshot for item in package_files)
    digest = hashlib.sha256()
    digest.update(_HASH_DOMAIN)

    for package_file in package_files:
        _hash_file(digest, package_file)

    if inspect_package_snapshot(package_dir) != initial_snapshot:
        raise ExtensionPackageChangedError("package changed while being hashed")

    return f"{_DIGEST_PREFIX}{digest.hexdigest()}"
