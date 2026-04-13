from __future__ import annotations

import logging
import math
from collections.abc import Callable
from typing import Any

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.processors.utils.aspect_ratio_processing import _parse_aspect_ratio
from services.gen_pipeline.types import Processor, ProcessorMeta
from services.workflow_rules import collect_mask_crop_pairs
from services.workflow_rules.mask_pairs import collect_mask_crop_pairs as _collect_pairs_raw
from services.workflow_rules.pipeline import find_pipeline_stage


log = logging.getLogger(__name__)


def _has_mask_relations(rules: dict[str, Any] | None) -> bool:
    return bool(_collect_pairs_raw(rules, mode_override="crop"))


def _find_buffered_video_key(
    buffered_media: dict[str, dict[str, Any]],
    node_id: str,
) -> str | None:
    matches = [
        buffered_input_id
        for buffered_input_id, media_info in buffered_media.items()
        if (
            isinstance(media_info, dict)
            and media_info.get("node_id") == node_id
            and media_info.get("input_type") == "video"
        )
    ]
    if len(matches) == 1:
        return matches[0]
    return None


class _MaskCropProcessor:
    backend_preprocess_checkpoint = "before_upload"
    meta = ProcessorMeta(
        name="mask_crop",
        reads=("buffered_media", "rules", "resolved_pipeline_controls"),
        writes=("buffered_media", "pipeline_outputs"),
        description="Crops buffered source and mask videos to the mask bounds before upload",
    )

    def __init__(
        self,
        analyze_mask_video_bounds_fn: Callable[..., Any],
        crop_video_fn: Callable[[bytes, tuple[int, int, int, int]], bytes],
        get_video_dimensions_fn: Callable[[bytes], tuple[int, int]],
        _apply_aspect_ratio_processing_fn: Callable[..., Any] | None = None,
    ):
        self._analyze_mask_video_bounds = analyze_mask_video_bounds_fn
        self._crop_video = crop_video_fn
        self._get_video_dimensions = get_video_dimensions_fn

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return bool(ctx.buffered_media) and _has_mask_relations(ctx.rules)

    async def execute(self, ctx: BackendPipelineContext) -> None:
        mask_stage = find_pipeline_stage(ctx.rules, kind="mask_processing")
        if not isinstance(mask_stage, dict):
            return
        mask_stage_id = mask_stage.get("id")
        if not isinstance(mask_stage_id, str) or not mask_stage_id:
            return

        mask_controls = ctx.resolved_pipeline_controls.get(mask_stage_id, {})
        crop_mode = mask_controls.get("crop_mode")
        crop_dilation = mask_controls.get("crop_dilation")

        aspect_stage = find_pipeline_stage(ctx.rules, kind="aspect_ratio")
        aspect_control_values: dict[str, Any] = {}
        if isinstance(aspect_stage, dict):
            aspect_stage_id = aspect_stage.get("id")
            if isinstance(aspect_stage_id, str) and aspect_stage_id:
                aspect_control_values = ctx.resolved_pipeline_controls.get(
                    aspect_stage_id,
                    {},
                )

        should_crop = (
            crop_mode != "full"
            and isinstance(crop_dilation, (int, float))
            and float(crop_dilation) >= 0
            and bool(
                collect_mask_crop_pairs(
                    ctx.rules,
                    crop_mode,
                    resolved_pipeline_controls=ctx.resolved_pipeline_controls,
                )
            )
        )

        stage_outputs = ctx.pipeline_outputs.setdefault(mask_stage_id, {})

        if not should_crop:
            stage_outputs["mask_crop_metadata"] = {"mode": "full"}
            for _, mask_node_id in _collect_pairs_raw(ctx.rules, mode_override="crop"):
                mask_buffered_key = _find_buffered_video_key(ctx.buffered_media, mask_node_id)
                if mask_buffered_key is not None:
                    stage_outputs["processed_mask_bytes"] = ctx.buffered_media[
                        mask_buffered_key
                    ]["bytes"]
                    break
            return

        mask_pairs = [
            (source_node_id, mask_node_id)
            for source_node_id, mask_node_id in collect_mask_crop_pairs(
                ctx.rules,
                crop_mode if isinstance(crop_mode, str) else None,
                resolved_pipeline_controls=ctx.resolved_pipeline_controls,
            )
            if _find_buffered_video_key(ctx.buffered_media, source_node_id) is not None
            and _find_buffered_video_key(ctx.buffered_media, mask_node_id) is not None
        ]
        if not mask_pairs:
            stage_outputs["mask_crop_metadata"] = {"mode": "full"}
            return

        parsed_ar = _parse_aspect_ratio(aspect_control_values.get("target_aspect_ratio"))
        target_ar = (parsed_ar[0] / parsed_ar[1]) if parsed_ar else None
        if target_ar is None:
            stage_outputs["mask_crop_metadata"] = {"mode": "full"}
            return

        cropped_sources: set[str] = set()
        last_successful_mask_crop_region: tuple[int, int, int, int] | None = None
        last_successful_mask_container_dims: tuple[int, int] | None = None

        for source_node_id, mask_node_id in mask_pairs:
            source_buffered_key = _find_buffered_video_key(ctx.buffered_media, source_node_id)
            mask_buffered_key = _find_buffered_video_key(ctx.buffered_media, mask_node_id)
            if source_buffered_key is None or mask_buffered_key is None:
                continue

            mask_data = ctx.buffered_media[mask_buffered_key]["bytes"]
            try:
                container_dims = self._get_video_dimensions(mask_data)
                crop_region = self._analyze_mask_video_bounds(
                    mask_data,
                    target_ar=target_ar,
                    dilation=float(crop_dilation),
                )
            except Exception as exc:
                log.warning(
                    "[mask-crop] Failed to analyse mask for node %s: %s",
                    mask_node_id,
                    exc,
                )
                crop_region = None
                container_dims = None

            if crop_region is None:
                continue

            try:
                ctx.buffered_media[mask_buffered_key]["bytes"] = self._crop_video(
                    mask_data,
                    crop_region,
                )
            except Exception as exc:
                log.warning(
                    "[mask-crop] Mask crop encoding failed for %s: %s",
                    mask_node_id,
                    exc,
                )
                continue

            last_successful_mask_crop_region = crop_region
            last_successful_mask_container_dims = container_dims

            if source_node_id not in cropped_sources:
                try:
                    ctx.buffered_media[source_buffered_key]["bytes"] = self._crop_video(
                        ctx.buffered_media[source_buffered_key]["bytes"],
                        crop_region,
                    )
                    cropped_sources.add(source_node_id)
                except Exception as exc:
                    log.warning(
                        "[mask-crop] Source crop encoding failed for %s: %s",
                        source_node_id,
                        exc,
                    )

        for _, mask_node_id in mask_pairs:
            mask_buffered_key = _find_buffered_video_key(ctx.buffered_media, mask_node_id)
            if mask_buffered_key is not None:
                stage_outputs["processed_mask_bytes"] = ctx.buffered_media[
                    mask_buffered_key
                ]["bytes"]
                break

        if (
            last_successful_mask_crop_region is not None
            and last_successful_mask_container_dims is not None
        ):
            x1, y1, x2, y2 = last_successful_mask_crop_region
            container_w, container_h = last_successful_mask_container_dims
            crop_w = x2 - x1
            crop_h = y2 - y1
            original_diag = math.sqrt(container_w ** 2 + container_h ** 2)
            cropped_diag = math.sqrt(crop_w ** 2 + crop_h ** 2)
            scale = cropped_diag / original_diag if original_diag > 0 else 1.0
            stage_outputs["mask_crop_metadata"] = {
                "mode": "cropped",
                "crop_position": [x1, y1],
                "crop_size": [crop_w, crop_h],
                "container_size": [container_w, container_h],
                "scale": round(scale, 6),
            }
        else:
            stage_outputs["mask_crop_metadata"] = {"mode": "full"}


def create_mask_crop_processor(
    analyze_mask_video_bounds_fn: Callable[..., Any],
    crop_video_fn: Callable[[bytes, tuple[int, int, int, int]], bytes],
    get_video_dimensions_fn: Callable[[bytes], tuple[int, int]],
    apply_aspect_ratio_processing_fn: Callable[..., Any] | None = None,
) -> Processor:
    return _MaskCropProcessor(
        analyze_mask_video_bounds_fn,
        crop_video_fn,
        get_video_dimensions_fn,
        apply_aspect_ratio_processing_fn,
    )


__all__ = ["create_mask_crop_processor"]
