from __future__ import annotations

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.types import Processor, ProcessorMeta
from services.workflow_rules.pipeline import (
    resolve_pipeline_control_values_with_warnings,
)


class _ResolvePipelineControlsProcessor:
    meta = ProcessorMeta(
        name="resolve_pipeline_controls",
        reads=("workflow", "rules", "pipeline_inputs"),
        writes=("resolved_pipeline_controls",),
        description="Resolves submitted, bound, and conditional pipeline control values for every pipeline stage",
    )

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return bool(ctx.rules.get("pipeline"))

    async def execute(self, ctx: BackendPipelineContext) -> None:
        (
            ctx.resolved_pipeline_controls,
            control_warnings,
        ) = resolve_pipeline_control_values_with_warnings(
            ctx.rules,
            ctx.workflow,
            ctx.pipeline_inputs,
            input_metadata=ctx.input_metadata,
        )
        if control_warnings:
            ctx.warnings.extend(control_warnings)


resolve_pipeline_controls_processor: Processor = _ResolvePipelineControlsProcessor()


__all__ = ["resolve_pipeline_controls_processor"]
