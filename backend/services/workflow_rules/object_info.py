import json
import logging
from pathlib import Path
from typing import Any

from services.workflow_rules.normalize import WorkflowRules


log = logging.getLogger(__name__)

OBJECT_INFO_PATH = (
    Path(__file__).parent.parent.parent / "assets" / ".config" / "object_info.json"
)

_object_info_cache: dict[str, Any] | None = None
WIDGETS_MODE_ALL = "all"
WIDGETS_MODE_CONTROL_AFTER_GENERATE = "control_after_generate"
DEFAULT_ALL_WIDGET_NODE_CLASSES = frozenset({"KSampler", "KSamplerAdvanced"})


def set_object_info_cache(object_info: dict[str, Any] | None) -> None:
    global _object_info_cache
    _object_info_cache = object_info


def _load_object_info() -> dict[str, Any]:
    global _object_info_cache
    if _object_info_cache is not None:
        return _object_info_cache
    try:
        raw = json.loads(OBJECT_INFO_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            _object_info_cache = raw
            log.info("Loaded object_info (%d node classes)", len(raw))
            return raw
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("Failed to load object_info from %s: %s", OBJECT_INFO_PATH, exc)
    _object_info_cache = {}
    return _object_info_cache


class _NodeInfo:
    __slots__ = ("class_type", "title", "widgets_values", "widget_groups")

    def __init__(
        self,
        class_type: str,
        title: str,
        widgets_values: list[Any] | None,
        widget_groups: dict[str, dict[str, Any]] | None = None,
    ):
        self.class_type = class_type
        self.title = title
        self.widgets_values = widgets_values
        self.widget_groups = widget_groups


def _extract_proxy_widget_groups(
    graph_node: dict[str, Any],
    group_id: str,
    group_title: str,
) -> dict[str, dict[str, dict[str, Any]]]:
    properties = graph_node.get("properties")
    if not isinstance(properties, dict):
        return {}

    proxy_widgets = properties.get("proxyWidgets")
    if not isinstance(proxy_widgets, list):
        return {}

    grouped: dict[str, dict[str, dict[str, Any]]] = {}
    for order, proxy_entry in enumerate(proxy_widgets):
        if not isinstance(proxy_entry, (list, tuple)) or len(proxy_entry) < 2:
            continue

        target_node_id = str(proxy_entry[0]).strip()
        target_param = proxy_entry[1]
        if not target_node_id or not isinstance(target_param, str):
            continue

        target_param_name = target_param.strip()
        if not target_param_name:
            continue

        grouped.setdefault(target_node_id, {})[target_param_name] = {
            "group_id": group_id,
            "group_title": group_title,
            "group_order": order,
        }

    return grouped


def _extract_node_info(workflow_data: dict[str, Any]) -> dict[str, _NodeInfo]:
    """Extract a node_id -> _NodeInfo mapping from a workflow file.

    Supports both formats:
    - API format: flat dict keyed by node ID with ``class_type``
    - Graph format: ``nodes`` array with ``id``/``type``, plus subgraphs
      in ``definitions.subgraphs[].nodes``
    """
    result: dict[str, _NodeInfo] = {}

    if all(
        isinstance(v, dict) and "class_type" in v
        for v in workflow_data.values()
        if isinstance(v, dict)
    ):
        for node_id, node_data in workflow_data.items():
            if isinstance(node_data, dict):
                class_type = node_data.get("class_type")
                if isinstance(class_type, str):
                    meta = node_data.get("_meta", {})
                    title = (
                        meta.get("title", class_type)
                        if isinstance(meta, dict)
                        else class_type
                    )
                    result[str(node_id)] = _NodeInfo(class_type, title, None)
        if result:
            return result

    def _collect_from_node_list(
        nodes: Any,
        prefix: str = "",
        widget_groups_by_node: dict[str, dict[str, dict[str, Any]]] | None = None,
    ) -> None:
        if not isinstance(nodes, list):
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            node_id = node.get("id")
            node_type = node.get("type")
            if node_id is not None and isinstance(node_type, str):
                key = f"{prefix}{node_id}" if prefix else str(node_id)
                title = node.get("title") or node_type
                widgets_values = node.get("widgets_values")
                widget_groups = None
                if widget_groups_by_node is not None:
                    widget_groups = widget_groups_by_node.get(str(node_id))
                result[key] = _NodeInfo(
                    node_type,
                    title,
                    widgets_values if isinstance(widgets_values, list) else None,
                    widget_groups=widget_groups,
                )

    _collect_from_node_list(workflow_data.get("nodes"))

    defs = workflow_data.get("definitions")
    if isinstance(defs, dict):
        subgraphs = defs.get("subgraphs")
        if isinstance(subgraphs, list):
            sg_by_id: dict[str, dict[str, Any]] = {}
            for sg in subgraphs:
                if isinstance(sg, dict) and isinstance(sg.get("id"), str):
                    sg_by_id[sg["id"]] = sg

            top_nodes = workflow_data.get("nodes")
            if isinstance(top_nodes, list):
                for node in top_nodes:
                    if not isinstance(node, dict):
                        continue
                    node_type = node.get("type")
                    parent_id = node.get("id")
                    if (
                        isinstance(node_type, str)
                        and node_type in sg_by_id
                        and parent_id is not None
                    ):
                        sg_def = sg_by_id[node_type]
                        group_title_raw = node.get("title") or sg_def.get("name") or node_type
                        group_title = (
                            group_title_raw
                            if isinstance(group_title_raw, str) and group_title_raw.strip()
                            else node_type
                        )
                        proxy_widget_groups = _extract_proxy_widget_groups(
                            node,
                            group_id=str(parent_id),
                            group_title=group_title,
                        )
                        _collect_from_node_list(
                            sg_def.get("nodes"),
                            prefix=f"{parent_id}:",
                            widget_groups_by_node=proxy_widget_groups,
                        )

    return result


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
    object_info: dict[str, Any] | None = None,
) -> dict[str, int]:
    """Return the widget_values slot for each editable widget on a node class."""
    if object_info is None:
        object_info = _load_object_info()
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


