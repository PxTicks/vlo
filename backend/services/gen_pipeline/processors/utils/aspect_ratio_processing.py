import math
from typing import Any

from services.gen_pipeline.processors.utils.warning import pipeline_warning


def _to_positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.isdigit():
            parsed = int(stripped)
            return parsed if parsed > 0 else None
    return None


def _parse_aspect_ratio(value: str | None) -> tuple[float, float] | None:
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw:
        return None

    separator = ":" if ":" in raw else "/"
    if separator not in raw:
        return None

    left, right = raw.split(separator, 1)
    try:
        width_part = float(left.strip())
        height_part = float(right.strip())
    except ValueError:
        return None

    if width_part <= 0 or height_part <= 0:
        return None
    return width_part, height_part


def derive_true_dimensions_from_short_edge(
    aspect_ratio: str,
    resolution: int,
) -> tuple[int, int] | None:
    parsed = _parse_aspect_ratio(aspect_ratio)
    if not parsed:
        return None

    width_part, height_part = parsed
    ratio = width_part / height_part
    if ratio <= 0:
        return None

    # Project setting is interpreted as the short edge resolution.
    # e.g. 720p at 16:9 → 1280×720 (720 is the short edge).
    if ratio >= 1:
        height = resolution
        width = max(1, int(round(height * ratio)))
    else:
        width = resolution
        height = max(1, int(round(width / ratio)))

    return width, height


def _build_candidate(
    target_width: int,
    target_height: int,
    width: int,
    height: int,
    stride: int,
    search_steps: int,
) -> dict[str, Any]:
    target_ar = target_width / target_height
    candidate_ar = width / height
    distortion = candidate_ar / target_ar
    error = abs(1 - distortion)
    area_delta = abs((width * height) - (target_width * target_height))
    pixel_delta = abs(width - target_width) + abs(height - target_height)

    return {
        "width": width,
        "height": height,
        "aspect_ratio": candidate_ar,
        "distortion": distortion,
        "error": error,
        "area_delta": area_delta,
        "pixel_delta": pixel_delta,
        "stride": stride,
        "search_steps": search_steps,
    }


def find_best_strided_dimensions(
    target_width: int,
    target_height: int,
    stride: int,
    search_steps: int,
) -> dict[str, Any] | None:
    if target_width <= 0 or target_height <= 0 or stride <= 0 or search_steps < 0:
        return None

    target_ar = target_width / target_height
    base_width = round(target_width / stride) * stride
    base_height = round(target_height / stride) * stride

    dedupe: set[tuple[int, int]] = set()
    candidates: list[dict[str, Any]] = []

    def _add_candidate(width: int, height: int) -> None:
        if width <= 0 or height <= 0:
            return
        key = (width, height)
        if key in dedupe:
            return
        dedupe.add(key)
        candidates.append(
            _build_candidate(
                target_width,
                target_height,
                width,
                height,
                stride,
                search_steps,
            )
        )

    # Width-anchored search
    for step in range(-search_steps, search_steps + 1):
        width_candidate = base_width + (step * stride)
        if width_candidate <= 0:
            continue
        ideal_height = width_candidate / target_ar
        height_floor = math.floor(ideal_height / stride) * stride
        height_ceil = math.ceil(ideal_height / stride) * stride
        _add_candidate(width_candidate, height_floor)
        _add_candidate(width_candidate, height_ceil)

    # Height-anchored search
    for step in range(-search_steps, search_steps + 1):
        height_candidate = base_height + (step * stride)
        if height_candidate <= 0:
            continue
        ideal_width = height_candidate * target_ar
        width_floor = math.floor(ideal_width / stride) * stride
        width_ceil = math.ceil(ideal_width / stride) * stride
        _add_candidate(width_floor, height_candidate)
        _add_candidate(width_ceil, height_candidate)

    if not candidates:
        return None

    candidates.sort(
        key=lambda candidate: (
            candidate["error"],
            candidate["area_delta"],
            candidate["pixel_delta"],
        )
    )
    return candidates[0]


