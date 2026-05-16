from __future__ import annotations

from typing import Any

import httpx
import pytest

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.processors.upload_media import create_upload_media_processor


def _make_context(
    disable_in_memory: Any,
    *,
    class_type: str = "VLOMemoryLoadImage",
) -> BackendPipelineContext:
    return BackendPipelineContext(
        client=httpx.AsyncClient(),
        client_id="client-id",
        workflow={
            "92": {
                "class_type": class_type,
                "inputs": {
                    "image": "",
                    "disable_in_memory": disable_in_memory,
                },
            }
        },
        buffered_media={
            "92:image": {
                "node_id": "92",
                "param": "image",
                "input_type": "image",
                "class_type": class_type,
                "bytes": b"image-bytes",
                "content_type": "image/png",
                "filename": "frame.png",
            }
        },
    )


@pytest.mark.asyncio
async def test_upload_media_processor_registers_memory_loader_media_by_default():
    calls: list[str] = []

    async def upload_media_bytes_fn(*args, **kwargs):
        calls.append("upload")
        return "frame.png", None

    async def register_media_bytes_fn(*args, **kwargs):
        calls.append("register")
        return "media-id-123", None

    processor = create_upload_media_processor(
        upload_media_bytes_fn=upload_media_bytes_fn,
        register_media_bytes_fn=register_media_bytes_fn,
        input_node_map={
            "VLOMemoryLoadImage": [
                {"input_type": "image", "param": "image"},
            ]
        },
    )
    ctx = _make_context(False)

    try:
        await processor.execute(ctx)
    finally:
        await ctx.client.aclose()

    assert calls == ["register"]
    assert ctx.workflow["92"]["inputs"]["image"] == "media-id-123"


@pytest.mark.asyncio
async def test_upload_media_processor_falls_back_to_file_upload_when_memory_loader_disabled():
    calls: list[str] = []

    async def upload_media_bytes_fn(*args, **kwargs):
        calls.append("upload")
        return "frame.png", None

    async def register_media_bytes_fn(*args, **kwargs):
        calls.append("register")
        return "media-id-123", None

    processor = create_upload_media_processor(
        upload_media_bytes_fn=upload_media_bytes_fn,
        register_media_bytes_fn=register_media_bytes_fn,
        input_node_map={
            "VLOMemoryLoadImage": [
                {"input_type": "image", "param": "image"},
            ]
        },
    )
    ctx = _make_context("true")

    try:
        await processor.execute(ctx)
    finally:
        await ctx.client.aclose()

    assert calls == ["upload"]
    assert ctx.workflow["92"]["inputs"]["image"] == "frame.png"


@pytest.mark.asyncio
async def test_upload_media_processor_accepts_lowercase_vlo_memory_loader_aliases():
    calls: list[str] = []

    async def upload_media_bytes_fn(*args, **kwargs):
        calls.append("upload")
        return "frame.png", None

    async def register_media_bytes_fn(*args, **kwargs):
        calls.append("register")
        return "media-id-123", None

    processor = create_upload_media_processor(
        upload_media_bytes_fn=upload_media_bytes_fn,
        register_media_bytes_fn=register_media_bytes_fn,
        input_node_map={
            "VLOMemoryLoadImage": [
                {"input_type": "image", "param": "image"},
            ]
        },
    )
    ctx = _make_context(False, class_type="vloMemoryLoadImage")

    try:
        await processor.execute(ctx)
    finally:
        await ctx.client.aclose()

    assert calls == ["register"]
    assert ctx.workflow["92"]["inputs"]["image"] == "media-id-123"
