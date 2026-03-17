import base64
import json
import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from services.gen_pipeline.processors.utils.aspect_ratio_processing import apply_aspect_ratio_processing
from services.gen_pipeline import BackendPipelineContext, run_processors
from services.gen_pipeline.processors import build_generation_processors
from services.gen_pipeline.processors.utils.video_crop import analyze_mask_video_bounds, crop_video, get_video_dimensions
from services.workflow_rules.mask_pairs import MaskCroppingMode

logger = logging.getLogger(__name__)

WORKFLOWS_DIR = Path(__file__).parent.parent / "assets" / "workflows"

# Maps ComfyUI class_type -> discoverable input type
INPUT_NODE_MAP = {
    "LoadImage": {"input_type": "image", "param": "image"},
    "CLIPTextEncode": {"input_type": "text", "param": "text"},
    "LoadVideo": {"input_type": "video", "param": "file"},
    "VHS_LoadVideo": {"input_type": "video", "param": "video"},
}

WIDGET_CONTROL_MODES = {"fixed", "randomize"}


@dataclass
class GenerationInput:
    client_id: str
    workflow: dict
    workflow_id: str | None = None
    target_aspect_ratio: str | None = None
    target_resolution_raw: Any = None
    mask_crop_dilation: float | None = None
    mask_crop_mode: MaskCroppingMode | None = None
    injections: dict[str, dict] = field(default_factory=dict)
    manual_slot_values: dict[str, Any] = field(default_factory=dict)
    widget_overrides: dict[str, dict[str, Any]] = field(default_factory=dict)
    widget_modes: dict[str, dict[str, str]] = field(default_factory=dict)
    buffered_videos: dict[str, dict[str, Any]] = field(default_factory=dict)
    graph_data: dict[str, Any] | None = None
    workflow_warnings: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class GenerationResult:
    content: bytes
    status_code: int
    media_type: str


def parse_widget_form_key(raw_key: str) -> tuple[str, str] | None:
    sep_idx = raw_key.find("_")
    if sep_idx <= 0 or sep_idx >= len(raw_key) - 1:
        return None
    node_id = raw_key[:sep_idx]
    param = raw_key[sep_idx + 1:]
    if not node_id or not param:
        return None
    return node_id, param


async def upload_form_media_to_comfy(
    client: httpx.AsyncClient,
    upload_file: Any,
    media_type: str,
) -> tuple[str | None, dict[str, Any] | None]:
    if not hasattr(upload_file, "read"):
        return None, {
            "code": "invalid_upload_field",
            "message": "Upload field is not a file-like object",
            "details": {"media_type": media_type},
        }

    # ComfyUI accepts all media types via the /upload/image endpoint.
    fallback_content_types = {"image": "image/png", "video": "video/mp4", "audio": "audio/wav"}
    fallback_content_type = fallback_content_types.get(media_type)
    if fallback_content_type is None:
        return None, {
            "code": "unsupported_media_type",
            "message": "Unsupported upload media type",
            "details": {"media_type": media_type},
        }

    media_bytes = await upload_file.read()
    filename_value = getattr(upload_file, "filename", f"upload.{media_type}")
    content_type = getattr(upload_file, "content_type", None) or fallback_content_type

    upload_resp = await client.post(
        "/upload/image",
        files={"image": (filename_value, media_bytes, content_type)},
        data={"overwrite": "true"},
    )

    if upload_resp.status_code != 200:
        return None, {
            "code": "media_upload_failed",
            "message": "Failed to upload media to ComfyUI",
            "details": {"media_type": media_type, "status": upload_resp.status_code},
        }

    try:
        upload_json = upload_resp.json()
    except ValueError:
        return None, {
            "code": "media_upload_failed",
            "message": "ComfyUI returned invalid JSON after upload",
            "details": {"media_type": media_type, "status": upload_resp.status_code},
        }

    filename = upload_json.get("name") if isinstance(upload_json, dict) else None
    if not isinstance(filename, str) or filename.strip() == "":
        return None, {
            "code": "media_upload_failed",
            "message": "ComfyUI upload response missing filename",
            "details": {"media_type": media_type, "status": upload_resp.status_code},
        }

    return filename, None


