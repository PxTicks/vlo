from __future__ import annotations

from typing import Any


def coerce_int(value: Any) -> int | None:
    """Coerce a value to int, or return None if not coercible.

    Rejects bools.  Accepts int directly; float only if .is_integer();
    string only if it represents an integer (optional leading minus).
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("-"):
            digits = stripped[1:]
            if digits.isdigit():
                return int(stripped)
        elif stripped.isdigit():
            return int(stripped)
    return None


def coerce_float(value: Any) -> float | None:
    """Coerce a value to float, or return None if not coercible.

    Rejects bools.  Accepts int/float (converts to float).
    Accepts non-empty stripped strings via ``float()``.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return float(stripped)
        except ValueError:
            return None
    return None


def coerce_number(value: Any) -> int | float | None:
    """Coerce a value to int or float, preserving the type distinction.

    Rejects bools.  Accepts int/float as-is.
    For strings: int-like strings (no '.' or 'e') return int,
    otherwise returns float.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            if "." in stripped or "e" in stripped.lower():
                return float(stripped)
            return int(stripped)
        except ValueError:
            return None
    return None


def coerce_bool(value: Any) -> bool | None:
    """Coerce a value to bool, or return None if not coercible.

    Accepts bool directly; accepts string 'true'/'false'
    (case-insensitive, stripped).
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized == "true":
            return True
        if normalized == "false":
            return False
    return None


def match_enum_value(value: Any, options: list[Any] | None) -> Any | None:
    """Match a value against a list of options.

    Checks exact equality first, then falls back to ``str()``
    coercion comparison.  Returns None if *options* is empty/None
    or no match is found.
    """
    if not isinstance(options, list) or not options:
        return None
    for option in options:
        if option == value:
            return option
    for option in options:
        if str(option) == str(value):
            return option
    return None
