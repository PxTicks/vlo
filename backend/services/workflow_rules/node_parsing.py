"""Param-level interpretation for ComfyUI node classes.

Provides two parallel parsing subsystems that operate on already-discovered
nodes:

- **Input parsing**: detects image/video/text input parameters and builds
  structured input maps with labels.
- **Widget parsing**: extracts editable widget entries for display, including
  enum options, numeric bounds, and control-after-generate metadata.

Both share ``iter_all_params`` from ``node_introspection`` and follow the
same iteration pattern over a node's ``input`` spec.
"""

from typing import Any

from services.workflow_rules.node_introspection import iter_all_params


# ===========================================================================
# Input parsing
# ===========================================================================


_INPUT_NODE_FALLBACKS: dict[str, list[dict[str, Any]]] = {
    "VHS_LoadVideo": [
        {
            "input_type": "video",
            "param": "video",
            "label": "Video",
            "description": None,
        }
    ],
}

_TEXT_PARAM_LABELS = {
    "text": "Prompt",
    "text_g": "Global Prompt",
    "text_l": "Local Prompt",
    "clip_l": "CLIP L Prompt",
    "clip_g": "CLIP G Prompt",
    "t5xxl": "T5XXL Prompt",
    "llama": "LLaMA Prompt",
}
_MEDIA_PARAM_LABELS = {
    "image": "Image",
    "file": "Video",
    "video": "Video",
}
_TOKEN_LABELS = {
    "g": "Global",
    "l": "Local",
    "clip": "CLIP",
    "t5xxl": "T5XXL",
    "llama": "LLaMA",
    "image": "Image",
    "video": "Video",
    "mask": "Mask",
    "reference": "Reference",
}


def _humanize_param_token(token: str) -> str:
    token = token.strip()
    if not token:
        return ""
    alias = _TOKEN_LABELS.get(token.lower())
    if alias:
        return alias
    return token.replace("-", " ").replace("_", " ").title()


def _build_input_label(input_type: str, param_name: str) -> str:
    lowered_param = param_name.strip().lower()
    if input_type == "text":
        alias = _TEXT_PARAM_LABELS.get(lowered_param)
        if alias:
            return alias
        tokens = [token for token in lowered_param.replace("-", "_").split("_") if token]
        if tokens:
            humanized = " ".join(_humanize_param_token(token) for token in tokens)
            if humanized.lower().endswith("prompt"):
                return humanized
            return f"{humanized} Prompt"
        return "Prompt"

    alias = _MEDIA_PARAM_LABELS.get(lowered_param)
    if alias:
        return alias if input_type == "video" else "Image"

    tokens = [token for token in lowered_param.replace("-", "_").split("_") if token]
    if tokens:
        return " ".join(_humanize_param_token(token) for token in tokens)
    return "Video" if input_type == "video" else "Image"


def _detect_input_param(
    param_name: str,
    type_spec: Any,
    opts: dict[str, Any],
) -> dict[str, Any] | None:
    """Detect whether a single param is an image/video/text input."""
    tooltip = opts.get("tooltip") if isinstance(opts.get("tooltip"), str) else None

    # image_upload: true on a file-list or COMBO input (not STRING — excludes Painter)
    if opts.get("image_upload") is True:
        if isinstance(type_spec, list) or (isinstance(type_spec, str) and type_spec.upper() == "COMBO"):
            return {
                "input_type": "image",
                "param": param_name,
                "label": _build_input_label("image", param_name),
                "description": tooltip,
            }

    # video_upload: true
    if opts.get("video_upload") is True:
        return {
            "input_type": "video",
            "param": param_name,
            "label": _build_input_label("video", param_name),
            "description": tooltip,
        }

    # dynamicPrompts: true on a STRING input → text prompt
    if (
        opts.get("dynamicPrompts") is True
        and isinstance(type_spec, str)
        and type_spec.upper() == "STRING"
    ):
        return {
            "input_type": "text",
            "param": param_name,
            "label": _build_input_label("text", param_name),
            "description": tooltip,
        }

    return None


def parse_node_inputs(
    class_info: dict[str, Any],
) -> list[dict[str, Any]]:
    """Detect image/video/text inputs for a node class from object_info."""
    detected: list[dict[str, Any]] = []
    seen_params: set[str] = set()
    for param_name, type_spec, opts in iter_all_params(class_info):
        if param_name in seen_params:
            continue
        detected_entry = _detect_input_param(param_name, type_spec, opts)
        if detected_entry is None:
            continue
        detected.append(detected_entry)
        seen_params.add(param_name)
    return detected


