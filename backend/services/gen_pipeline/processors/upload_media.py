from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.processors.inject_values import apply_injections
from services.gen_pipeline.processors.utils.warning import pipeline_warning
from services.gen_pipeline.types import Processor, ProcessorMeta


UploadVideoBytesFn = Callable[
    [Any, bytes, str, str],
    Awaitable[tuple[str | None, dict[str, Any] | None]],
]


class _UploadMediaProcessor:
    meta = ProcessorMeta(
        name="upload_media",
        reads=("buffered_videos", "workflow", "injections"),
        writes=("workflow", "injections", "warnings"),
        description="Uploads buffered media to ComfyUI and injects the returned filenames into the workflow",
    )

    def __init__(
        self,
        upload_video_bytes_fn: UploadVideoBytesFn,
        input_node_map: dict[str, list[dict[str, Any]]],
    ):
        self._upload_video_bytes = upload_video_bytes_fn
        self._input_node_map = input_node_map

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return bool(ctx.buffered_videos)

    async def execute(self, ctx: BackendPipelineContext) -> None:
        for buffered_input_id, video_info in ctx.buffered_videos.items():
            node_id = video_info.get("node_id")
            param = video_info.get("param")
            if not isinstance(node_id, str) or not isinstance(param, str):
                continue
            filename, upload_warning = await self._upload_video_bytes(
                ctx.client,
                video_info["bytes"],
                video_info["filename"],
                video_info["content_type"],
            )
            if upload_warning:
                upload_warning["node_id"] = node_id
                upload_warning.setdefault("details", {})
                upload_warning["details"]["buffered_input_id"] = buffered_input_id
                ctx.warnings.append(upload_warning)
                continue
            if not filename:
                continue

            node = ctx.workflow.get(node_id)
            if isinstance(node, dict):
                mappings = self._input_node_map.get(node.get("class_type", ""), [])
                mapping = next(
                    (entry for entry in mappings if entry.get("param") == param),
                    None,
                )
                if mapping and mapping.get("input_type") == "video":
                    ctx.injections.setdefault(node_id, {})[param] = filename
                elif mapping:
                    ctx.warnings.append(
                        pipeline_warning(
                            "media_mapping_mismatch",
                            "Media input type does not match node mapping; default node value kept",
                            node_id=node_id,
                            details={
                                "expected": mapping.get("input_type"),
                                "received": "video",
                            },
                        )
                    )

        ctx.workflow = apply_injections(ctx.workflow, ctx.injections)


def create_upload_media_processor(
    upload_video_bytes_fn: UploadVideoBytesFn,
    input_node_map: dict[str, list[dict[str, Any]]],
) -> Processor:
    return _UploadMediaProcessor(upload_video_bytes_fn, input_node_map)


__all__ = ["create_upload_media_processor"]
