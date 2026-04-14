from __future__ import annotations

from collections.abc import Callable
from typing import Any

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.types import Processor, ProcessorMeta
from services.workflow_rules.pipeline import find_pipeline_stage


ApplyAspectRatioProcessingFn = Callable[
    [dict[str, Any], dict[str, Any], str | None, Any],
    tuple[dict[str, Any] | None, list[dict[str, Any]]],
]


class _AspectRatioProcessor:
    backend_preprocess_checkpoint = "after_upload"
    meta = ProcessorMeta(
        name="aspect_ratio",
        reads=(
            "workflow",
            "rules",
            "resolved_pipeline_controls",
        ),
        writes=("pipeline_outputs", "workflow", "warnings"),
        description="Applies aspect ratio processing to the workflow and records the returned metadata",
    )

    def __init__(self, apply_aspect_ratio_processing_fn: ApplyAspectRatioProcessingFn):
        self._apply_aspect_ratio_processing = apply_aspect_ratio_processing_fn

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return find_pipeline_stage(ctx.rules, kind="aspect_ratio") is not None

    async def execute(self, ctx: BackendPipelineContext) -> None:
        stage = find_pipeline_stage(ctx.rules, kind="aspect_ratio")
        if not isinstance(stage, dict):
            return
        stage_id = stage.get("id")
        if not isinstance(stage_id, str) or not stage_id:
            return
        control_values = ctx.resolved_pipeline_controls.get(stage_id, {})
        (
            metadata,
            aspect_ratio_processing_warnings,
        ) = self._apply_aspect_ratio_processing(
            ctx.workflow,
            ctx.rules,
            control_values.get("target_aspect_ratio"),
            control_values.get("target_resolution"),
        )
        ctx.warnings.extend(aspect_ratio_processing_warnings)
        if metadata is not None:
            ctx.pipeline_outputs.setdefault(stage_id, {})[
                "aspect_ratio_processing"
            ] = metadata


def create_aspect_ratio_processor(
    apply_aspect_ratio_processing_fn: ApplyAspectRatioProcessingFn,
) -> Processor:
    return _AspectRatioProcessor(apply_aspect_ratio_processing_fn)


__all__ = ["create_aspect_ratio_processor"]
