from __future__ import annotations

from collections.abc import Callable
from typing import Any

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.types import Processor, ProcessorMeta
from services.workflow_rules.schema import has_pipeline_stage


ApplyAspectRatioProcessingFn = Callable[
    [dict[str, Any], dict[str, Any], str | None, Any],
    tuple[dict[str, Any] | None, list[dict[str, Any]]],
]


class _AspectRatioProcessor:
    meta = ProcessorMeta(
        name="aspect_ratio",
        reads=("workflow", "rules", "target_aspect_ratio", "target_resolution"),
        writes=("aspect_ratio_metadata", "workflow", "warnings"),
        description="Applies aspect ratio processing to the workflow and records the returned metadata",
    )

    def __init__(self, apply_aspect_ratio_processing_fn: ApplyAspectRatioProcessingFn):
        self._apply_aspect_ratio_processing = apply_aspect_ratio_processing_fn

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return has_pipeline_stage(ctx.rules_model, "aspect_ratio") and not ctx.aspect_ratio_applied

    async def execute(self, ctx: BackendPipelineContext) -> None:
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


def create_aspect_ratio_processor(
    apply_aspect_ratio_processing_fn: ApplyAspectRatioProcessingFn,
) -> Processor:
    return _AspectRatioProcessor(apply_aspect_ratio_processing_fn)


__all__ = ["create_aspect_ratio_processor"]
