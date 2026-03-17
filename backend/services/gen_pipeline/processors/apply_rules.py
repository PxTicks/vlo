from __future__ import annotations

from pathlib import Path

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.types import Processor, ProcessorMeta
from services.workflow_rules import (
    apply_rules_to_workflow,
    enrich_rules_with_object_info,
    find_unsatisfied_input_conditions,
    load_rules_for_workflow,
)


class _ApplyRulesProcessor:
    meta = ProcessorMeta(
        name="apply_rules",
        reads=("workflow", "workflow_id", "manual_slot_values"),
        writes=("rules", "workflow", "warnings"),
        description="Loads, enriches, and applies workflow sidecar rules to the workflow",
    )

    def __init__(self, workflows_dir: Path):
        self._workflows_dir = workflows_dir

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return True

    @staticmethod
    def _is_provided_value(value: object) -> bool:
        if value is None:
            return False
        if isinstance(value, str):
            return value.strip() != ""
        return True

    def _collect_provided_input_ids(
        self,
        ctx: BackendPipelineContext,
    ) -> set[str]:
        provided_input_ids: set[str] = set()

        for node_id, injection in ctx.injections.items():
            if not isinstance(injection, dict):
                continue
            if self._is_provided_value(injection.get("value")):
                provided_input_ids.add(str(node_id))

        for node_id in ctx.buffered_videos.keys():
            provided_input_ids.add(str(node_id))

        for slot_id, value in ctx.manual_slot_values.items():
            if self._is_provided_value(value):
                provided_input_ids.add(f"slot:{slot_id}")

        return provided_input_ids

    async def execute(self, ctx: BackendPipelineContext) -> None:
        rules, rule_load_warnings = load_rules_for_workflow(
            self._workflows_dir, ctx.workflow_id
        )
        ctx.warnings.extend(rule_load_warnings)
        enrich_rules_with_object_info(rules, ctx.workflow)
        provided_input_ids = self._collect_provided_input_ids(ctx)
        unsatisfied_input_conditions = find_unsatisfied_input_conditions(
            rules,
            provided_input_ids,
        )
        if unsatisfied_input_conditions:
            raise ValueError(unsatisfied_input_conditions[0])
        ctx.workflow, rule_apply_warnings = apply_rules_to_workflow(
            ctx.workflow,
            rules,
            manual_slot_values=ctx.manual_slot_values,
            provided_input_ids=provided_input_ids,
        )
        ctx.warnings.extend(rule_apply_warnings)
        ctx.rules = rules


def create_apply_rules_processor(workflows_dir: Path) -> Processor:
    return _ApplyRulesProcessor(workflows_dir)


__all__ = ["create_apply_rules_processor"]
