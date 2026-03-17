from __future__ import annotations

from typing import Any

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.types import Processor, ProcessorMeta


def apply_injections(
    workflow: dict[str, Any],
    injections: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Inject frontend-provided values into workflow node inputs by node ID."""
    for node_id, injection in injections.items():
        node = workflow.get(node_id)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue
        inputs[injection["param"]] = injection["value"]
    return workflow


class _InjectValuesProcessor:
    meta = ProcessorMeta(
        name="inject_values",
        reads=("workflow", "injections"),
        writes=("workflow",),
        description="Injects frontend-provided node input values into the workflow",
    )

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return bool(ctx.injections)

    async def execute(self, ctx: BackendPipelineContext) -> None:
        ctx.workflow = apply_injections(ctx.workflow, ctx.injections)


inject_values_processor: Processor = _InjectValuesProcessor()


__all__ = ["apply_injections", "inject_values_processor"]
