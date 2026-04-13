from __future__ import annotations

import math
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
DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OVERRIDE_OPERATORS = frozenset(
    {"eq", "neq", "lt", "lte", "gt", "gte"}
)
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


def parse_derived_mask_source_video_treatment(value: Any) -> str | None:
    if not isinstance(value, str):
        return None

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
    return None


def normalize_derived_mask_source_video_treatment(value: Any) -> str:
    parsed = parse_derived_mask_source_video_treatment(value)
    if parsed is not None:
        return parsed
    return DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT


def normalize_derived_mask_source_video_treatment_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []

    normalized: list[str] = []
    for item in value:
        parsed = parse_derived_mask_source_video_treatment(item)
        if parsed is None or parsed in normalized:
            continue
        normalized.append(parsed)
    return normalized


def resolve_derived_mask_source_video_treatment_widget_options(
    *,
    include_options: list[str] | None = None,
    exclude_options: list[str] | None = None,
) -> list[str]:
    if include_options:
        option_values = [
            option
            for option in include_options
            if option in DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OPTIONS
        ]
    else:
        option_values = list(DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OPTIONS.keys())

    if exclude_options:
        excluded = set(exclude_options)
        option_values = [
            option for option in option_values if option not in excluded
        ]

    return option_values


def _coerce_numeric_condition_value(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if math.isfinite(number):
            return number
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            number = float(stripped)
        except ValueError:
            return None
        if math.isfinite(number):
            return number
    return None


def _compare_condition_value(
    current: Any,
    operator: str,
    expected: Any,
) -> bool:
    if operator in {"lt", "lte", "gt", "gte"}:
        current_number = _coerce_numeric_condition_value(current)
        expected_number = _coerce_numeric_condition_value(expected)
        if current_number is None or expected_number is None:
            return False
        if operator == "lt":
            return current_number < expected_number
        if operator == "lte":
            return current_number <= expected_number
        if operator == "gt":
            return current_number > expected_number
        return current_number >= expected_number

    current_number = _coerce_numeric_condition_value(current)
    expected_number = _coerce_numeric_condition_value(expected)
    if current_number is not None and expected_number is not None:
        matches = math.isclose(current_number, expected_number, rel_tol=0.0, abs_tol=1e-9)
    elif isinstance(current, bool) or isinstance(expected, bool):
        matches = (
            isinstance(current, bool)
            and isinstance(expected, bool)
            and current is expected
        )
    elif isinstance(current, str) and isinstance(expected, str):
        matches = current.strip().lower() == expected.strip().lower()
    else:
        matches = current == expected

    if operator == "neq":
        return not matches
    return matches


def resolve_derived_mask_source_video_treatment_default(
    *,
    default: Any = DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT,
    default_overrides: Any = None,
    get_param_value: Any = None,
) -> str:
    normalized_default = normalize_derived_mask_source_video_treatment(default)
    if not isinstance(default_overrides, list) or not callable(get_param_value):
        return normalized_default

    for override in default_overrides:
        if not isinstance(override, dict):
            continue
        when = override.get("when")
        if not isinstance(when, dict):
            continue
        node_id = when.get("node_id")
        param = when.get("param")
        operator = when.get("operator")
        if not isinstance(node_id, str) or not node_id.strip():
            continue
        if not isinstance(param, str) or not param.strip():
            continue
        if operator not in DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OVERRIDE_OPERATORS:
            continue
        if not _compare_condition_value(
            get_param_value(node_id.strip(), param.strip()),
            operator,
            when.get("value"),
        ):
            continue
        parsed_value = parse_derived_mask_source_video_treatment(override.get("value"))
        if parsed_value is not None:
            return parsed_value

    return normalized_default


def _normalize_widget_default_for_options(
    value: Any,
    option_values: list[str],
) -> str:
    normalized = normalize_derived_mask_source_video_treatment(value)
    if option_values and normalized not in option_values:
        normalized = option_values[0]
    return normalized


def to_derived_mask_source_video_treatment_widget_value(value: Any) -> str:
    normalized = normalize_derived_mask_source_video_treatment(value)
    return DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OPTIONS[normalized]


def create_derived_mask_source_video_treatment_widget_rule(
    *,
    default: Any = DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT,
    label: str = DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_LABEL,
    option_values: list[str] | None = None,
) -> dict[str, Any]:
    normalized_option_values = (
        [option for option in option_values if option in DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OPTIONS]
        if isinstance(option_values, list)
        else list(DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OPTIONS.keys())
    )
    normalized_default = _normalize_widget_default_for_options(
        default,
        normalized_option_values,
    )
    return {
        "label": label,
        "value_type": "enum",
        "options": [
            DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OPTIONS[option]
            for option in normalized_option_values
        ],
        "default": to_derived_mask_source_video_treatment_widget_value(
            normalized_default
        ),
        "frontend_only": True,
    }


__all__ = [
    "create_derived_mask_source_video_treatment_widget_rule",
    "DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT",
    "DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OPTIONS",
    "DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OVERRIDE_OPERATORS",
    "DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_LABEL",
    "DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM",
    "LEGACY_DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM",
    "VISUAL_DERIVED_MASK_RULE_KEYS",
    "normalize_derived_mask_source_video_treatment",
    "normalize_derived_mask_source_video_treatment_list",
    "normalize_derived_mask_source_video_treatment_widget_param",
    "parse_derived_mask_source_video_treatment",
    "resolve_derived_mask_source_video_treatment_default",
    "resolve_derived_mask_source_video_treatment_widget_options",
    "to_derived_mask_source_video_treatment_widget_value",
]
