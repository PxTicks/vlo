"""Input node discovery from object_info.

Detects image/video/text input nodes by scanning for ``image_upload``,
``video_upload``, and ``dynamicPrompts`` flags on node parameters.
``_INPUT_NODE_FALLBACKS`` covers nodes that lack those metadata flags
but are known input nodes (e.g. VHS_LoadVideo).
"""

from typing import Any

from services.workflow_rules.node_discovery import iter_all_params


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


def discover_node_inputs(
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
        detected = discover_node_inputs(class_info)
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
    "build_input_node_map",
    "discover_node_inputs",
]
