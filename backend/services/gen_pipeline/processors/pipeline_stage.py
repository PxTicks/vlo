from __future__ import annotations

from typing import Literal

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.types import Processor, ProcessorMeta
from services.workflow_rules.pipeline import iter_pipeline_stages


BackendPreprocessCheckpoint = Literal["before_upload", "after_upload"]


class _PipelineStageProcessor:
    def __init__(
        self,
        *,
        checkpoint: BackendPreprocessCheckpoint,
        stage_processors: dict[str, Processor],
    ) -> None:
        self._checkpoint = checkpoint
        self._stage_processors = stage_processors
        self.meta = ProcessorMeta(
            name=f"pipeline_stages_{checkpoint}",
            reads=("rules", "resolved_pipeline_controls", "buffered_media", "workflow"),
            writes=("buffered_media", "workflow", "pipeline_outputs", "stage_state", "warnings"),
            description=f"Runs registered backend_preprocess stage hooks for the {checkpoint} checkpoint",
        )

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return bool(ctx.rules.get("pipeline"))

    async def execute(self, ctx: BackendPipelineContext) -> None:
        for stage in iter_pipeline_stages(ctx.rules):
            if stage.get("enabled") is False:
                continue
            stage_id = stage.get("id")
            if not isinstance(stage_id, str) or not stage_id:
                continue
            processor = self._stage_processors.get(str(stage.get("kind")))
            if processor is None:
                continue
            checkpoint = getattr(processor, "backend_preprocess_checkpoint", None)
            if checkpoint != self._checkpoint:
                continue
            ctx.stage_state.setdefault(stage_id, {})
            ctx.pipeline_outputs.setdefault(stage_id, {})
            if processor.is_active(ctx):
                await processor.execute(ctx)


def create_pipeline_stage_processor(
    *,
    checkpoint: BackendPreprocessCheckpoint,
    stage_processors: dict[str, Processor],
) -> Processor:
    return _PipelineStageProcessor(
        checkpoint=checkpoint,
        stage_processors=stage_processors,
    )


__all__ = ["BackendPreprocessCheckpoint", "create_pipeline_stage_processor"]
