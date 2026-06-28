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
_STABLE_SEMVER_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$"
)
_SDK_COMPARATOR_PATTERN = re.compile(
    r"(?P<operator><=|>=|<|>|=)?(?P<version>"
    r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))"
)
_MAX_MANIFEST_BYTES = 1024 * 1024
EXTENSION_SDK_VERSION = "1.0.0"


class ExtensionManifestError(ValueError):
    """Raised when an extension manifest cannot be parsed safely."""


def _parse_stable_semver(value: str) -> tuple[int, int, int] | None:
    match = _STABLE_SEMVER_PATTERN.fullmatch(value)
    if match is None:
        return None
    return (
        int(match.group(1)),
        int(match.group(2)),
        int(match.group(3)),
    )


def _parse_sdk_range(
    declared_range: str,
) -> list[tuple[str, tuple[int, int, int]]]:
    normalized = re.sub(
        r"(<=|>=|<|>|=)\s+(?=\d)",
        r"\1",
        declared_range.strip(),
    )
    if not normalized:
        raise ValueError("extension SDK range cannot be empty")

    comparators: list[tuple[str, tuple[int, int, int]]] = []
    for token in normalized.split():
        match = _SDK_COMPARATOR_PATTERN.fullmatch(token)
        if match is None:
            raise ValueError(
                "extension SDK range must use exact stable versions or "
                "whitespace-separated comparators"
            )
        version = _parse_stable_semver(match.group("version"))
        assert version is not None
        comparators.append((match.group("operator") or "=", version))
    return comparators


def is_extension_sdk_compatible(
    declared_range: str,
    sdk_version: str = EXTENSION_SDK_VERSION,
) -> bool:
    """Evaluate the manifest v1 comparator grammar against one stable SDK."""

    version = _parse_stable_semver(sdk_version)
    if version is None:
        raise ValueError(
            "host extension SDK version must be a stable semantic version"
        )

    for operator, target in _parse_sdk_range(declared_range):
        if operator == "<" and not version < target:
            return False
        if operator == "<=" and not version <= target:
            return False
        if operator == ">" and not version > target:
            return False
        if operator == ">=" and not version >= target:
            return False
        if operator == "=" and version != target:
            return False
    return True


class _ManifestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class FrontendExtensionEntry(_ManifestModel):
    entry: str = Field(min_length=1, max_length=512)

    @field_validator("entry")
    @classmethod
    def validate_entry(cls, value: str) -> str:
        normalized = validate_package_relative_path(value, "frontend entry")
        path = PurePosixPath(normalized)
        if path.parts[:2] != ("frontend", "dist"):
            raise ValueError("frontend entry must be inside frontend/dist")
        if path.suffix not in {".js", ".mjs"}:
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
        module_name, _factory_name = normalized.split(":", 1)
        if module_name != "backend" and not module_name.startswith("backend."):
            raise ValueError("backend entry module must be inside backend/")
        return normalized


class ExtensionManifest(_ManifestModel):
    manifest_version: Literal[1] = Field(alias="manifestVersion")
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=200)
    version: str = Field(pattern=_SEMVER_PATTERN)
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

    @field_validator("name")
    @classmethod
    def strip_non_empty_string(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("value cannot be blank")
        return normalized

    @field_validator("sdk")
    @classmethod
    def validate_sdk(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("extension SDK range cannot be blank")
        if not is_extension_sdk_compatible(normalized):
            raise ValueError(
                f"extension SDK range does not include host SDK {EXTENSION_SDK_VERSION}"
            )
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