def _build_widget_entries_for_class(
    class_type: str,
    object_info: dict[str, Any],
    node_info: _NodeInfo | None = None,
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
        object_info=object_info,
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
                and node_info
                and isinstance(node_info.title, str)
                and node_info.title.strip()
                and isinstance(node_info.widget_groups, dict)
                and param_name in node_info.widget_groups
            ):
                label = node_info.title

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

            if node_info and node_info.widgets_values:
                widgets_values = node_info.widgets_values
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

            if node_info and isinstance(node_info.widget_groups, dict):
                proxy_group = node_info.widget_groups.get(param_name)
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


def _merge_existing_widget_entries_with_object_info(
    existing_widgets: dict[str, Any],
    object_info_widgets: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
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
            for key in ("group_id", "group_title", "group_order"):
                if key in enriched and key not in entry:
                    entry[key] = enriched[key]
        merged[param_name] = entry
    return merged


def enrich_rules_with_object_info(
    rules: WorkflowRules,
    workflow_data: dict[str, Any],
) -> None:
    """Resolve widget metadata via object_info.

    object_info is treated as the primary source of truth for widget data.
    - Without explicit node widget rules, this auto-discovers widgets.
    - With explicit rules, this augments known widget params with object_info
      datatype metadata when available.
    - With ``widgets_mode = 'all'``, this exposes all editable widget params
      for the node and overlays any explicit per-widget overrides.

    Mutates *rules* in place.
    """
    object_info = _load_object_info()
    if not object_info:
        log.warning("[enrich] object_info is empty or failed to load")
        return

    node_infos = _extract_node_info(workflow_data)
    log.info("[enrich] Extracted %d node infos from workflow", len(node_infos))
    if not node_infos:
        log.warning(
            "[enrich] No node infos extracted — workflow format may be unrecognized"
        )
        return

    nodes_rules = rules.setdefault("nodes", {})
    discovered_count = 0

    for node_id, info in node_infos.items():
        existing = nodes_rules.setdefault(node_id, {})
        if not isinstance(existing, dict):
            existing = {}
            nodes_rules[node_id] = existing

        if existing.get("ignore"):
            log.debug(
                "[enrich] Skipping node %s (%s): ignored",
                node_id,
                info.class_type,
            )
            continue

        widgets_mode = existing.get("widgets_mode")
        if not isinstance(widgets_mode, str):
            widgets_mode = (
                WIDGETS_MODE_ALL
                if info.class_type in DEFAULT_ALL_WIDGET_NODE_CLASSES
                else WIDGETS_MODE_CONTROL_AFTER_GENERATE
            )
        include_all_widgets = widgets_mode == WIDGETS_MODE_ALL

        discovered_widgets = _build_widget_entries_for_class(
            info.class_type,
            object_info,
            info,
            include_all_widgets=include_all_widgets,
        )

        existing_widgets = existing.get("widgets")
        if include_all_widgets and discovered_widgets:
            merged_widgets = dict(discovered_widgets)
            if isinstance(existing_widgets, dict):
                merged_widgets.update(existing_widgets)
            existing["widgets"] = _merge_existing_widget_entries_with_object_info(
                merged_widgets,
                discovered_widgets,
            )
        elif isinstance(existing_widgets, dict):
            if discovered_widgets:
                existing["widgets"] = _merge_existing_widget_entries_with_object_info(
                    existing_widgets,
                    discovered_widgets,
                )
        elif discovered_widgets:
            existing["widgets"] = discovered_widgets

        if existing.get("widgets"):
            existing["node_title"] = info.title
            discovered_count += 1
            log.info(
                "[enrich] Node %s (%s, title=%r): resolved widgets %s (mode=%s)",
                node_id,
                info.class_type,
                info.title,
                list(existing["widgets"].keys()),
                widgets_mode,
            )

    log.info(
        "[enrich] Total nodes with auto-discovered widgets: %d", discovered_count
    )


# ---------------------------------------------------------------------------
# Input node detection from object_info
# ---------------------------------------------------------------------------

# Static fallback for nodes that lack detectable metadata flags.
_STATIC_INPUT_NODE_MAP: dict[str, list[dict[str, Any]]] = {
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


def _detect_input_entry(
    param_name: str,
    param_def: Any,
) -> dict[str, Any] | None:
    if not isinstance(param_def, (list, tuple)) or len(param_def) < 1:
        return None

    type_spec = param_def[0]
    opts = param_def[1] if len(param_def) >= 2 and isinstance(param_def[1], dict) else {}
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


def _detect_node_inputs(
    class_info: dict[str, Any],
) -> list[dict[str, Any]]:
    """Detect image/video/text inputs for a node class from object_info."""
    input_spec = class_info.get("input")
    if not isinstance(input_spec, dict):
        return []

    detected: list[dict[str, Any]] = []
    seen_params: set[str] = set()
    for section_name in ("required", "optional"):
        section = input_spec.get(section_name)
        if not isinstance(section, dict):
            continue
        for param_name, param_def in section.items():
            if param_name in seen_params:
                continue
            detected_entry = _detect_input_entry(param_name, param_def)
            if detected_entry is None:
                continue
            detected.append(detected_entry)
            seen_params.add(param_name)
    return detected


def build_input_node_map(
    object_info: dict[str, Any] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Build a complete input node map from object_info + static fallbacks.

    Returns a dict of ``class_type -> [{input_type, param, label, description}, ...]``.
    """
    if object_info is None:
        object_info = _load_object_info()

    result: dict[str, list[dict[str, Any]]] = {
        class_type: [dict(entry) for entry in entries]
        for class_type, entries in _STATIC_INPUT_NODE_MAP.items()
    }

    for class_type, class_info in object_info.items():
        if not isinstance(class_info, dict):
            continue
        detected = _detect_node_inputs(class_info)
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


__all__ = [
    "enrich_rules_with_object_info",
    "OBJECT_INFO_PATH",
    "set_object_info_cache",
    "build_input_node_map",
]
