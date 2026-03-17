import json
import logging
import uuid
from pathlib import Path
from typing import Any, cast

import httpx
from fastapi import APIRouter, Request, Response, UploadFile, WebSocket
from fastapi.responses import JSONResponse
from services.comfyui import comfyui_generate as comfyui_generate_service
from services.gen_pipeline.processors.utils.video_crop import analyze_mask_video_bounds, crop_video, get_video_dimensions

logger = logging.getLogger(__name__)

from api_errors import error_response
from services.comfyui.comfyui_client import close_http_client, get_http_client, set_comfyui_url, get_comfyui_url
from services.comfyui.comfyui_client import get_comfyui_url_error
from services.comfyui.comfyui_generate import (
    INPUT_NODE_MAP,
    WIDGET_CONTROL_MODES,
    GenerationInput,
    _upload_video_bytes_to_comfy,
    execute_generation,
    parse_widget_form_key,
    upload_form_media_to_comfy,
)
from services.comfyui.comfyui_proxy import (
    PROXY_HTTP_METHODS,
    compose_upstream_path,
    proxy_http_request,
    proxy_websocket,
    upstream_path_from_raw_request,
)
from services.workflow_rules import (
    enrich_rules_with_object_info,
    load_rules_for_workflow,
)
from services.workflow_rules.object_info import OBJECT_INFO_PATH, set_object_info_cache

from routers.comfyui_compat import compat_router  # noqa: F401 -- re-exported for main.py

WORKFLOWS_DIR = Path(__file__).parent.parent / "assets" / "workflows"
DEFAULT_WORKFLOWS_DIR = Path(__file__).parent.parent / "assets" / ".config" / "default_workflows"

router = APIRouter(prefix="/comfy", tags=["comfyui"])


# ---------------------------------------------------------------------------
# Health / Config
# ---------------------------------------------------------------------------

@router.get("/health")
async def comfyui_health():
    config_error = get_comfyui_url_error()
    if config_error:
        return JSONResponse(
            status_code=200,
            content={
                "status": "invalid_config",
                "url": get_comfyui_url(),
                "error": {
                    "code": "invalid_comfyui_url",
                    "message": config_error,
                },
            },
        )
    try:
        client = await get_http_client()
        resp = await client.get("/system_stats", timeout=httpx.Timeout(5.0, connect=2.0))
        return {
            "status": "connected",
            "url": get_comfyui_url(),
            "error": None,
            "comfyui": resp.json(),
        }
    except (httpx.RequestError, ValueError) as exc:
        return JSONResponse(
            status_code=200,
            content={
                "status": "disconnected",
                "url": get_comfyui_url(),
                "error": {
                    "code": "comfyui_unreachable",
                    "message": str(exc),
                },
            },
        )


@router.get("/config")
async def comfyui_config():
    return {"comfyui_url": get_comfyui_url()}


@router.post("/config")
async def update_comfyui_config(request: Request):
    body = await request.json()
    new_url = body.get("comfyui_url", "")
    try:
        url = await set_comfyui_url(new_url)
    except ValueError as e:
        return error_response(
            400,
            "invalid_comfyui_url",
            str(e),
            retryable=False,
        )
    return {"comfyui_url": url}


# ---------------------------------------------------------------------------
# Prompt submission (dedicated route for clarity)
# ---------------------------------------------------------------------------

@router.post("/prompt")
async def submit_prompt(request: Request):
    body = await request.json()
    body.setdefault("client_id", str(uuid.uuid4()))
    body.setdefault("prompt_id", str(uuid.uuid4()))

    try:
        client = await get_http_client()
        resp = await client.post("/prompt", json=body)
    except (httpx.RequestError, ValueError) as exc:
        return error_response(
            503,
            "comfyui_unreachable",
            "Prompt submission failed because ComfyUI is unavailable",
            retryable=True,
            details={"reason": str(exc)},
        )

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/json"),
    )



