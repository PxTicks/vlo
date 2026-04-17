from pathlib import Path

import httpx

from routers import comfyui as comfyui_router
from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.processors.validate_inputs import collect_provided_input_ids


def test_collect_provided_input_ids_ignores_synthetic_buffered_media():
    ctx = BackendPipelineContext(
        client=httpx.AsyncClient(base_url="http://example.test"),
        client_id="client",
        workflow={},
        buffered_media={
            "167:image": {
                "node_id": "167",
                "param": "image",
                "input_type": "image",
                "synthetic": True,
            }
        },
    )

    assert collect_provided_input_ids(ctx) == set()


def test_apply_workflow_media_fallbacks_buffers_dummy_image_as_synthetic(
    monkeypatch,
    tmp_path: Path,
):
    fallback_path = tmp_path / "dummy_photo.jpeg"
    fallback_path.write_bytes(b"dummy")
    monkeypatch.setattr(
        comfyui_router,
        "WORKFLOW_MEDIA_FALLBACKS",
        {
            "workflow.json": (
                {
                    "node_id": "167",
                    "input_type": "image",
                    "filename": "dummy_photo.jpeg",
                    "content_type": "image/jpeg",
                    "path": fallback_path,
                },
            )
        },
    )

    workflow = {
        "167": {
            "class_type": "LoadImage",
            "inputs": {},
        }
    }
    buffered_media: dict[str, dict[str, object]] = {}
    warnings: list[dict[str, object]] = []

    comfyui_router._apply_workflow_media_fallbacks(
        workflow_id="workflow.json",
        workflow=workflow,
        buffered_media=buffered_media,
        workflow_warnings=warnings,
        node_map={
            "LoadImage": [
                {
                    "input_type": "image",
                    "param": "image",
                    "label": "Image",
                    "description": None,
                }
            ]
        },
    )

    assert warnings == []
    assert buffered_media == {
        "167:image": {
            "node_id": "167",
            "param": "image",
            "input_type": "image",
            "class_type": "LoadImage",
            "bytes": b"dummy",
            "content_type": "image/jpeg",
            "filename": "dummy_photo.jpeg",
            "synthetic": True,
        }
    }
