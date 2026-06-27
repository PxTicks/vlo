"""Declarative extension manifest parsing.

This module must remain safe to call before extension approval. It validates JSON
and package-relative entry points without importing or otherwise executing package
code.
"""

from __future__ import annotations

import json
import re
from pathlib import Path, PurePosixPath
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

_EXTENSION_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$")
_CAPABILITY_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$")
_BACKEND_ENTRY_PATTERN = re.compile(
    r"^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*"
    r":[a-zA-Z_][a-zA-Z0-9_]*$"
)
_SEMVER_PATTERN = (
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_MAX_MANIFEST_BYTES = 1024 * 1024


class ExtensionManifestError(ValueError):
    """Raised when an extension manifest cannot be parsed safely."""


class _ManifestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class FrontendExtensionEntry(_ManifestModel):
    entry: str = Field(min_length=1, max_length=512)

    @field_validator("entry")
    @classmethod
    def validate_entry(cls, value: str) -> str:
        normalized = validate_package_relative_path(value, "frontend entry")
        if PurePosixPath(normalized).suffix not in {".js", ".mjs"}:
            raise ValueError("frontend entry must be a prebuilt .js or .mjs module")
        return normalized


class BackendExtensionEntry(_ManifestModel):
    mode: Literal["in_process"]
    entry: str = Field(min_length=3, max_length=512)

    @field_validator("entry")
    @classmethod
    def validate_entry(cls, value: str) -> str:
        normalized = value.strip()
        if not _BACKEND_ENTRY_PATTERN.fullmatch(normalized):
            raise ValueError("backend entry must use 'module.path:factory_name'")
        return normalized


class ExtensionManifest(_ManifestModel):
    manifest_version: Literal[1] = Field(alias="manifestVersion")
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=200)
    version: str = Field(pattern=_SEMVER_PATTERN)
    # Range parsing belongs to the compatibility/activation slice. Phase 2A
    # preserves and bounds the declaration but does not interpret its syntax.
    sdk: str = Field(min_length=1, max_length=200)
    frontend: FrontendExtensionEntry | None = None
    backend: BackendExtensionEntry | None = None
    capabilities: list[str] = Field(default_factory=list, max_length=100)

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not _EXTENSION_ID_PATTERN.fullmatch(value):
            raise ValueError(
                "extension ID must use lowercase letters, numbers, dots, underscores, or hyphens"
            )
        return value

    @field_validator("name", "sdk")
    @classmethod
    def strip_non_empty_string(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("value cannot be blank")
        return normalized

    @field_validator("capabilities")
    @classmethod
    def validate_capabilities(cls, values: list[str]) -> list[str]:
        seen: set[str] = set()
        normalized_values: list[str] = []
        for value in values:
            normalized = value.strip()
            if not _CAPABILITY_PATTERN.fullmatch(normalized):
                raise ValueError(f"invalid capability '{value}'")
            if normalized in seen:
                raise ValueError(f"duplicate capability '{normalized}'")
            seen.add(normalized)
            normalized_values.append(normalized)
        return normalized_values

    @model_validator(mode="after")
    def require_entry_point(self) -> "ExtensionManifest":
        if self.frontend is None and self.backend is None:
            raise ValueError("manifest must declare a frontend or backend entry")
        return self


def validate_package_relative_path(value: str, label: str) -> str:
    """Return a normalized POSIX package path or raise for unsafe input."""

    normalized = value.strip()
    if not normalized or "\\" in normalized:
        raise ValueError(f"{label} must be a non-empty POSIX path")

    path = PurePosixPath(normalized)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"{label} must stay inside the extension package")
    if path.as_posix() != normalized:
        raise ValueError(f"{label} must use a normalized POSIX path")
    return normalized


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ExtensionManifestError(f"manifest contains duplicate key '{key}'")
        result[key] = value
    return result


def load_extension_manifest(manifest_path: Path) -> ExtensionManifest:
    """Read and validate one manifest without importing extension code."""

    try:
        stat = manifest_path.stat(follow_symlinks=False)
    except OSError as exc:
        raise ExtensionManifestError(f"cannot read manifest: {exc}") from exc

    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ExtensionManifestError("manifest.json must be a regular file")
    if stat.st_size > _MAX_MANIFEST_BYTES:
        raise ExtensionManifestError("manifest.json exceeds the 1 MiB size limit")

    try:
        raw = json.loads(
            manifest_path.read_text(encoding="utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ExtensionManifestError(f"manifest is not valid UTF-8 JSON: {exc}") from exc

    if not isinstance(raw, dict):
        raise ExtensionManifestError("manifest root must be a JSON object")

    try:
        return ExtensionManifest.model_validate(raw)
    except ValidationError as exc:
        raise ExtensionManifestError(f"manifest validation failed: {exc}") from exc


def backend_entry_candidates(package_dir: Path, entry: str) -> tuple[Path, Path]:
    """Return the module-file and package-init candidates for a backend entry."""

    module_name, _factory_name = entry.split(":", 1)
    module_path = package_dir.joinpath(*module_name.split("."))
    return module_path.with_suffix(".py"), module_path / "__init__.py"
