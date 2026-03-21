from __future__ import annotations

import logging
import math
from collections.abc import Callable
from typing import Any

from services.gen_pipeline.processors.utils.aspect_ratio_processing import _parse_aspect_ratio
from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.types import Processor, ProcessorMeta
from services.workflow_rules.schema import has_pipeline_stage, pipeline_stage_precedes
from services.workflow_rules import collect_mask_crop_pairs
from services.workflow_rules.mask_pairs import collect_mask_crop_pairs as _collect_pairs_raw


log = logging.getLogger(__name__)


def _has_mask_relations(rules: dict[str, Any] | None) -> bool:
    """Check if rules contain any derived-mask relations (ignoring mode)."""
    return bool(_collect_pairs_raw(rules, mode_override="crop"))


def _find_buffered_video_key(
    buffered_videos: dict[str, dict[str, Any]],
    node_id: str,
) -> str | None:
    matches = [
        buffered_input_id
        for buffered_input_id, video_info in buffered_videos.items()
        if isinstance(video_info, dict) and video_info.get("node_id") == node_id
    ]
    if len(matches) == 1:
        return matches[0]
    return None


class _MaskCropProcessor:
    meta = ProcessorMeta(
        name="mask_crop",
        reads=(
            "buffered_videos",
            "rules",
            "target_aspect_ratio",
            "mask_crop_dilation",
        ),
        writes=("buffered_videos", "mask_crop_metadata", "processed_mask_bytes"),
        description="Crops buffered source and mask videos to the mask bounds before upload",
    )

    def __init__(
        self,
        analyze_mask_video_bounds_fn: Callable[..., Any],
        crop_video_fn: Callable[[bytes, tuple[int, int, int, int]], bytes],
        get_video_dimensions_fn: Callable[[bytes], tuple[int, int]],
        apply_aspect_ratio_processing_fn: Callable[..., Any] | None = None,
    ):
        self._analyze_mask_video_bounds = analyze_mask_video_bounds_fn
        self._crop_video = crop_video_fn
        self._get_video_dimensions = get_video_dimensions_fn
        self._apply_aspect_ratio_processing = apply_aspect_ratio_processing_fn

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return bool(ctx.buffered_videos) and _has_mask_relations(ctx.rules)

    async def execute(self, ctx: BackendPipelineContext) -> None:
        if (
            self._apply_aspect_ratio_processing is not None
            and has_pipeline_stage(ctx.rules_model, "aspect_ratio")
            and has_pipeline_stage(ctx.rules_model, "mask_cropping")
            and pipeline_stage_precedes(ctx.rules_model, "aspect_ratio", "mask_cropping")
            and not ctx.aspect_ratio_applied
        ):
            (
                ctx.aspect_ratio_metadata,
                aspect_ratio_processing_warnings,
            ) = self._apply_aspect_ratio_processing(
                ctx.workflow,
                ctx.rules,
                ctx.target_aspect_ratio,
                ctx.target_resolution,
            )
            ctx.warnings.extend(aspect_ratio_processing_warnings)
            ctx.aspect_ratio_applied = True

        mask_stage_enabled = has_pipeline_stage(ctx.rules_model, "mask_cropping")

        # Check if cropping is enabled (mode is "crop" and dilation is set)
        should_crop = (
            mask_stage_enabled
            and ctx.mask_crop_dilation is not None
            and ctx.mask_crop_dilation >= 0
            and bool(collect_mask_crop_pairs(ctx.rules, ctx.mask_crop_mode))
        )

        if not should_crop:
            ctx.mask_crop_metadata = {"mode": "full"}
            # Capture unmodified mask bytes for frontend ingestion
            all_pairs = _collect_pairs_raw(ctx.rules, mode_override="crop")
            for _, mask_node_id in all_pairs:
                mask_buffered_key = _find_buffered_video_key(ctx.buffered_videos, mask_node_id)
                if mask_buffered_key is not None:
                    ctx.processed_mask_bytes = ctx.buffered_videos[mask_buffered_key]["bytes"]
                    break
            return

        mask_pairs = [
            (source_node_id, mask_node_id)
            for source_node_id, mask_node_id in collect_mask_crop_pairs(
                ctx.rules,
                ctx.mask_crop_mode,
            )
            if _find_buffered_video_key(ctx.buffered_videos, source_node_id) is not None
            and _find_buffered_video_key(ctx.buffered_videos, mask_node_id) is not None
        ]
        if not mask_pairs:
            ctx.mask_crop_metadata = {"mode": "full"}
            return

        parsed_ar = _parse_aspect_ratio(ctx.target_aspect_ratio)
        target_ar = (parsed_ar[0] / parsed_ar[1]) if parsed_ar else None
        if target_ar is None:
            ctx.mask_crop_metadata = {"mode": "full"}
            return

        cropped_sources: set[str] = set()
        # Future: support mask-batch metadata by returning per-pair crop entries
        # keyed by source/mask node. The main complexity is that one source can
        # be shared by multiple masks with different crop regions.
        last_successful_mask_crop_region: tuple[int, int, int, int] | None = None
        last_successful_mask_container_dims: tuple[int, int] | None = None

        for source_node_id, mask_node_id in mask_pairs:
            source_buffered_key = _find_buffered_video_key(ctx.buffered_videos, source_node_id)
            mask_buffered_key = _find_buffered_video_key(ctx.buffered_videos, mask_node_id)
            if source_buffered_key is None or mask_buffered_key is None:
                continue
            mask_data = ctx.buffered_videos[mask_buffered_key]["bytes"]
            try:
                container_dims = self._get_video_dimensions(mask_data)
                crop_region = self._analyze_mask_video_bounds(
                    mask_data,
                    target_ar=target_ar,
                    dilation=ctx.mask_crop_dilation,
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

            log.info(
                "[mask-crop] Cropping video %s + mask %s to %s",
                source_node_id,
                mask_node_id,
                crop_region,
            )
            try:
                ctx.buffered_videos[mask_buffered_key]["bytes"] = self._crop_video(
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

            if source_node_id in cropped_sources:
                continue

            try:
                ctx.buffered_videos[source_buffered_key]["bytes"] = self._crop_video(
                    ctx.buffered_videos[source_buffered_key]["bytes"],
                    crop_region,
                )
                cropped_sources.add(source_node_id)
            except Exception as exc:
                log.warning(
                    "[mask-crop] Source crop encoding failed for %s: %s",
                    source_node_id,
                    exc,
                )

        # Capture processed mask bytes (cropped or original) for frontend ingestion
        for _, mask_node_id in mask_pairs:
            mask_buffered_key = _find_buffered_video_key(ctx.buffered_videos, mask_node_id)
            if mask_buffered_key is not None:
                ctx.processed_mask_bytes = ctx.buffered_videos[mask_buffered_key]["bytes"]
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
            ctx.mask_crop_metadata = {
                "mode": "cropped",
                "crop_position": [x1, y1],
                "crop_size": [crop_w, crop_h],
                "container_size": [container_w, container_h],
                "scale": round(scale, 6),
            }
        else:
            ctx.mask_crop_metadata = {"mode": "full"}


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
