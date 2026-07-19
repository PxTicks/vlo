"""Per-extension local key/value storage (extension-shell-surfaces plan §4).

One JSON document per extension under the backend's extension state
directory. This is the machine-scoped half of extension storage: it survives
project switches and reinstalls, is bounded per extension, and is not a
sandbox boundary — trusted extensions could reach the filesystem anyway.
"""

from __future__ import annotations

import asyncio
import json
import re
import tempfile
from pathlib import Path

# Mirrors the manifest's extension-ID grammar; storage paths derive from IDs,
# so the pattern is also the path-safety check.
_EXTENSION_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$")
_MAX_KEY_LENGTH = 128
_MAX_DOCUMENT_BYTES = 5 * 1024 * 1024


class ExtensionLocalStorageError(ValueError):
    """Raised for invalid storage requests; carries an HTTP status hint."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _assert_extension_id(extension_id: str) -> None:
    if not _EXTENSION_ID_PATTERN.fullmatch(extension_id):
        raise ExtensionLocalStorageError(
            f"Invalid extension ID {extension_id!r}.", status_code=404
        )


def _assert_key(key: str) -> None:
    if not isinstance(key, str) or not 1 <= len(key) <= _MAX_KEY_LENGTH or "/" in key:
        raise ExtensionLocalStorageError(
            f"Storage keys must be 1-{_MAX_KEY_LENGTH} characters without '/'."
        )


class ExtensionLocalStorageStore:
    """Owner-namespaced JSON documents with per-extension write locks."""

    def __init__(self, root: Path) -> None:
        self._root = root
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, extension_id: str) -> asyncio.Lock:
        lock = self._locks.get(extension_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[extension_id] = lock
        return lock

    def _path(self, extension_id: str) -> Path:
        _assert_extension_id(extension_id)
        return self._root / f"{extension_id}.json"

    def _read(self, extension_id: str) -> dict[str, object]:
        path = self._path(extension_id)
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        try:
            document = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ExtensionLocalStorageError(
                f"Stored document for {extension_id!r} is corrupt: {error}.",
                status_code=500,
            ) from error
        if not isinstance(document, dict):
            raise ExtensionLocalStorageError(
                f"Stored document for {extension_id!r} is not an object.",
                status_code=500,
            )
        return document

    def _write(self, extension_id: str, document: dict[str, object]) -> None:
        try:
            serialized = json.dumps(
                document, allow_nan=False, sort_keys=True, indent=2
            )
        except (TypeError, ValueError) as error:
            raise ExtensionLocalStorageError(
                f"Storage values must be finite JSON: {error}."
            ) from error
        if len(serialized.encode("utf-8")) > _MAX_DOCUMENT_BYTES:
            raise ExtensionLocalStorageError(
                f"Local storage for {extension_id!r} would exceed its "
                f"{_MAX_DOCUMENT_BYTES}-byte budget.",
                status_code=413,
            )
        path = self._path(extension_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            handle.write(serialized)
            handle.write("\n")
            temporary = Path(handle.name)
        temporary.replace(path)

    async def list_keys(self, extension_id: str) -> list[str]:
        async with self._lock(extension_id):
            return sorted(self._read(extension_id).keys())

    async def get(self, extension_id: str, key: str) -> tuple[bool, object]:
        _assert_key(key)
        async with self._lock(extension_id):
            document = self._read(extension_id)
        if key not in document:
            return False, None
        return True, document[key]

    async def set(self, extension_id: str, key: str, value: object) -> None:
        _assert_key(key)
        async with self._lock(extension_id):
            document = self._read(extension_id)
            document[key] = value
            self._write(extension_id, document)

    async def delete(self, extension_id: str, key: str) -> None:
        _assert_key(key)
        async with self._lock(extension_id):
            document = self._read(extension_id)
            if key not in document:
                return
            del document[key]
            if document:
                self._write(extension_id, document)
            else:
                self._path(extension_id).unlink(missing_ok=True)
