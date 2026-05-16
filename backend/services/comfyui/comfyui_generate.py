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
from services.gen_pipeline.processors import (
    build_backend_dispatch_processors,
    build_backend_preprocessors,
)
from services.gen_pipeline.processors.utils.video_crop import analyze_mask_video_bounds, crop_video, get_video_dimensions
from services.workflow_rules.class_types import get_class_type_aliases
from services.workflow_rules.object_info import build_input_node_map
from services.workflow_rules.input_labels import default_input_label

logger = logging.getLogger(__name__)

WORKFLOWS_DIR = Path(__file__).parent.parent / "assets" / "workflows"
DEFAULT_WORKFLOWS_DIR = Path(__file__).parent.parent / "assets" / ".config" / "default_workflows"

# Maps ComfyUI class_type -> discoverable input type
INPUT_NODE_MAP = {
    "LoadImage": {"input_type": "image", "param": "image"},
    "vloMemoryLoadImage": {"input_type": "image", "param": "image"},
    "CLIPTextEncode": {"input_type": "text", "param": "text"},
    "LoadAudio": {"input_type": "audio", "param": "audio"},
    "vloMemoryLoadAudio": {"input_type": "audio", "param": "audio"},
    "LoadVideo": {"input_type": "video", "param": "file"},
    "vloMemoryLoadVideo": {"input_type": "video", "param": "file"},
    "VHS_LoadVideo": {"input_type": "video", "param": "video"},
    "VHS_LoadVideoFFmpeg": {"input_type": "video", "param": "video"},
}

WIDGET_CONTROL_MODES = {"fixed", "randomize"}


@dataclass
class GenerationInput:
    client_id: str
    workflow: dict
    prompt_id: str | None = None
    workflow_id: str | None = None
    rules: dict[str, Any] | None = None
    rules_override_provided: bool = False
    pipeline_inputs: dict[str, dict[str, Any]] = field(default_factory=dict)
    input_metadata: dict[str, Any] = field(default_factory=dict)
    injections: dict[str, dict[str, Any]] = field(default_factory=dict)
    widget_overrides: dict[str, dict[str, Any]] = field(default_factory=dict)
    derived_widget_values: dict[str, Any] = field(default_factory=dict)
    widget_modes: dict[str, dict[str, str]] = field(default_factory=dict)
    buffered_media: dict[str, dict[str, Any]] = field(default_factory=dict)
    graph_data: dict[str, Any] | None = None
    workflow_warnings: list[dict[str, Any]] = field(default_factory=list)
    prompt_is_pre_resolved: bool = False


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
    media_bytes: bytes,
    filename_value: str,
    content_type: str,
) -> tuple[str | None, dict[str, Any] | None]:
    """Upload raw media bytes to ComfyUI's shared /upload/image endpoint."""
    upload_resp = await client.post(
        "/upload/image",
        files={"image": (filename_value, media_bytes, content_type)},
        data={"overwrite": "true"},
    )

    media_type = content_type.split("/", 1)[0] if "/" in content_type else "media"
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


async def _register_media_bytes_in_comfy_memory(
    client: httpx.AsyncClient,
    media_bytes: bytes,
    filename_value: str,
    content_type: str,
    media_type: str,
    client_id: str | None = None,
) -> tuple[str | None, dict[str, Any] | None]:
    request_data: dict[str, str] = {
        "kind": media_type,
        "filename": filename_value,
        "content_type": content_type,
    }
    if isinstance(client_id, str) and client_id.strip():
        request_data["client_id"] = client_id

    register_resp = await client.post(
        "/api/vlo-memory/register",
        files={"media": (filename_value, media_bytes, content_type)},
        data=request_data,
    )

    if register_resp.status_code != 200:
        return None, {
            "code": "media_register_failed",
            "message": "Failed to register media with ComfyUI memory loader",
            "details": {"media_type": media_type, "status": register_resp.status_code},
        }

    try:
        register_json = register_resp.json()
    except ValueError:
        return None, {
            "code": "media_register_failed",
            "message": "ComfyUI returned invalid JSON after memory registration",
            "details": {"media_type": media_type, "status": register_resp.status_code},
        }

    media_id = register_json.get("media_id") if isinstance(register_json, dict) else None
    if not isinstance(media_id, str) or media_id.strip() == "":
        return None, {
            "code": "media_register_failed",
            "message": "ComfyUI memory registration response missing media_id",
            "details": {"media_type": media_type, "status": register_resp.status_code},
        }

    return media_id, None