async def _upload_video_bytes_to_comfy(
    client: httpx.AsyncClient,
    video_bytes: bytes,
    filename_value: str,
    content_type: str,
) -> tuple[str | None, dict[str, Any] | None]:
    """Upload raw video bytes to ComfyUI's /upload/image endpoint."""
    upload_resp = await client.post(
        "/upload/image",
        files={"image": (filename_value, video_bytes, content_type)},
        data={"overwrite": "true"},
    )

    if upload_resp.status_code != 200:
        return None, {
            "code": "media_upload_failed",
            "message": "Failed to upload video to ComfyUI",
            "details": {"media_type": "video", "status": upload_resp.status_code},
        }

    try:
        upload_json = upload_resp.json()
    except ValueError:
        return None, {
            "code": "media_upload_failed",
            "message": "ComfyUI returned invalid JSON after upload",
            "details": {"media_type": "video", "status": upload_resp.status_code},
        }

    filename = upload_json.get("name") if isinstance(upload_json, dict) else None
    if not isinstance(filename, str) or filename.strip() == "":
        return None, {
            "code": "media_upload_failed",
            "message": "ComfyUI upload response missing filename",
            "details": {"media_type": "video", "status": upload_resp.status_code},
        }

    return filename, None


def _build_postprocess_response(
    comfyui_response: httpx.Response,
    workflow_warnings: list[dict[str, Any]] | None = None,
    applied_widget_values: dict[str, str] | None = None,
    aspect_ratio_processing: dict[str, Any] | None = None,
    mask_crop_metadata: dict[str, Any] | None = None,
    processed_mask_bytes: bytes | None = None,
) -> GenerationResult:
    """Wraps the ComfyUI response, optionally enriching JSON payloads with metadata."""
    media_type = comfyui_response.headers.get("content-type", "application/json")
    if not workflow_warnings and not applied_widget_values and not aspect_ratio_processing and not mask_crop_metadata and not processed_mask_bytes:
        return GenerationResult(
            content=comfyui_response.content,
            status_code=comfyui_response.status_code,
            media_type=media_type,
        )

    if "application/json" not in media_type.lower():
        return GenerationResult(
            content=comfyui_response.content,
            status_code=comfyui_response.status_code,
            media_type=media_type,
        )

    try:
        payload = comfyui_response.json()
    except ValueError:
        return GenerationResult(
            content=comfyui_response.content,
            status_code=comfyui_response.status_code,
            media_type=media_type,
        )

    if isinstance(payload, dict):
        if workflow_warnings:
            payload["workflow_warnings"] = workflow_warnings
        if applied_widget_values:
            payload["applied_widget_values"] = applied_widget_values
        if aspect_ratio_processing:
            payload["aspect_ratio_processing"] = aspect_ratio_processing
        if mask_crop_metadata:
            payload["mask_crop_metadata"] = mask_crop_metadata
        if processed_mask_bytes:
            payload["processed_mask_video"] = base64.b64encode(processed_mask_bytes).decode("ascii")

    return GenerationResult(
        content=json.dumps(payload).encode(),
        status_code=comfyui_response.status_code,
        media_type="application/json",
    )


async def execute_generation(
    gen_input: GenerationInput,
    client: httpx.AsyncClient,
) -> GenerationResult:
    """Run the backend processor pipeline and wrap the ComfyUI response."""
    ctx = BackendPipelineContext(
        client=client,
        client_id=gen_input.client_id,
        workflow=gen_input.workflow,
        workflow_id=gen_input.workflow_id,
        target_aspect_ratio=gen_input.target_aspect_ratio,
        target_resolution=gen_input.target_resolution_raw,
        mask_crop_dilation=gen_input.mask_crop_dilation,
        mask_crop_mode=gen_input.mask_crop_mode,
        injections=gen_input.injections,
        manual_slot_values=gen_input.manual_slot_values,
        widget_overrides=gen_input.widget_overrides,
        widget_modes=gen_input.widget_modes,
        buffered_videos=gen_input.buffered_videos,
        graph_data=gen_input.graph_data,
        warnings=gen_input.workflow_warnings,
    )
    processors = build_generation_processors(
        workflows_dir=WORKFLOWS_DIR,
        input_node_map=INPUT_NODE_MAP,
        analyze_mask_video_bounds_fn=analyze_mask_video_bounds,
        crop_video_fn=crop_video,
        get_video_dimensions_fn=get_video_dimensions,
        upload_video_bytes_fn=_upload_video_bytes_to_comfy,
        apply_aspect_ratio_processing_fn=apply_aspect_ratio_processing,
        prompt_id_factory=lambda: str(uuid.uuid4()),
    )
    await run_processors(processors, ctx)

    if ctx.comfyui_response is None:
        raise RuntimeError("Backend generation pipeline did not submit a prompt")

    return _build_postprocess_response(
        ctx.comfyui_response,
        workflow_warnings=ctx.warnings or None,
        applied_widget_values=ctx.applied_widget_values or None,
        aspect_ratio_processing=ctx.aspect_ratio_metadata,
        mask_crop_metadata=ctx.mask_crop_metadata,
        processed_mask_bytes=ctx.processed_mask_bytes,
    )
