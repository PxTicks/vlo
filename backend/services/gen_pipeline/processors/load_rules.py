from __future__ import annotations

from pathlib import Path

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.types import Processor, ProcessorMeta
from services.workflow_rules import (
    enrich_rules_with_object_info,
    load_rules_model_for_workflow,
)


class _LoadRulesProcessor:
    meta = ProcessorMeta(
        name="load_rules",
        reads=("workflow", "workflow_id"),
        writes=("rules", "warnings"),
        description="Loads and enriches workflow-sidecar rules before validation and graph rewrites",
    )

    def __init__(self, workflows_dir: Path, fallback_dirs: list[Path] | None = None):
        self._workflows_dir = workflows_dir
        self._fallback_dirs = fallback_dirs

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return True

    async def execute(self, ctx: BackendPipelineContext) -> None:
        rules_model, rule_load_warnings = load_rules_model_for_workflow(
            self._workflows_dir,
            ctx.workflow_id,
            fallback_dirs=self._fallback_dirs,
        )
        ctx.warnings.extend(dump_warning.model_dump(exclude_none=True) for dump_warning in rule_load_warnings)
        rules_model = enrich_rules_with_object_info(rules_model, ctx.workflow)
        ctx.rules_model = rules_model


def create_load_rules_processor(
    workflows_dir: Path,
    *,
    fallback_dirs: list[Path] | None = None,
) -> Processor:
    return _LoadRulesProcessor(workflows_dir, fallback_dirs=fallback_dirs)


__all__ = ["create_load_rules_processor"]