# ---------------------------------------------------------------------------
# Object Info Sync
# ---------------------------------------------------------------------------

@router.post("/object_info/sync")
async def sync_object_info():
    """Fetches object_info from ComfyUI and persists it to backend assets."""
    try:
        client = await get_http_client()
        resp = await client.get("/object_info")
        if resp.status_code != 200:
            return error_response(
                resp.status_code,
                "comfyui_object_info_failed",
                "Failed to fetch object_info from ComfyUI",
                details={"raw": resp.text}
            )
        
        data = resp.json()
        if not isinstance(data, dict):
            return error_response(
                500,
                "comfyui_object_info_invalid",
                "ComfyUI returned non-object object_info"
            )

        # Persist to disk
        OBJECT_INFO_PATH.parent.mkdir(parents=True, exist_ok=True)
        OBJECT_INFO_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
        set_object_info_cache(data)

        return {"synced": True, "node_classes": len(data)}
    except (httpx.RequestError, ValueError) as exc:
        return error_response(
            503,
            "comfyui_unreachable",
            "Failed to sync object_info because ComfyUI is unavailable",
            retryable=True,
            details={"reason": str(exc)},
        )


# ---------------------------------------------------------------------------
# Workflow parsing
# ---------------------------------------------------------------------------

def _is_safe_workflow_filename(filename: str) -> bool:
    return not (".." in filename or "/" in filename or "\\" in filename)


def _resolve_workflow_path(filename: str) -> Path | None:
    """Return the path to the workflow, checking main dir first then defaults."""
    main = WORKFLOWS_DIR / filename
    if main.exists():
        return main
    default = DEFAULT_WORKFLOWS_DIR / filename
    if default.exists():
        return default
    return None


def _parse_workflow_inputs(workflow: dict) -> list[dict]:
    """Parse a workflow and return discoverable input nodes."""
    inputs = []
    for node_id, node_data in workflow.items():
        if not isinstance(node_data, dict):
            continue
        class_type = node_data.get("class_type", "")
        mapping = INPUT_NODE_MAP.get(class_type)
        if not mapping:
            continue
        node_inputs = node_data.get("inputs", {})
        meta = node_data.get("_meta", {})
        inputs.append({
            "nodeId": node_id,
            "classType": class_type,
            "inputType": mapping["input_type"],
            "param": mapping["param"],
            "label": meta.get("title", class_type),
            "currentValue": node_inputs.get(mapping["param"]),
        })
    return inputs


@router.get("/workflow/inputs")
async def get_workflow_inputs():
    """Returns discoverable inputs from the stored workflow template (fallback)."""
    workflow_path = WORKFLOWS_DIR / "test_workflow_API.json"
    workflow = json.loads(workflow_path.read_text())
    return {"inputs": _parse_workflow_inputs(workflow)}


@router.get("/workflow/graph")
async def get_workflow_graph():
    """Returns the visual-format workflow for loading into the ComfyUI editor."""
    workflow_path = WORKFLOWS_DIR / "test_workflow_notAPI.json"
    workflow = json.loads(workflow_path.read_text())
    return workflow


# ---------------------------------------------------------------------------
# Workflow Management
# ---------------------------------------------------------------------------

