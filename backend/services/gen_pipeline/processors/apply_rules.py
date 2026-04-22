from __future__ import annotations

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.types import Processor, ProcessorMeta
from services.workflow_rules import apply_rules_to_workflow


class _ApplyRulesProcessor:
    meta = ProcessorMeta(
        name="apply_rules",
        reads=(
            "workflow",
            "rules",
            "provided_input_ids",
            "graph_data",
            "resolved_pipeline_controls",
            "derived_widget_values",
        ),
        writes=("workflow", "warnings"),
        description="Applies normalized workflow rules to the workflow graph",
    )

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return not ctx.skip_graph_rewrite

    async def execute(self, ctx: BackendPipelineContext) -> None:
        ctx.workflow, rule_apply_warnings = apply_rules_to_workflow(
            ctx.workflow,
            ctx.rules_model,
            provided_input_ids=ctx.provided_input_ids,
            graph_data=ctx.graph_data,
            rules_already_resolved=True,
            pipeline_control_values=ctx.resolved_pipeline_controls,
            derived_widget_values=ctx.derived_widget_values,
        )
        ctx.warnings.extend(rule_apply_warnings)


def create_apply_rules_processor() -> Processor:
    return _ApplyRulesProcessor()


__all__ = ["create_apply_rules_processor"]