def build_input_node_map(
    object_info: dict[str, Any],
) -> dict[str, list[dict[str, Any]]]:
    """Build a complete input node map from object_info + static fallbacks.

    Returns a dict of ``class_type -> [{input_type, param, label, description}, ...]``.
    """
    result: dict[str, list[dict[str, Any]]] = {
        class_type: [dict(entry) for entry in entries]
        for class_type, entries in _INPUT_NODE_FALLBACKS.items()
    }

    for class_type, class_info in object_info.items():
        if not isinstance(class_info, dict):
            continue
        detected = parse_node_inputs(class_info)
        if not detected:
            continue

        by_param = {
            entry["param"]: dict(entry)
            for entry in result.get(class_type, [])
        }
        for entry in detected:
            by_param.setdefault(entry["param"], entry)
        result[class_type] = list(by_param.values())

    return result


# ===========================================================================
# Widget parsing
# ===========================================================================


def _coerce_widget_options(type_spec: Any) -> list[str | int | float | bool] | None:
    if not isinstance(type_spec, (list, tuple)):
        return None
    options: list[str | int | float | bool] = []
    for option in type_spec:
        if isinstance(option, (str, int, float, bool)):
            options.append(option)
    return options if options else None


def _widget_value_type_from_type_spec(type_spec: Any) -> str | None:
    if isinstance(type_spec, str):
        normalized = type_spec.strip().upper()
        if normalized == "INT":
            return "int"
        if normalized == "FLOAT":
            return "float"
        if normalized == "STRING":
            return "string"
        if normalized == "BOOLEAN":
            return "boolean"
        # Comfy uppercase non-primitives (for example IMAGE, LATENT, MODEL)
        # represent links, not editable widgets.
        if normalized == type_spec and normalized:
            return None
        return "unknown"

    if isinstance(type_spec, (list, tuple)):
        options = _coerce_widget_options(type_spec)
        if options:
            return "enum"
        return "unknown"

    return "unknown"


def get_widget_value_index_map(
    class_type: str,
    object_info: dict[str, Any],
) -> dict[str, int]:
    """Return the widget_values slot for each editable widget on a node class."""
    if not isinstance(object_info, dict):
        return {}

    class_info = object_info.get(class_type)
    if not isinstance(class_info, dict):
        return {}

    input_spec = class_info.get("input")
    if not isinstance(input_spec, dict):
        return {}

    input_order: list[str] = []
    raw_order = class_info.get("input_order")
    if isinstance(raw_order, dict):
        for section_key in ("required", "optional"):
            section_order = raw_order.get(section_key)
            if isinstance(section_order, list):
                input_order.extend(str(param) for param in section_order)

    widget_value_index: dict[str, int] = {}
    index = 0
    for param_name in input_order:
        param_def = None
        for section_key in ("required", "optional"):
            section = input_spec.get(section_key)
            if isinstance(section, dict) and param_name in section:
                param_def = section[param_name]
                break
        if param_def is None:
            continue

        if isinstance(param_def, (list, tuple)) and len(param_def) >= 1:
            type_spec = param_def[0]
            if _widget_value_type_from_type_spec(type_spec) is None:
                continue

        widget_value_index[param_name] = index
        opts = (
            param_def[1]
            if isinstance(param_def, (list, tuple)) and len(param_def) >= 2
            else {}
        )
        if isinstance(opts, dict) and opts.get("control_after_generate"):
            index += 2
        else:
            index += 1

    return widget_value_index


