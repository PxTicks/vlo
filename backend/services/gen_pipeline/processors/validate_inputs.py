from __future__ import annotations

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.types import Processor, ProcessorMeta
from services.workflow_rules import WorkflowValidationError, evaluate_input_validation


def is_provided_value(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    return True


def collect_provided_input_ids(
    ctx: BackendPipelineContext,
) -> set[str]:
    provided_input_ids: set[str] = set()

    for node_id, injection in ctx.injections.items():
        if not isinstance(injection, dict):
            continue
        if is_provided_value(injection.get("value")):
            provided_input_ids.add(str(node_id))

    for node_id in ctx.buffered_videos.keys():
        provided_input_ids.add(str(node_id))

    for slot_id, value in ctx.manual_slot_values.items():
        if is_provided_value(value):
            provided_input_ids.add(f"slot:{slot_id}")

    return provided_input_ids


class _ValidateInputsProcessor:
    meta = ProcessorMeta(
        name="validate_inputs",
        reads=("rules", "injections", "buffered_videos", "manual_slot_values"),
        writes=("provided_input_ids",),
        description="Evaluates input validation rules against the inputs currently supplied by the request",
    )

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return True

    async def execute(self, ctx: BackendPipelineContext) -> None:
        ctx.provided_input_ids = collect_provided_input_ids(ctx)
        failures = evaluate_input_validation(ctx.rules, ctx.provided_input_ids)
        if failures:
            raise WorkflowValidationError(
                failures[0]["message"],
                failures=failures,
            )


validate_inputs_processor: Processor = _ValidateInputsProcessor()


__all__ = [
    "collect_provided_input_ids",
    "is_provided_value",
    "validate_inputs_processor",
]