@router.get("/workflow/list")
async def list_workflows():
    """Returns a list of available workflows from main and default directories.

    Workflows in the main directory shadow identically-named defaults.
    """
    try:
        seen: set[str] = set()
        workflows = []

        # Main dir first – these take precedence.
        if WORKFLOWS_DIR.exists():
            for path in WORKFLOWS_DIR.glob("*.json"):
                if path.name.endswith(".rules.json"):
                    continue
                seen.add(path.name)
                name = path.stem
                rules, _ = load_rules_for_workflow(
                    WORKFLOWS_DIR, path.name,
                    fallback_dirs=[DEFAULT_WORKFLOWS_DIR],
                )
                if rules.get("name"):
                    name = rules["name"]
                workflows.append({"id": path.name, "name": name})

        # Default dir – only add workflows not already seen.
        if DEFAULT_WORKFLOWS_DIR.exists():
            for path in DEFAULT_WORKFLOWS_DIR.glob("*.json"):
                if path.name.endswith(".rules.json"):
                    continue
                if path.name in seen:
                    continue
                name = path.stem
                rules, _ = load_rules_for_workflow(DEFAULT_WORKFLOWS_DIR, path.name)
                if rules.get("name"):
                    name = rules["name"]
                workflows.append({"id": path.name, "name": name})

        workflows.sort(key=lambda x: x["name"])
        return workflows
    except OSError as exc:
        return error_response(
            500,
            "workflow_list_failed",
            "Failed to list available workflows",
            retryable=True,
            details={"reason": str(exc)},
        )


@router.get("/workflow/content/{filename}")
async def get_workflow_content(filename: str):
    """Returns the raw JSON content of a workflow file.

    Checks the main workflows directory first, then falls back to defaults.
    """
    if not _is_safe_workflow_filename(filename):
        return error_response(
            400,
            "invalid_workflow_filename",
            "Invalid workflow filename",
            retryable=False,
        )

    path = _resolve_workflow_path(filename)
    if path is None:
        return error_response(
            404,
            "workflow_not_found",
            "Workflow not found",
            retryable=False,
        )

    try:
        return json.loads(path.read_text())
    except OSError as exc:
        return error_response(
            500,
            "workflow_read_failed",
            "Failed to read workflow content",
            retryable=True,
            details={"reason": str(exc)},
        )


@router.put("/workflow/content/{filename}")
async def save_workflow_content(filename: str, request: Request):
    """Persists workflow JSON into backend/assets/workflows."""
    if not _is_safe_workflow_filename(filename):
        return error_response(
            400,
            "invalid_workflow_filename",
            "Invalid workflow filename",
            retryable=False,
        )

    payload = await request.json()
    if not isinstance(payload, dict):
        return error_response(
            400,
            "invalid_workflow_payload",
            "Workflow JSON must be an object",
            retryable=False,
        )

    workflow_payload = payload.get("workflow") if isinstance(payload.get("workflow"), dict) else payload
    object_info_payload = payload.get("object_info")

    if not isinstance(workflow_payload, dict):
        return error_response(
            400,
            "invalid_workflow_payload",
            "Workflow JSON must be an object",
            retryable=False,
        )

    try:
        WORKFLOWS_DIR.mkdir(parents=True, exist_ok=True)
        path = WORKFLOWS_DIR / filename
        path.write_text(json.dumps(workflow_payload, indent=2), encoding="utf-8")

        object_info_saved = False
        if object_info_payload is not None:
            if not isinstance(object_info_payload, dict):
                return error_response(
                    400,
                    "invalid_object_info_payload",
                    "object_info JSON must be an object",
                    retryable=False,
                )
            OBJECT_INFO_PATH.parent.mkdir(parents=True, exist_ok=True)
            OBJECT_INFO_PATH.write_text(
                json.dumps(object_info_payload, indent=2),
                encoding="utf-8",
            )
            set_object_info_cache(object_info_payload)
            object_info_saved = True

        return {
            "workflow_id": filename,
            "saved": True,
            "object_info_saved": object_info_saved,
        }
    except OSError as exc:
        return error_response(
            500,
            "workflow_save_failed",
            "Failed to persist workflow content",
            retryable=True,
            details={"reason": str(exc)},
        )


