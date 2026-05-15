from __future__ import annotations

from typing import Any


_LEGACY_TO_CANONICAL_CLASS_TYPES = {
    "VLOMemoryLoadAudio": "vloMemoryLoadAudio",
    "VLOMemoryLoadImage": "vloMemoryLoadImage",
    "VLOMemoryLoadVideo": "vloMemoryLoadVideo",
}
_CANONICAL_CLASS_TYPE_ALIASES = {
    "vloMemoryLoadAudio": ("vloMemoryLoadAudio", "VLOMemoryLoadAudio"),
    "vloMemoryLoadImage": ("vloMemoryLoadImage", "VLOMemoryLoadImage"),
    "vloMemoryLoadVideo": ("vloMemoryLoadVideo", "VLOMemoryLoadVideo"),
}


def canonicalize_class_type(class_type: str | None) -> str | None:
    if not isinstance(class_type, str):
        return None

    trimmed = class_type.strip()
    if not trimmed:
        return None

    return _LEGACY_TO_CANONICAL_CLASS_TYPES.get(trimmed, trimmed)


def get_class_type_aliases(class_type: str | None) -> tuple[str, ...]:
    if not isinstance(class_type, str):
        return ()

    trimmed = class_type.strip()
    if not trimmed:
        return ()

    canonical = canonicalize_class_type(trimmed)
    if not canonical:
        return ()

    aliases = _CANONICAL_CLASS_TYPE_ALIASES.get(canonical, (canonical,))
    ordered: list[str] = []
    for value in (trimmed, *aliases):
        if value not in ordered:
            ordered.append(value)
    return tuple(ordered)


def resolve_class_info(
    object_info: dict[str, Any],
    class_type: str | None,
) -> dict[str, Any] | None:
    for alias in get_class_type_aliases(class_type):
        class_info = object_info.get(alias)
        if isinstance(class_info, dict):
            return class_info
    return None
