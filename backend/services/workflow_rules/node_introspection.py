"""Low-level param introspection for ComfyUI node classes.

Shared by both the discovery and parsing layers.
"""

from collections.abc import Iterator
from typing import Any


def iter_all_params(
    class_info: dict[str, Any],
) -> Iterator[tuple[str, Any, dict[str, Any]]]:
    """Yield ``(param_name, type_spec, opts)`` for every input param."""
    input_spec = class_info.get("input")
    if not isinstance(input_spec, dict):
        return
    for section_key in ("required", "optional"):
        section = input_spec.get(section_key)
        if not isinstance(section, dict):
            continue
        for param_name, param_def in section.items():
            if not isinstance(param_def, (list, tuple)) or len(param_def) < 1:
                continue
            type_spec = param_def[0]
            opts = param_def[1] if len(param_def) >= 2 and isinstance(param_def[1], dict) else {}
            yield param_name, type_spec, opts


__all__ = [
    "iter_all_params",
]