@router.get("/workflow/rules/{filename}")
async def get_workflow_rules(filename: str):
    """Returns normalized manual I/O rules for a workflow."""
    if not _is_safe_workflow_filename(filename):
        return error_response(
            400,
            "invalid_workflow_filename",
            "Invalid workflow filename",
            retryable=False,
        )

    workflow_path = _resolve_workflow_path(filename)
    if workflow_path is None:
        return error_response(
            404,
            "workflow_not_found",
            "Workflow not found",
            retryable=False,
        )

    try:
        rules, warnings = load_rules_for_workflow(
            WORKFLOWS_DIR, filename,
            fallback_dirs=[DEFAULT_WORKFLOWS_DIR],
        )

        # Enrich with auto-discovered widgets from object_info
        try:
            workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
            if isinstance(workflow, dict):
                enrich_rules_with_object_info(rules, workflow)
            else:
                logger.warning("[rules/%s] workflow is not a dict: %s", filename, type(workflow).__name__)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("[rules/%s] Failed to read workflow for enrichment: %s", filename, exc)

        nodes_with_widgets = {
            nid: list(nr.get("widgets", {}).keys())
            for nid, nr in rules.get("nodes", {}).items()
            if isinstance(nr, dict) and nr.get("widgets")
        }
        logger.info("[rules/%s] Returning rules with %d widget nodes: %s", filename, len(nodes_with_widgets), nodes_with_widgets)

        return {
            "workflow_id": filename,
            "rules": rules,
            "warnings": warnings,
        }
    except OSError as exc:
        return error_response(
            500,
            "workflow_rules_failed",
            "Failed to load workflow rules",
            retryable=True,
            details={"reason": str(exc)},
        )


