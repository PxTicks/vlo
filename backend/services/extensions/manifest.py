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
# Activation events are a closed host vocabulary, validated before approval so a
# typo is a manifest error rather than a package that silently never activates.
_STATIC_ACTIVATION_EVENTS = frozenset({"onStartup", "onProjectOpen"})
_EXTENSION_EVENT_PREFIX = "onExtension:"
# A dependency's probe name must be a single top-level Python identifier. This
# keeps the preflight importability check inert: locating a top-level module spec
# never executes package code, whereas a dotted probe would import parent packages.
_PYTHON_MODULE_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
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
_MAX_LUT_CATALOG_BYTES = 1024 * 1024
MAX_EXTENSION_LUT_BYTES = 16 * 1024 * 1024
# Runtime deployments do not need the TypeScript authoring package. Its package
# version is the release authority, with a contract test keeping this copy aligned.
EXTENSION_SDK_VERSION = "1.19.0"


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


def _parse_stable_semver_range(
    declared_range: str,
) -> list[tuple[str, tuple[int, int, int]]]:
    normalized = re.sub(
        r"(<=|>=|<|>|=)\s+(?=\d)",
        r"\1",
        declared_range.strip(),
    )
    if not normalized:
        raise ValueError("extension version range cannot be empty")

    comparators: list[tuple[str, tuple[int, int, int]]] = []
    for token in normalized.split():
        match = _SDK_COMPARATOR_PATTERN.fullmatch(token)
        if match is None:
            raise ValueError(
                "extension version range must use exact stable versions or "
                "whitespace-separated comparators"
            )
        version = _parse_stable_semver(match.group("version"))
        assert version is not None
        comparators.append((match.group("operator") or "=", version))
    return comparators


def is_stable_semver_range_compatible(
    declared_range: str,
    host_version: str,
) -> bool:
    """Evaluate the shared comparator grammar against one stable host version."""

    version = _parse_stable_semver(host_version)
    if version is None:
        raise ValueError("host version must be a stable semantic version")

    for operator, target in _parse_stable_semver_range(declared_range):
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


def is_extension_sdk_compatible(
    declared_range: str,
    sdk_version: str = EXTENSION_SDK_VERSION,
) -> bool:
    """Evaluate the shared grammar against the supported SDK version."""

    return is_stable_semver_range_compatible(declared_range, sdk_version)


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


class PythonDependency(_ManifestModel):
    """One declared Python import the backend needs at runtime.

    Dependencies are advisory metadata for a preflight checklist, never an
    installation instruction. The host probes ``module`` for importability and
    surfaces ``distribution``/``purpose`` to the user; it never installs anything.
    """

    module: str = Field(min_length=1, max_length=128)
    distribution: str | None = Field(default=None, max_length=200)
    purpose: str | None = Field(default=None, max_length=200)

    @field_validator("module")
    @classmethod
    def validate_module(cls, value: str) -> str:
        normalized = value.strip()
        if not _PYTHON_MODULE_PATTERN.fullmatch(normalized):
            raise ValueError(
                "python dependency module must be a single top-level import name"
            )
        return normalized

    @field_validator("distribution", "purpose")
    @classmethod
    def strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            return None
        if any(character in normalized for character in "\r\n\t"):
            raise ValueError("value cannot contain control characters")
        return normalized


