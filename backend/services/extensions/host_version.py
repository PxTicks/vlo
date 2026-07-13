"""VLO application build version used only for extension compatibility."""

from __future__ import annotations

import json
from pathlib import Path

from services.extensions.manifest import _parse_stable_semver


def _load_vlo_application_version() -> str | None:
    package_path = Path(__file__).resolve().parents[3] / "package.json"
    try:
        package = json.loads(package_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(package, dict):
        return None
    value = package.get("version")
    if not isinstance(value, str) or value == "0.0.0":
        return None
    return value if _parse_stable_semver(value) is not None else None


VLO_APPLICATION_VERSION = _load_vlo_application_version()
