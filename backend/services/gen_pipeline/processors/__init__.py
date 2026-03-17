"""Pipeline processors for the backend generation pipeline.

Each processor is a self-contained module that reads from and writes to
the BackendPipelineContext.  Processors are registered in an ordered list
and executed sequentially by the pipeline runner.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from services.gen_pipeline.types import Processor
from services.gen_pipeline.processors.apply_rules import create_apply_rules_processor
from services.gen_pipeline.processors.aspect_ratio import create_aspect_ratio_processor
from services.gen_pipeline.processors.inject_values import inject_values_processor
from services.gen_pipeline.processors.mask_crop import create_mask_crop_processor
from services.gen_pipeline.processors.submit_prompt import create_submit_prompt_processor
from services.gen_pipeline.processors.upload_media import create_upload_media_processor
from services.gen_pipeline.processors.widget_overrides import widget_overrides_processor


def build_generation_processors(
    *,
    workflows_dir: Path,
    input_node_map: dict[str, dict[str, str]],
    analyze_mask_video_bounds_fn: Callable[..., Any],
    crop_video_fn: Callable[[bytes, tuple[int, int, int, int]], bytes],
    get_video_dimensions_fn: Callable[[bytes], tuple[int, int]],
    upload_video_bytes_fn: Callable[..., Any],
    apply_aspect_ratio_processing_fn: Callable[..., Any],
    prompt_id_factory: Callable[[], str],
) -> list[Processor]:
    return [
        inject_values_processor,
        create_apply_rules_processor(workflows_dir),
        widget_overrides_processor,
        create_mask_crop_processor(
            analyze_mask_video_bounds_fn,
            crop_video_fn,
            get_video_dimensions_fn,
        ),
        create_upload_media_processor(
            upload_video_bytes_fn,
            input_node_map,
        ),
        create_aspect_ratio_processor(apply_aspect_ratio_processing_fn),
        create_submit_prompt_processor(prompt_id_factory),
    ]


__all__ = ["build_generation_processors"]