def _build_postprocess_response(
    comfyui_response: httpx.Response,
    workflow_warnings: list[dict[str, Any]] | None = None,
    applied_widget_values: dict[str, str] | None = None,
    pipeline_outputs: dict[str, dict[str, Any]] | None = None,
    comfyui_prompt: dict[str, Any] | None = None,
    comfyui_workflow: dict[str, Any] | None = None,
) -> GenerationResult:
    """Wraps the ComfyUI response, optionally enriching JSON payloads with metadata."""
    media_type = comfyui_response.headers.get("content-type", "application/json")
    if not workflow_warnings and not applied_widget_values and not pipeline_outputs and not comfyui_prompt and not comfyui_workflow:
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
        if pipeline_outputs:
            serialized_outputs = {
                stage_id: dict(values)
                for stage_id, values in pipeline_outputs.items()
            }
            for values in serialized_outputs.values():
                processed_mask_bytes = values.get("processed_mask_bytes")
                if isinstance(processed_mask_bytes, bytes):
                    values["processed_mask_video"] = base64.b64encode(
                        processed_mask_bytes
                    ).decode("ascii")
                    values.pop("processed_mask_bytes", None)
            payload["pipeline_outputs"] = serialized_outputs
        if comfyui_prompt:
            payload["comfyui_prompt"] = comfyui_prompt
        if comfyui_workflow:
            payload["comfyui_workflow"] = comfyui_workflow

    return GenerationResult(
        content=json.dumps(payload).encode(),
        status_code=comfyui_response.status_code,
        media_type="application/json",
    )


def build_backend_context(
    gen_input: GenerationInput,
    client: httpx.AsyncClient,
) -> BackendPipelineContext:
    """Create the shared backend pipeline context from the request payload."""
    return BackendPipelineContext(
        client=client,
        client_id=gen_input.client_id,
        prompt_id=gen_input.prompt_id,
        workflow=gen_input.workflow,
        workflow_id=gen_input.workflow_id,
        rules=gen_input.rules,
        rules_override_provided=gen_input.rules_override_provided,
        pipeline_inputs=gen_input.pipeline_inputs,
        input_metadata=gen_input.input_metadata,
        injections=gen_input.injections,
        widget_overrides=gen_input.widget_overrides,
        derived_widget_values=gen_input.derived_widget_values,
        widget_modes=gen_input.widget_modes,
        buffered_media=gen_input.buffered_media,
        graph_data=gen_input.graph_data,
        warnings=gen_input.workflow_warnings,
    )


async def run_backend_preprocess(ctx: BackendPipelineContext) -> None:
    """Backend preprocess phase.

    This phase validates request inputs and prepares/uploads media so the
    dispatch step can submit the frontend pre-resolved ComfyUI prompt.
    """
    # Build dynamic input node map from object_info, with static fallbacks.
    dynamic_map = build_input_node_map()
    for class_type, mapping in INPUT_NODE_MAP.items():
        aliases = get_class_type_aliases(class_type) or (class_type,)
        existing: dict[str, dict[str, Any]] = {}
        for alias in aliases:
            for entry in dynamic_map.get(alias, []):
                existing[entry["param"]] = dict(entry)
        existing[mapping["param"]] = {
            "input_type": mapping["input_type"],
            "param": mapping["param"],
            "label": default_input_label(mapping["input_type"]),
            "description": None,
        }
        for alias in aliases:
            dynamic_map[alias] = list(existing.values())

    preprocessors = build_backend_preprocessors(
        workflows_dir=WORKFLOWS_DIR,
        fallback_workflow_dirs=[DEFAULT_WORKFLOWS_DIR],
        input_node_map=dynamic_map,
        analyze_mask_video_bounds_fn=analyze_mask_video_bounds,
        crop_video_fn=crop_video,
        get_video_dimensions_fn=get_video_dimensions,
        upload_video_bytes_fn=_upload_video_bytes_to_comfy,
        register_media_bytes_fn=_register_media_bytes_in_comfy_memory,
        apply_aspect_ratio_processing_fn=apply_aspect_ratio_processing,
    )
    await run_processors(preprocessors, ctx)


async def dispatch_to_comfyui(ctx: BackendPipelineContext) -> None:
    """Backend dispatch phase.

    Dispatch is kept separate from preprocessing so the end-to-end flow is
    explicitly: backend preprocess -> dispatch -> backend postprocess.
    """
    dispatch_processors = build_backend_dispatch_processors(
        prompt_id_factory=lambda: str(uuid.uuid4()),
    )
    await run_processors(dispatch_processors, ctx)


def finalize_backend_response(ctx: BackendPipelineContext) -> GenerationResult:
    """Backend postprocess phase.

    This is intentionally a thin response-enrichment step today. It exists as a
    named phase so future backend response shaping can grow here without being
    hidden as inline glue around the dispatch call.
    """
    if ctx.comfyui_response is None:
        raise RuntimeError("Backend generation pipeline did not submit a prompt")

    return _build_postprocess_response(
        ctx.comfyui_response,
        workflow_warnings=ctx.warnings or None,
        applied_widget_values=ctx.applied_widget_values or None,
        pipeline_outputs=ctx.pipeline_outputs or None,
        comfyui_prompt=ctx.workflow or None,
        comfyui_workflow=ctx.graph_data,
    )


run_backend_postprocess = finalize_backend_response


async def execute_generation(
    gen_input: GenerationInput,
    client: httpx.AsyncClient,
) -> GenerationResult:
    """Run the canonical backend phases for generation.

    Phase order:
    1. backend preprocess
    2. dispatch to ComfyUI
    3. backend postprocess
    """
    ctx = build_backend_context(gen_input, client)
    await run_backend_preprocess(ctx)

    # Optional prompt logging for manual equivalence testing.
    from services.gen_pipeline.processors.utils.prompt_logging import maybe_log_prompt

    maybe_log_prompt(ctx.workflow, label="pre_resolved")

    await dispatch_to_comfyui(ctx)
    return finalize_backend_response(ctx)
