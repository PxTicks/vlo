"""ComfyUI frontend defaults vlo seeds into the installs it manages."""

from __future__ import annotations

import json
import logging
import os
from contextlib import suppress
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ComfyUI's frontend keeps per-user settings here and the server only reads the
# file when the browser asks for them, so a seeded value has to land before the
# launch it should apply to.
SETTINGS_RELATIVE_PATH = Path("user") / "default" / "comfy.settings.json"
# VideoHelperSuite ships its animated sampling preview off, but vlo always
# launches ComfyUI with `--preview-method taesd`, so on a managed install that
# frontend toggle is the only thing between sampling and useful video previews.
# These are defaults, not policy: a key already present is the user's own
# choice — including an explicit `false` — and is never rewritten.
MANAGED_FRONTEND_SETTING_DEFAULTS: dict[str, Any] = {
    "VHS.LatentPreview": True,
}
_VIDEO_HELPER_SUITE_MARKER = "videohelpersuite"


def _has_video_helper_suite(install_path: Path) -> bool:
    """Report whether this checkout actually has VideoHelperSuite installed.

    Folder names vary by installer — a plain clone keeps the repository's
    casing while ComfyUI-Manager lowercases it — so the name is matched loosely
    rather than against one spelling.
    """

    try:
        return any(
            _VIDEO_HELPER_SUITE_MARKER in entry.name.casefold()
            for entry in (install_path / "custom_nodes").iterdir()
            if entry.is_dir()
        )
    except OSError:
        return False


def seed_managed_frontend_settings(install_path: str | Path) -> list[str]:
    """Fill in vlo's frontend defaults, returning the setting ids it wrote.

    Best effort throughout: an unreadable or malformed settings file is left
    exactly as it is, because nothing here is worth failing an install or a
    launch over.
    """

    resolved = Path(install_path).expanduser()
    if not _has_video_helper_suite(resolved):
        return []

    settings_path = resolved / SETTINGS_RELATIVE_PATH
    settings: dict[str, Any] = {}
    try:
        raw = settings_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        pass
    except (OSError, UnicodeDecodeError) as exc:
        logger.warning("ComfyUI frontend settings could not be read: %s", exc)
        return []
    else:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            logger.warning("ComfyUI frontend settings are not valid JSON: %s", exc)
            return []
        if not isinstance(parsed, dict):
            logger.warning("ComfyUI frontend settings are not a JSON object")
            return []
        settings = parsed

    seeded = [key for key in MANAGED_FRONTEND_SETTING_DEFAULTS if key not in settings]
    if not seeded:
        return []
    for key in seeded:
        settings[key] = MANAGED_FRONTEND_SETTING_DEFAULTS[key]

    # Replace the file atomically: a half-written settings file would cost the
    # user every preference they have set.
    temporary_path = settings_path.with_suffix(".json.tmp")
    try:
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path.write_text(json.dumps(settings, indent=4), encoding="utf-8")
        os.replace(temporary_path, settings_path)
    except OSError as exc:
        logger.warning("ComfyUI frontend settings could not be written: %s", exc)
        with suppress(OSError):
            temporary_path.unlink(missing_ok=True)
        return []

    logger.info("Seeded ComfyUI frontend defaults: %s", ", ".join(seeded))
    return seeded
