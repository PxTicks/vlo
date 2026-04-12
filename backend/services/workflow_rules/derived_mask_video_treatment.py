from __future__ import annotations

from typing import Any


DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM = (
    "derived_mask_source_video_treatment"
)
LEGACY_DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM = (
    "__derived_mask_video_treatment"
)
DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_LABEL = "Transparency handling"
DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT = "preserve_transparency"
DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OPTIONS = {
    "preserve_transparency": "Keep transparency",
    "fill_transparent_with_neutral_gray": "Fill transparent with neutral gray",
    "remove_transparency": "Remove transparency",
}
VISUAL_DERIVED_MASK_RULE_KEYS = (
    "binary_derived_mask_of",
    "soft_derived_mask_of",
)


def normalize_derived_mask_source_video_treatment_widget_param(
    param_name: str,
) -> tuple[str, bool]:
    normalized = param_name.strip()
    if normalized == LEGACY_DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM:
        return DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM, True
    return normalized, False


def normalize_derived_mask_source_video_treatment(value: Any) -> str:
    if not isinstance(value, str):
        return DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT

    normalized = value.strip().lower()
    if normalized in DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OPTIONS:
        return normalized
    if normalized in {"keep transparency", "preserve transparency"}:
        return "preserve_transparency"
    if normalized in {
        "fill transparent with neutral gray",
        "fill transparent with neutral grey",
    }:
        return "fill_transparent_with_neutral_gray"
    if normalized == "remove transparency":
        return "remove_transparency"
    return DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT


def to_derived_mask_source_video_treatment_widget_value(value: Any) -> str:
    normalized = normalize_derived_mask_source_video_treatment(value)
    return DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OPTIONS[normalized]


def create_derived_mask_source_video_treatment_widget_rule(
    *,
    default: Any = DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT,
    label: str = DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_LABEL,
) -> dict[str, Any]:
    return {
        "label": label,
        "value_type": "enum",
        "options": list(DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OPTIONS.values()),
        "default": to_derived_mask_source_video_treatment_widget_value(default),
        "frontend_only": True,
    }


__all__ = [
    "create_derived_mask_source_video_treatment_widget_rule",
    "DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT",
    "DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OPTIONS",
    "DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_LABEL",
    "DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM",
    "LEGACY_DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM",
    "VISUAL_DERIVED_MASK_RULE_KEYS",
    "normalize_derived_mask_source_video_treatment",
    "normalize_derived_mask_source_video_treatment_widget_param",
    "to_derived_mask_source_video_treatment_widget_value",
]
