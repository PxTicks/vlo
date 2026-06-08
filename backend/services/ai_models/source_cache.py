from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Generic, TypeVar, cast


JsonObject = dict[str, object]
TMetadata = TypeVar("TMetadata")


def sanitize_source_hash(source_hash: str) -> str:
    sanitized = "".join(ch for ch in source_hash.strip() if ch.isalnum() or ch in "-_")
    if not sanitized:
        raise ValueError("source_hash must contain at least one valid character")
    return sanitized


class JsonSourceCache(Generic[TMetadata]):
    def __init__(
        self,
        *,
        metadata_dir: Callable[[], Path],
        from_json: Callable[[JsonObject], TMetadata],
        to_json: Callable[[TMetadata], JsonObject],
        source_id: Callable[[TMetadata], str],
        path: Callable[[TMetadata], Path],
    ) -> None:
        self._metadata_dir = metadata_dir
        self._from_json = from_json
        self._to_json = to_json
        self._source_id = source_id
        self._path = path

    def metadata_path(self, source_id: str) -> Path:
        return self._metadata_dir() / f"{source_id}.json"

    def load(self, source_id: str) -> TMetadata | None:
        metadata_path = self.metadata_path(source_id)
        if not metadata_path.exists():
            return None

        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                return None
            metadata = self._from_json(cast(JsonObject, payload))
            if not self._path(metadata).exists():
                return None
            return metadata
        except Exception:
            return None

    def save(self, metadata: TMetadata) -> None:
        self.metadata_path(self._source_id(metadata)).write_text(
            json.dumps(self._to_json(metadata), indent=2),
            encoding="utf-8",
        )