class ExtensionContributions(_ManifestModel):
    """Declarative package contributions that require no executable entry."""

    luts: str | None = Field(default=None, min_length=1, max_length=512)

    @field_validator("luts")
    @classmethod
    def validate_lut_catalog(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = validate_package_relative_path(value, "LUT catalogue")
        if PurePosixPath(normalized).suffix.lower() != ".json":
            raise ValueError("LUT catalogue must be a .json file")
        return normalized


class ExtensionLutContribution(_ManifestModel):
    id: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=200)
    path: str = Field(min_length=1, max_length=512)
    description: str | None = Field(default=None, max_length=500)
    order: float = Field(default=0, allow_inf_nan=False)

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not _EXTENSION_ID_PATTERN.fullmatch(value):
            raise ValueError(
                "LUT ID must use lowercase letters, numbers, dots, underscores, or hyphens"
            )
        return value

    @field_validator("label")
    @classmethod
    def validate_label(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("LUT label cannot be blank")
        return normalized

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        normalized = validate_package_relative_path(value, "LUT resource")
        if PurePosixPath(normalized).suffix.lower() != ".cube":
            raise ValueError("LUT resource must be a .cube file")
        return normalized

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class ExtensionLutCatalog(_ManifestModel):
    api_version: Literal[1] = Field(alias="apiVersion")
    luts: list[ExtensionLutContribution] = Field(min_length=1, max_length=500)

    @field_validator("luts")
    @classmethod
    def validate_unique_ids(
        cls,
        values: list[ExtensionLutContribution],
    ) -> list[ExtensionLutContribution]:
        seen: set[str] = set()
        for value in values:
            if value.id in seen:
                raise ValueError(f"duplicate LUT ID '{value.id}'")
            seen.add(value.id)
        return values


class ExtensionManifest(_ManifestModel):
    manifest_version: Literal[1] = Field(alias="manifestVersion")
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=200)
    version: str = Field(pattern=_SEMVER_PATTERN)
    sdk: str = Field(min_length=1, max_length=200)
    vlo: str | None = Field(default=None, min_length=1, max_length=200)
    frontend: FrontendExtensionEntry | None = None
    backend: BackendExtensionEntry | None = None
    contributions: ExtensionContributions | None = None
    capabilities: list[str] = Field(default_factory=list, max_length=100)
    activation_events: list[str] = Field(
        default_factory=list,
        alias="activationEvents",
        max_length=50,
    )
    dependencies: dict[str, str] = Field(default_factory=dict, max_length=50)
    python_dependencies: list[PythonDependency] = Field(
        default_factory=list,
        alias="pythonDependencies",
        max_length=100,
    )

    @field_validator("activation_events")
    @classmethod
    def validate_activation_events(cls, values: list[str]) -> list[str]:
        seen: set[str] = set()
        normalized_values: list[str] = []
        for value in values:
            normalized = value.strip()
            if normalized in _STATIC_ACTIVATION_EVENTS:
                pass
            elif normalized.startswith(_EXTENSION_EVENT_PREFIX):
                target = normalized[len(_EXTENSION_EVENT_PREFIX) :]
                if not _EXTENSION_ID_PATTERN.fullmatch(target):
                    raise ValueError(
                        f"activation event '{value}' names an invalid extension ID"
                    )
            else:
                raise ValueError(f"unsupported activation event '{value}'")
            if normalized in seen:
                raise ValueError(f"duplicate activation event '{normalized}'")
            seen.add(normalized)
            normalized_values.append(normalized)
        return normalized_values

    @field_validator("dependencies")
    @classmethod
    def validate_dependencies(cls, values: dict[str, str]) -> dict[str, str]:
        normalized_values: dict[str, str] = {}
        for extension_id, declared_range in values.items():
            if not _EXTENSION_ID_PATTERN.fullmatch(extension_id):
                raise ValueError(f"invalid dependency extension ID '{extension_id}'")
            if not isinstance(declared_range, str):
                raise ValueError(
                    f"dependency '{extension_id}' must declare a version range"
                )
            normalized_range = declared_range.strip()
            if not normalized_range:
                raise ValueError(
                    f"dependency '{extension_id}' version range cannot be blank"
                )
            # Same comparator grammar as the SDK and VLO ranges, so an author
            # learns one syntax for every version declaration in the manifest.
            _parse_stable_semver_range(normalized_range)
            normalized_values[extension_id] = normalized_range
        return normalized_values

    @field_validator("python_dependencies")
    @classmethod
    def validate_python_dependencies(
        cls,
        values: list[PythonDependency],
    ) -> list[PythonDependency]:
        seen: set[str] = set()
        for dependency in values:
            if dependency.module in seen:
                raise ValueError(
                    f"duplicate python dependency '{dependency.module}'"
                )
            seen.add(dependency.module)
        return values

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

    @field_validator("vlo")
    @classmethod
    def validate_vlo(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("extension VLO range cannot be blank")
        _parse_stable_semver_range(normalized)
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
    def reject_self_dependency(self) -> "ExtensionManifest":
        if self.id in self.dependencies:
            raise ValueError("an extension cannot depend on itself")
        if f"{_EXTENSION_EVENT_PREFIX}{self.id}" in self.activation_events:
            raise ValueError("an extension cannot activate on its own activation")
        return self

    @model_validator(mode="after")
    def require_entry_point(self) -> "ExtensionManifest":
        has_declarative_contribution = (
            self.contributions is not None and self.contributions.luts is not None
        )
        if (
            self.frontend is None
            and self.backend is None
            and not has_declarative_contribution
        ):
            raise ValueError(
                "manifest must declare a frontend, backend, or declarative contribution"
            )
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


def load_extension_lut_catalog(
    package_dir: Path,
    manifest: ExtensionManifest,
) -> tuple[ExtensionLutContribution, ...]:
    """Validate a declarative LUT catalogue and its inert package resources."""

    catalog_path_value = (
        manifest.contributions.luts
        if manifest.contributions is not None
        else None
    )
    if catalog_path_value is None:
        return ()

    catalog_path = package_dir.joinpath(*PurePosixPath(catalog_path_value).parts)
    try:
        catalog_stat = catalog_path.stat(follow_symlinks=False)
    except OSError as exc:
        raise ExtensionManifestError(f"cannot read LUT catalogue: {exc}") from exc
    if catalog_path.is_symlink() or not catalog_path.is_file():
        raise ExtensionManifestError("LUT catalogue must be a regular file")
    if catalog_stat.st_size > _MAX_LUT_CATALOG_BYTES:
        raise ExtensionManifestError("LUT catalogue exceeds the 1 MiB size limit")

    try:
        raw = json.loads(
            catalog_path.read_text(encoding="utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ExtensionManifestError(
            f"LUT catalogue is not valid UTF-8 JSON: {exc}"
        ) from exc

    try:
        catalog = ExtensionLutCatalog.model_validate(raw)
    except ValidationError as exc:
        raise ExtensionManifestError(
            f"LUT catalogue validation failed: {exc}"
        ) from exc

    for contribution in catalog.luts:
        resource_path = package_dir.joinpath(*PurePosixPath(contribution.path).parts)
        try:
            resource_stat = resource_path.stat(follow_symlinks=False)
        except OSError as exc:
            raise ExtensionManifestError(
                f"cannot read LUT resource '{contribution.path}': {exc}"
            ) from exc
        if resource_path.is_symlink() or not resource_path.is_file():
            raise ExtensionManifestError(
                f"LUT resource must be a regular file: {contribution.path}"
            )
        if resource_stat.st_size > MAX_EXTENSION_LUT_BYTES:
            raise ExtensionManifestError(
                f"LUT resource exceeds the 16 MiB size limit: {contribution.path}"
            )

    return tuple(catalog.luts)


def backend_entry_candidates(package_dir: Path, entry: str) -> tuple[Path, Path]:
    """Return the module-file and package-init candidates for a backend entry."""

    module_name, _factory_name = entry.split(":", 1)
    module_path = package_dir.joinpath(*module_name.split("."))
    return module_path.with_suffix(".py"), module_path / "__init__.py"