def apply_aspect_ratio_processing(
    workflow: dict[str, Any],
    rules: dict[str, Any],
    target_aspect_ratio: str | None,
    target_resolution_raw: Any,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    warnings: list[dict[str, Any]] = []
    config = rules.get("aspect_ratio_processing")
    if not isinstance(config, dict):
        return None, warnings
    if not bool(config.get("enabled")):
        return None, warnings

    if not isinstance(target_aspect_ratio, str) or not target_aspect_ratio.strip():
        warnings.append(
            pipeline_warning(
                "aspect_ratio_processing_missing_target_aspect_ratio",
                "target_aspect_ratio is required when aspect_ratio_processing is enabled",
            )
        )
        return None, warnings

    target_resolution = _to_positive_int(target_resolution_raw)
    if target_resolution is None:
        warnings.append(
            pipeline_warning(
                "aspect_ratio_processing_invalid_target_resolution",
                "target_resolution must be a positive integer when aspect_ratio_processing is enabled",
                details={"target_resolution": target_resolution_raw},
            )
        )
        return None, warnings

    allowed_resolutions = config.get("resolutions")
    if isinstance(allowed_resolutions, list) and len(allowed_resolutions) > 0:
        if target_resolution not in allowed_resolutions:
            # Pick the closest allowed resolution
            closest = min(allowed_resolutions, key=lambda r: abs(r - target_resolution))
            warnings.append(
                pipeline_warning(
                    "aspect_ratio_processing_resolution_clamped",
                    f"target_resolution {target_resolution} not in allowed resolutions; clamped to {closest}",
                    details={
                        "target_resolution": target_resolution,
                        "allowed_resolutions": allowed_resolutions,
                        "clamped_to": closest,
                    },
                )
            )
            target_resolution = closest

    true_dims = derive_true_dimensions_from_short_edge(
        target_aspect_ratio,
        target_resolution,
    )
    if true_dims is None:
        warnings.append(
            pipeline_warning(
                "aspect_ratio_processing_invalid_target_aspect_ratio",
                "target_aspect_ratio must follow a '<width>:<height>' format with positive numbers",
                details={"target_aspect_ratio": target_aspect_ratio},
            )
        )
        return None, warnings

    true_width, true_height = true_dims

    stride = _to_positive_int(config.get("stride")) or 16
    search_steps_raw = config.get("search_steps")
    if isinstance(search_steps_raw, bool):
        search_steps = 2
    elif isinstance(search_steps_raw, int):
        search_steps = max(0, search_steps_raw)
    elif isinstance(search_steps_raw, str) and search_steps_raw.strip().isdigit():
        search_steps = max(0, int(search_steps_raw.strip()))
    else:
        search_steps = 2

    best = find_best_strided_dimensions(
        target_width=true_width,
        target_height=true_height,
        stride=stride,
        search_steps=search_steps,
    )
    if best is None:
        warnings.append(
            pipeline_warning(
                "aspect_ratio_processing_candidate_search_failed",
                "Could not find valid strided dimensions from target dimensions",
                details={
                    "target_width": true_width,
                    "target_height": true_height,
                    "stride": stride,
                    "search_steps": search_steps,
                },
            )
        )
        return None, warnings

    target_nodes = config.get("target_nodes")
    applied_nodes: list[dict[str, str]] = []
    if isinstance(target_nodes, list):
        for node_cfg in target_nodes:
            if not isinstance(node_cfg, dict):
                continue
            node_id = node_cfg.get("node_id")
            width_param = node_cfg.get("width_param")
            height_param = node_cfg.get("height_param")
            if (
                not isinstance(node_id, str)
                or not isinstance(width_param, str)
                or not isinstance(height_param, str)
                or not node_id.strip()
                or not width_param.strip()
                or not height_param.strip()
            ):
                continue

            node = workflow.get(node_id)
            if not isinstance(node, dict):
                warnings.append(
                    pipeline_warning(
                        "aspect_ratio_processing_target_node_missing",
                        "Configured aspect_ratio_processing target node was not found in workflow",
                        details={"node_id": node_id},
                    )
                )
                continue
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                warnings.append(
                    pipeline_warning(
                        "aspect_ratio_processing_target_node_inputs_missing",
                        "Configured target node does not expose an inputs object",
                        details={"node_id": node_id},
                    )
                )
                continue

            inputs[width_param] = best["width"]
            inputs[height_param] = best["height"]
            applied_nodes.append(
                {
                    "node_id": node_id,
                    "width_param": width_param,
                    "height_param": height_param,
                }
            )

    if not applied_nodes:
        warnings.append(
            pipeline_warning(
                "aspect_ratio_processing_no_nodes_applied",
                "Aspect ratio processing was enabled but no configured target nodes were applied",
            )
        )
        return None, warnings

    postprocess_cfg = config.get("postprocess")
    postprocess_enabled = True
    postprocess_mode = "stretch_exact"
    postprocess_apply_to = "all_visual_outputs"
    if isinstance(postprocess_cfg, dict):
        if "enabled" in postprocess_cfg:
            postprocess_enabled = bool(postprocess_cfg.get("enabled"))
        raw_mode = postprocess_cfg.get("mode")
        if isinstance(raw_mode, str) and raw_mode.strip():
            postprocess_mode = raw_mode.strip()
        raw_apply_to = postprocess_cfg.get("apply_to")
        if isinstance(raw_apply_to, str) and raw_apply_to.strip():
            postprocess_apply_to = raw_apply_to.strip()

    metadata = {
        "enabled": True,
        "requested": {
            "aspect_ratio": target_aspect_ratio,
            "resolution": target_resolution,
            "width": true_width,
            "height": true_height,
        },
        "strided": {
            "width": best["width"],
            "height": best["height"],
            "aspect_ratio": best["aspect_ratio"],
            "distortion": best["distortion"],
            "error": best["error"],
            "stride": best["stride"],
            "search_steps": best["search_steps"],
        },
        "applied_nodes": applied_nodes,
        "postprocess": {
            "enabled": postprocess_enabled,
            "mode": postprocess_mode,
            "apply_to": postprocess_apply_to,
            "target_width": true_width,
            "target_height": true_height,
        },
    }

    return metadata, warnings