def build_widget_entries_for_class(
    class_type: str,
    object_info: dict[str, Any],
    *,
    node_title: str | None = None,
    widgets_values: list[Any] | None = None,
    widget_groups: dict[str, dict[str, Any]] | None = None,
    include_all_widgets: bool = False,
) -> dict[str, dict[str, Any]] | None:
    """Build widget entries for a class using object_info as the source of truth.

    By default, only ``control_after_generate`` widgets are included.
    If ``include_all_widgets=True``, every editable widget input is included.
    """
    class_info = object_info.get(class_type)
    if not isinstance(class_info, dict):
        return None

    input_spec = class_info.get("input")
    if not isinstance(input_spec, dict):
        return None

    widget_value_index = get_widget_value_index_map(
        class_type,
        object_info,
    )

    discovered: dict[str, dict[str, Any]] = {}
    for section_key in ("required", "optional"):
        section = input_spec.get(section_key)
        if not isinstance(section, dict):
            continue
        for param_name, param_def in section.items():
            if not isinstance(param_def, (list, tuple)) or len(param_def) < 1:
                continue
            type_spec = param_def[0]
            value_type = _widget_value_type_from_type_spec(type_spec)
            if value_type is None:
                continue
            opts = param_def[1] if len(param_def) >= 2 else {}
            if not isinstance(opts, dict):
                opts = {}
            control_after_generate = bool(opts.get("control_after_generate"))
            if not include_all_widgets and not control_after_generate:
                continue

            label = param_name
            if (
                param_name == "value"
                and node_title
                and isinstance(node_title, str)
                and node_title.strip()
                and isinstance(widget_groups, dict)
                and param_name in widget_groups
            ):
                label = node_title

            widget_entry: dict[str, Any] = {
                "label": label,
                "control_after_generate": control_after_generate,
                "value_type": value_type,
            }
            enum_options = _coerce_widget_options(type_spec)
            if enum_options:
                widget_entry["options"] = enum_options
            for num_key in ("min", "max"):
                val = opts.get(num_key)
                if isinstance(val, (int, float)) and not isinstance(val, bool):
                    widget_entry[num_key] = val
            if "default" in opts:
                widget_entry["default"] = opts["default"]

            if widgets_values:
                widget_index = widget_value_index.get(param_name)
                if widget_index is not None and widget_index + 1 < len(widgets_values):
                    mode = widgets_values[widget_index + 1]
                    if isinstance(mode, str) and mode in (
                        "fixed",
                        "randomize",
                        "increment",
                        "decrement",
                    ):
                        widget_entry["default_randomize"] = mode == "randomize"

            if isinstance(widget_groups, dict):
                proxy_group = widget_groups.get(param_name)
                if isinstance(proxy_group, dict):
                    group_id = proxy_group.get("group_id")
                    group_title = proxy_group.get("group_title")
                    group_order = proxy_group.get("group_order")
                    if isinstance(group_id, str) and group_id.strip():
                        widget_entry["group_id"] = group_id
                    if isinstance(group_title, str) and group_title.strip():
                        widget_entry["group_title"] = group_title
                    if isinstance(group_order, int) and group_order >= 0:
                        widget_entry["group_order"] = group_order

            discovered[param_name] = widget_entry

    return discovered if discovered else None


def resolve_widget_param_metadata(
    class_type: str,
    object_info: dict[str, Any],
    param_names: set[str],
) -> dict[str, dict[str, Any]]:
    """Resolve widget metadata for specific param names from raw object_info.

    Looks up each requested param directly in the class spec, bypassing
    discovery policy.  Returns entries keyed by param name with value_type,
    min, max, default, and options where applicable.
    """
    class_info = object_info.get(class_type)
    if not isinstance(class_info, dict):
        return {}

    result: dict[str, dict[str, Any]] = {}
    for param_name, type_spec, opts in iter_all_params(class_info):
        if param_name not in param_names:
            continue
        value_type = _widget_value_type_from_type_spec(type_spec)
        if value_type is None:
            continue
        entry: dict[str, Any] = {"value_type": value_type}
        enum_options = _coerce_widget_options(type_spec)
        if enum_options:
            entry["options"] = enum_options
        for num_key in ("min", "max"):
            val = opts.get(num_key)
            if isinstance(val, (int, float)) and not isinstance(val, bool):
                entry[num_key] = val
        if "default" in opts:
            entry["default"] = opts["default"]
        result[param_name] = entry
    return result


def merge_widget_entries_with_object_info(
    existing_widgets: dict[str, Any],
    object_info_widgets: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Merge sidecar widget overrides with object_info-discovered widgets."""
    merged: dict[str, dict[str, Any]] = {}
    for param_name, raw_entry in existing_widgets.items():
        if not isinstance(raw_entry, dict):
            continue
        entry = dict(raw_entry)
        enriched = object_info_widgets.get(param_name)
        if isinstance(enriched, dict):
            for key in ("value_type", "options"):
                if key in enriched:
                    entry[key] = enriched[key]
            for key in ("min", "max", "default", "group_id", "group_title", "group_order"):
                if key in enriched and key not in entry:
                    entry[key] = enriched[key]
        merged[param_name] = entry
    return merged


__all__ = [
    "build_input_node_map",
    "build_widget_entries_for_class",
    "get_widget_value_index_map",
    "merge_widget_entries_with_object_info",
    "parse_node_inputs",
    "resolve_widget_param_metadata",
]
