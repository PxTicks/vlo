from __future__ import annotations

from collections.abc import Callable

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.types import Processor, ProcessorMeta
from services.gen_pipeline.processors.utils.graph_metadata import (
    project_prompt_to_graph_data,
)


class _SubmitPromptProcessor:
    meta = ProcessorMeta(
        name="submit_prompt",
        reads=("workflow", "client_id", "graph_data"),
        writes=("prompt_id", "comfyui_response", "graph_data"),
        description="Submits the assembled workflow prompt to ComfyUI",
    )

    def __init__(self, prompt_id_factory: Callable[[], str]):
        self._prompt_id_factory = prompt_id_factory

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return True

    async def execute(self, ctx: BackendPipelineContext) -> None:
        ctx.prompt_id = self._prompt_id_factory()
        body = {
            "prompt": ctx.workflow,
            "client_id": ctx.client_id,
            "prompt_id": ctx.prompt_id,
        }
        projected_graph_data = project_prompt_to_graph_data(
            ctx.workflow,
            ctx.graph_data,
        )
        if projected_graph_data is not None:
            ctx.graph_data = projected_graph_data
            body["extra_data"] = {
                "extra_pnginfo": {"workflow": projected_graph_data}
            }
        ctx.comfyui_response = await ctx.client.post("/prompt", json=body)


def create_submit_prompt_processor(
    prompt_id_factory: Callable[[], str],
) -> Processor:
    return _SubmitPromptProcessor(prompt_id_factory)


__all__ = ["create_submit_prompt_processor"]