@router.post("/generate")
async def generate(request: Request):
    try:
        client = await get_http_client()
        form = await request.form()
    except ValueError as exc:
        return error_response(
            400,
            "invalid_comfyui_url",
            str(exc),
            retryable=False,
        )

    client_id_raw = form.get("client_id")
    client_id = client_id_raw if isinstance(client_id_raw, str) else str(uuid.uuid4())
    workflow_id_raw = form.get("workflow_id")
    workflow_id = workflow_id_raw if isinstance(workflow_id_raw, str) else None
    target_aspect_ratio_raw = form.get("target_aspect_ratio")
    target_aspect_ratio = (
        target_aspect_ratio_raw if isinstance(target_aspect_ratio_raw, str) else None
    )
    target_resolution_raw = form.get("target_resolution")

    # --- Load workflow (Expect frontend to provide it) ---
    workflow_json = form.get("workflow")
    if not workflow_json or not isinstance(workflow_json, str):
        return error_response(
            400,
            "invalid_workflow_payload",
            "Missing or invalid 'workflow' JSON",
            retryable=False,
        )

    try:
        workflow = json.loads(workflow_json)
    except json.JSONDecodeError:
        return error_response(
            400,
            "invalid_workflow_payload",
            "Workflow payload must be valid JSON",
            retryable=False,
        )

    # --- Optional visual graph data (for embedding in output file metadata) ---
    graph_data: dict | None = None
    graph_data_json = form.get("graph_data")
    if isinstance(graph_data_json, str) and graph_data_json.strip():
        try:
            graph_data = json.loads(graph_data_json)
        except json.JSONDecodeError:
            pass

    # --- Collect injections from form fields ---
    injections: dict[str, dict] = {}
    manual_slot_values: dict[str, Any] = {}
    workflow_warnings: list[dict[str, Any]] = []

    # --- Collect widget overrides from form fields ---
    widget_overrides: dict[str, dict[str, Any]] = {}
    widget_modes: dict[str, dict[str, str]] = {}

    # Video uploads are buffered so mask-crop preprocessing can run before
    # forwarding to ComfyUI.
    buffered_videos: dict[str, dict[str, Any]] = {}

    mask_crop_dilation_raw = form.get("mask_crop_dilation")
    mask_crop_dilation: float | None = None
    if isinstance(mask_crop_dilation_raw, str) and mask_crop_dilation_raw.strip():
        try:
            mask_crop_dilation = float(mask_crop_dilation_raw)
        except ValueError:
            pass

    mask_crop_mode_raw = form.get("mask_crop_mode")
    mask_crop_mode: str | None = None
    if isinstance(mask_crop_mode_raw, str):
        normalized_mask_crop_mode = mask_crop_mode_raw.strip().lower()
        if normalized_mask_crop_mode in {"crop", "full"}:
            mask_crop_mode = normalized_mask_crop_mode

    for key, value in form.multi_items():
        if key.startswith("slot_text_"):
            slot_id = key[len("slot_text_"):]
            if isinstance(value, str):
                manual_slot_values[slot_id] = value
            else:
                manual_slot_values[slot_id] = str(value)
            continue

        if key.startswith("slot_image_"):
            slot_id = key[len("slot_image_"):]
            filename, upload_warning = await upload_form_media_to_comfy(
                client,
                value,
                "image",
            )
            if upload_warning:
                upload_warning["details"] = {
                    **(upload_warning.get("details") or {}),
                    "slot_id": slot_id,
                }
                workflow_warnings.append(upload_warning)
                continue
            if filename:
                manual_slot_values[slot_id] = filename
            continue

        if key.startswith("slot_video_"):
            slot_id = key[len("slot_video_"):]
            filename, upload_warning = await upload_form_media_to_comfy(
                client,
                value,
                "video",
            )
            if upload_warning:
                upload_warning["details"] = {
                    **(upload_warning.get("details") or {}),
                    "slot_id": slot_id,
                }
                workflow_warnings.append(upload_warning)
                continue
            if filename:
                manual_slot_values[slot_id] = filename
            continue

        if key.startswith("slot_audio_"):
            slot_id = key[len("slot_audio_"):]
            filename, upload_warning = await upload_form_media_to_comfy(
                client,
                value,
                "audio",
            )
            if upload_warning:
                upload_warning["details"] = {
                    **(upload_warning.get("details") or {}),
                    "slot_id": slot_id,
                }
                workflow_warnings.append(upload_warning)
                continue
            if filename:
                manual_slot_values[slot_id] = filename
            continue

        # widget_mode_<nodeId>_<param> -> fixed|randomize
        if key.startswith("widget_mode_"):
            parsed = parse_widget_form_key(key[len("widget_mode_"):])
            if parsed and isinstance(value, str):
                node_id, param = parsed
                mode = value.strip().lower()
                if mode in WIDGET_CONTROL_MODES:
                    widget_modes.setdefault(node_id, {})[param] = mode
            continue

        # widget_<nodeId>_<param> -> inject widget value into node inputs
        if key.startswith("widget_"):
            parsed = parse_widget_form_key(key[len("widget_"):])
            if parsed:
                node_id, param = parsed
                if isinstance(value, str):
                    # Auto-parse numeric values
                    parsed_value: Any = value
                    try:
                        if "." in value:
                            parsed_value = float(value)
                        else:
                            parsed_value = int(value)
                    except ValueError:
                        pass
                    widget_overrides.setdefault(node_id, {})[param] = parsed_value
            continue

        # text_<nodeId> -> inject text value
        if key.startswith("text_"):
            node_id = key[5:]
            node = workflow.get(node_id)
            if node and isinstance(node, dict):
                mapping = INPUT_NODE_MAP.get(node.get("class_type", ""))
                if mapping:
                    injections[node_id] = {"param": mapping["param"], "value": value}

        # image_<nodeId> -> upload to ComfyUI immediately
        elif key.startswith("image_"):
            node_id = key[6:]
            upload_file = value
            filename, upload_warning = await upload_form_media_to_comfy(
                client,
                upload_file,
                "image",
            )
            if upload_warning:
                upload_warning["node_id"] = node_id
                workflow_warnings.append(upload_warning)
                continue
            if not filename:
                continue

            node = workflow.get(node_id)
            if node and isinstance(node, dict):
                mapping = INPUT_NODE_MAP.get(node.get("class_type", ""))
                if mapping and mapping.get("input_type") == "image":
                    injections[node_id] = {"param": mapping["param"], "value": filename}
                elif mapping:
                    workflow_warnings.append(
                        {
                            "code": "media_mapping_mismatch",
                            "message": "Media input type does not match node mapping; default node value kept",
                            "node_id": node_id,
                            "details": {
                                "expected": mapping.get("input_type"),
                                "received": "image",
                            },
                        }
                    )

        # video_<nodeId> -> buffer for potential mask crop before uploading
        elif key.startswith("video_"):
            node_id = key[6:]
            upload_file = value
            if not hasattr(upload_file, "read"):
                workflow_warnings.append({
                    "code": "invalid_upload_field",
                    "message": "Upload field is not a file-like object",
                    "node_id": node_id,
                    "details": {"media_type": "video"},
                })
                continue
            file_obj = cast(UploadFile, upload_file)
            video_bytes = await file_obj.read()
            content_type = getattr(file_obj, "content_type", None) or "video/mp4"
            filename_value = getattr(file_obj, "filename", "upload.video")
            buffered_videos[node_id] = {
                "bytes": video_bytes,
                "content_type": content_type,
                "filename": filename_value,
            }

    # --- Delegate to generation service ---
    gen_input = GenerationInput(
        client_id=client_id,
        workflow=workflow,
        workflow_id=workflow_id,
        target_aspect_ratio=target_aspect_ratio,
        target_resolution_raw=target_resolution_raw,
        mask_crop_dilation=mask_crop_dilation,
        mask_crop_mode=mask_crop_mode,
        injections=injections,
        manual_slot_values=manual_slot_values,
        widget_overrides=widget_overrides,
        widget_modes=widget_modes,
        buffered_videos=buffered_videos,
        graph_data=graph_data,
        workflow_warnings=workflow_warnings,
    )

    comfyui_generate_service.WORKFLOWS_DIR = WORKFLOWS_DIR
    comfyui_generate_service.DEFAULT_WORKFLOWS_DIR = DEFAULT_WORKFLOWS_DIR
    comfyui_generate_service.analyze_mask_video_bounds = analyze_mask_video_bounds
    comfyui_generate_service.crop_video = crop_video
    comfyui_generate_service.get_video_dimensions = get_video_dimensions
    comfyui_generate_service._upload_video_bytes_to_comfy = _upload_video_bytes_to_comfy
    try:
        result = await execute_generation(gen_input, client)
    except httpx.RequestError as exc:
        return error_response(
            503,
            "comfyui_unreachable",
            "Generation failed because ComfyUI is unavailable",
            retryable=True,
            details={"reason": str(exc)},
        )
    except ValueError as exc:
        return error_response(
            400,
            "invalid_generation_request",
            str(exc),
            retryable=False,
        )
    except RuntimeError as exc:
        return error_response(
            500,
            "generation_failed",
            str(exc),
            retryable=True,
        )

    return Response(
        content=result.content,
        status_code=result.status_code,
        media_type=result.media_type,
    )


# ---------------------------------------------------------------------------
# /comfy passthrough routes
# ---------------------------------------------------------------------------

@router.api_route("/api", methods=PROXY_HTTP_METHODS)
@router.api_route("/api/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_comfyui_api(request: Request, path: str = ""):
    # Use the raw request path to preserve encoded slashes in file names.
    upstream_path = upstream_path_from_raw_request(request, "/comfy/api")
    return await proxy_http_request(request, upstream_path)


@router.api_route("/history", methods=PROXY_HTTP_METHODS)
@router.api_route("/history/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_comfyui_history(request: Request, path: str = ""):
    return await proxy_http_request(request, compose_upstream_path("history", path))


@router.websocket("/ws")
async def websocket_proxy(ws: WebSocket):
    await proxy_websocket(ws, "/ws")


@router.websocket("/api/ws")
async def websocket_proxy_api_alias(ws: WebSocket):
    await proxy_websocket(ws, "/ws")
