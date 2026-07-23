from __future__ import annotations

import json
import re
from pathlib import Path

from services.extensions import (
    EXTENSION_SDK_VERSION,
    is_extension_sdk_compatible,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
STABLE_SEMVER_PATTERN = re.compile(
    r"^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$"
)
FRONTEND_VERSION_PATTERN = re.compile(
    r'VLO_EXTENSION_SDK_VERSION\s*=\s*"(?P<version>[^"]+)"'
)


def _read_json(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def test_extension_sdk_release_versions_are_consistent():
    sdk_package = _read_json(
        REPOSITORY_ROOT / "packages" / "extension-sdk" / "package.json"
    )
    package_version = sdk_package.get("version")
    assert isinstance(package_version, str)
    assert STABLE_SEMVER_PATTERN.fullmatch(package_version)

    frontend_constants = (
        REPOSITORY_ROOT
        / "frontend"
        / "src"
        / "features"
        / "extensions"
        / "constants.ts"
    ).read_text(encoding="utf-8")
    frontend_match = FRONTEND_VERSION_PATTERN.search(frontend_constants)
    assert frontend_match is not None, "frontend SDK version constant is missing"

    assert EXTENSION_SDK_VERSION == package_version
    assert frontend_match.group("version") == package_version

    template_manifest = _read_json(
        REPOSITORY_ROOT / "extension-template" / "manifest.json"
    )
    template_sdk_range = template_manifest.get("sdk")
    assert isinstance(template_sdk_range, str)
    assert is_extension_sdk_compatible(
        template_sdk_range,
        sdk_version=package_version,
    )
