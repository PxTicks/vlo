import json
import logging
import uuid
import base64
from pathlib import Path
from typing import Any, cast

import httpx
from fastapi import APIRouter, File, Request, Response, UploadFile, WebSocket
from fastapi.responses import JSONResponse
from services.comfyui import comfyui_generate as comfyui_generate_service
from services.gen_pipeline.processors.utils.video_crop import (
    analyze_mask_video_bounds,
    crop_video,
    get_video_dimensions,
)

logger = logging.getLogger(__name__)

from api_errors import error_response
from services.comfyui.comfyui_client import (
    close_http_client,
    get_http_client,
    get_comfyui_url,
    set_comfyui_url,
)
from services.comfyui.comfyui_client import get_comfyui_url_error
from services.comfyui.comfyui_generate import (
    INPUT_NODE_MAP,
    WIDGET_CONTROL_MODES,
    GenerationInput,
    _upload_video_bytes_to_comfy,
    execute_generation,
    parse_widget_form_key,
)
from services.comfyui.comfyui_proxy import (
    PROXY_HTTP_METHODS,
    compose_upstream_path,
    proxy_http_request,
    proxy_websocket,
    upstream_path_from_raw_request,
)
from services.workflow_rules import (
    WorkflowValidationError,
    enrich_rules_with_object_info,
    load_rules_model_for_workflow,
    matches_input_presence_condition,
    normalize_rules_model,
    sidecar_path_for_workflow,
)
from services.workflow_rules.schema import dump_resolved_rules, dump_warning_models
from services.workflow_rules.object_info import (
    OBJECT_INFO_PATH,
    build_input_node_map,
    set_object_info_cache,
)
from services.workflow_rules.input_labels import default_input_label
from services.gen_pipeline.processors.validate_inputs import (
    collect_provided_input_ids_from_sources,
)

from routers.comfyui_compat import compat_router  # noqa: F401 -- re-exported for main.py
from services.generation_delivery import generation_holding_service

WORKFLOWS_DIR = Path(__file__).parent.parent / "assets" / "workflows"
DEFAULT_WORKFLOWS_DIR = Path(__file__).parent.parent / "assets" / ".config" / "default_workflows"
DUMMY_PHOTO_PATH = DEFAULT_WORKFLOWS_DIR.parent / "dummy_photo.jpeg"
WORKFLOW_MENU_CONFIG_PATH = (
    Path(__file__).parent.parent / "assets" / ".config" / "workflow_menu.json"
)
CUSTOM_WORKFLOW_MENU_PATH = (
    Path(__file__).parent.parent / "assets" / "workflows" / "workflow_menu.json"
)
WORKFLOW_MEDIA_FALLBACK_SPECS: dict[str, dict[str, Any]] = {
    "dummy:image": {
        "path": DUMMY_PHOTO_PATH,
        "filename": "dummy_photo.jpeg",
        "content_type": "image/jpeg",
    }
}

router = APIRouter(prefix="/comfy", tags=["comfyui"])


def _extract_stage_output_value(
    pipeline_outputs: Any,
    key: str,
) -> Any | None:
    if not isinstance(pipeline_outputs, dict):
        return None

    for stage_outputs in pipeline_outputs.values():
        if not isinstance(stage_outputs, dict):
            continue
        if key in stage_outputs:
            return stage_outputs[key]
    return None


def _enrich_generation_metadata(
    base_metadata: Any,
    response_payload: dict[str, Any],
    workflow_graph_data: dict[str, Any] | None,
) -> dict[str, Any]:
    metadata = dict(base_metadata) if isinstance(base_metadata, dict) else {}
    pipeline_outputs = response_payload.get("pipeline_outputs")

    mask_crop_metadata = _extract_stage_output_value(
        pipeline_outputs,
        "mask_crop_metadata",
    )
    if isinstance(mask_crop_metadata, dict):
        metadata["maskCropMetadata"] = mask_crop_metadata

    comfyui_prompt = response_payload.get("comfyui_prompt")
    if isinstance(comfyui_prompt, dict):
        metadata["comfyuiPrompt"] = comfyui_prompt

    if isinstance(workflow_graph_data, dict):
        metadata["comfyuiWorkflow"] = workflow_graph_data
    else:
        comfyui_workflow = response_payload.get("comfyui_workflow")
        if isinstance(comfyui_workflow, dict):
            metadata["comfyuiWorkflow"] = comfyui_workflow

    applied_widget_values = response_payload.get("applied_widget_values")
    if isinstance(applied_widget_values, dict):
        replay_state = (
            dict(metadata.get("replayState"))
            if isinstance(metadata.get("replayState"), dict)
            else {"version": 2}
        )
        widget_values = (
            dict(replay_state.get("widgetValues"))
            if isinstance(replay_state.get("widgetValues"), dict)
            else {}
        )
        derived_widget_values = (
            dict(replay_state.get("derivedWidgetValues"))
            if isinstance(replay_state.get("derivedWidgetValues"), dict)
            else {}
        )

        for raw_key, raw_value in applied_widget_values.items():
            if not isinstance(raw_key, str):
                continue
            value = str(raw_value)

            if raw_key.startswith("derived:") and raw_key.endswith(":__value"):
                derived_widget_id = raw_key[len("derived:") : -len(":__value")]
                if derived_widget_id:
                    derived_widget_values[f"derived_widget_{derived_widget_id}"] = value
                continue

            separator_index = raw_key.rfind(":")
            if separator_index <= 0 or separator_index >= len(raw_key) - 1:
                continue
            node_id = raw_key[:separator_index]
            param = raw_key[separator_index + 1 :]
            widget_values[f"widget_{node_id}_{param}"] = value

        if widget_values:
            replay_state["widgetValues"] = widget_values
        if derived_widget_values:
            replay_state["derivedWidgetValues"] = derived_widget_values
        metadata["replayState"] = replay_state

    return metadata


def _get_delivery_context_value(
    delivery_context: dict[str, Any],
    snake_case_key: str,
    camel_case_key: str,
) -> Any | None:
    if snake_case_key in delivery_context:
        return delivery_context[snake_case_key]
    return delivery_context.get(camel_case_key)


def _normalize_delivery_context(
    delivery_context: dict[str, Any],
) -> dict[str, Any]:
    return {
        "plan_id": _get_delivery_context_value(delivery_context, "plan_id", "planId"),
        "workflow_name": _get_delivery_context_value(
            delivery_context,
            "workflow_name",
            "workflowName",
        ),
        "workflow_source_id": _get_delivery_context_value(
            delivery_context,
            "workflow_source_id",
            "workflowSourceId",
        ),
        "generation_metadata": _get_delivery_context_value(
            delivery_context,
            "generation_metadata",
            "generationMetadata",
        ),
        "postprocess_config": _get_delivery_context_value(
            delivery_context,
            "postprocess_config",
            "postprocessConfig",
        ),
        "auto_family_request_key": _get_delivery_context_value(
            delivery_context,
            "auto_family_request_key",
            "autoFamilyRequestKey",
        ),
        "uses_save_image_websocket_outputs": bool(
            _get_delivery_context_value(
                delivery_context,
                "uses_save_image_websocket_outputs",
                "usesSaveImageWebsocketOutputs",
            )
        ),
        "save_image_websocket_node_ids": [
            node_id
            for node_id in (
                _get_delivery_context_value(
                    delivery_context,
                    "save_image_websocket_node_ids",
                    "saveImageWebsocketNodeIds",
                )
                or []
            )
            if isinstance(node_id, str) and node_id
        ],
        "replay_inputs": _get_delivery_context_value(
            delivery_context,
            "replay_inputs",
            "replayInputs",
        ),
    }


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

        input_node_map = build_input_node_map(data)
        return {
            "synced": True,
            "node_classes": len(data),
            "input_node_map": input_node_map,
            "object_info": data,
        }
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


def _resolve_workflow_sidecar_path(filename: str) -> Path | None:
    main = sidecar_path_for_workflow(WORKFLOWS_DIR, filename)
    if main.exists():
        return main

    default = sidecar_path_for_workflow(DEFAULT_WORKFLOWS_DIR, filename)
    if default.exists():
        return default

    return None


def _classify_uploaded_workflow_filename(filename: str) -> dict[str, str]:
    if filename.lower().endswith(".rules.json"):
        workflow_stem = filename[: -len(".rules.json")]
        workflow_id = (
            workflow_stem
            if workflow_stem.lower().endswith(".json")
            else f"{workflow_stem}.json"
        )
        return {
            "kind": "rules",
            "workflow_id": workflow_id,
        }

    return {
        "kind": "workflow",
        "workflow_id": filename,
    }


def _resolve_workflow_media_fallbacks(
    *,
    workflow_rules: dict[str, Any] | None,
    workflow_id: str | None,
    workflow_warnings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if isinstance(workflow_rules, dict):
        rules_model, warning_models = normalize_rules_model(workflow_rules)
        workflow_warnings.extend(dump_warning_models(warning_models))
        rules = dump_resolved_rules(rules_model)
        fallback_defs = rules.get("media_fallbacks")
        if isinstance(fallback_defs, list):
            return [entry for entry in fallback_defs if isinstance(entry, dict)]
        return []

    if not isinstance(workflow_id, str) or not _is_safe_workflow_filename(workflow_id):
        return []

    rules_model, warning_models = load_rules_model_for_workflow(
        WORKFLOWS_DIR,
        workflow_id,
        fallback_dirs=[DEFAULT_WORKFLOWS_DIR],
    )
    workflow_warnings.extend(dump_warning_models(warning_models))
    rules = dump_resolved_rules(rules_model)
    fallback_defs = rules.get("media_fallbacks")
    if not isinstance(fallback_defs, list):
        return []

    return [entry for entry in fallback_defs if isinstance(entry, dict)]


def _parse_workflow_menu(path: Path, metadata_by_workflow_id: dict[str, dict[str, Any]]) -> None:
    if not path.exists():
        return

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Failed to load workflow menu config from %s: %s", path, exc)
        return

    if not isinstance(raw, dict):
        return

    raw_groups = raw.get("groups")
    if isinstance(raw_groups, list):
        for index, raw_group in enumerate(raw_groups):
            if not isinstance(raw_group, dict):
                continue

            raw_group_id = raw_group.get("id")
            if not isinstance(raw_group_id, str) or not raw_group_id.strip():
                continue
            group_id = raw_group_id.strip()

            raw_group_name = raw_group.get("name")
            group_name = (
                raw_group_name.strip()
                if isinstance(raw_group_name, str) and raw_group_name.strip()
                else group_id.title()
            )

            raw_group_order = raw_group.get("order")
            group_order = raw_group_order if isinstance(raw_group_order, int) else index

            raw_workflow_ids = raw_group.get("workflow_ids")
            if isinstance(raw_workflow_ids, list):
                for raw_workflow_id in raw_workflow_ids:
                    if not isinstance(raw_workflow_id, str) or not raw_workflow_id.strip():
                        continue
                    w_id = raw_workflow_id.strip()
                    if w_id not in metadata_by_workflow_id:
                        metadata_by_workflow_id[w_id] = {}
                    metadata_by_workflow_id[w_id].update({
                        "group_id": group_id,
                        "group_name": group_name,
                        "group_order": group_order,
                    })

    hidden_workflows = raw.get("hidden_workflows")
    if isinstance(hidden_workflows, list):
        for raw_workflow_id in hidden_workflows:
            if not isinstance(raw_workflow_id, str) or not raw_workflow_id.strip():
                continue
            w_id = raw_workflow_id.strip()
            if w_id not in metadata_by_workflow_id:
                metadata_by_workflow_id[w_id] = {}
            metadata_by_workflow_id[w_id]["hidden"] = True


def _load_workflow_menu_metadata() -> dict[str, dict[str, Any]]:
    metadata_by_workflow_id: dict[str, dict[str, Any]] = {}
    _parse_workflow_menu(WORKFLOW_MENU_CONFIG_PATH, metadata_by_workflow_id)
    _parse_workflow_menu(CUSTOM_WORKFLOW_MENU_PATH, metadata_by_workflow_id)
    return metadata_by_workflow_id


def _workflow_list_sort_key(item: dict[str, Any]) -> tuple[int, str]:
    raw_group_order = item.get("group_order")
    group_order = raw_group_order if isinstance(raw_group_order, int) else 1_000_000
    name = item.get("name")
    workflow_name = name if isinstance(name, str) else ""
    return (group_order, workflow_name.casefold())


def _resolve_workflow_rules_response(
    workflow: dict[str, Any],
    *,
    workflow_id: str | None = None,
) -> dict[str, Any]:
    rules_model, warnings = load_rules_model_for_workflow(
        WORKFLOWS_DIR,
        workflow_id,
        fallback_dirs=[DEFAULT_WORKFLOWS_DIR],
    )
    rules_model = enrich_rules_with_object_info(rules_model, workflow)
    rules = dump_resolved_rules(rules_model)
    nodes_with_widgets = {
        nid: list(nr.get("widgets", {}).keys())
        for nid, nr in rules.get("nodes", {}).items()
        if isinstance(nr, dict) and nr.get("widgets")
    }
    logger.info(
        "[rules/%s] Returning rules with %d widget nodes: %s",
        workflow_id or "<inline>",
        len(nodes_with_widgets),
        nodes_with_widgets,
    )

    has_sidecar = (
        isinstance(workflow_id, str)
        and _is_safe_workflow_filename(workflow_id)
        and _resolve_workflow_sidecar_path(workflow_id) is not None
    )

    return {
        "workflow_id": workflow_id or "",
        "has_sidecar": has_sidecar,
        "rules": rules,
        "warnings": dump_warning_models(warnings),
    }


def _merge_input_node_entries(
    dynamic_entries: list[dict[str, Any]],
    static_entries: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_param = {
        entry.get("param"): dict(entry)
        for entry in dynamic_entries
        if isinstance(entry, dict) and isinstance(entry.get("param"), str)
    }
    for entry in static_entries:
        if not isinstance(entry, dict):
            continue
        param = entry.get("param")
        if not isinstance(param, str):
            continue
        by_param[param] = {
            "input_type": entry.get("input_type"),
            "param": param,
            "label": entry.get("label"),
            "description": entry.get("description"),
        }
    return list(by_param.values())


def _resolve_input_node_map() -> dict[str, list[dict[str, Any]]]:
    """Return the full input node map (object_info-derived + static fallbacks)."""
    dynamic = build_input_node_map()
    merged = {
        class_type: [dict(entry) for entry in entries]
        for class_type, entries in dynamic.items()
    }
    for class_type, mapping in INPUT_NODE_MAP.items():
        static_entries = [{
            "input_type": mapping["input_type"],
            "param": mapping["param"],
            "label": default_input_label(mapping["input_type"]),
            "description": None,
        }]
        merged[class_type] = _merge_input_node_entries(
            merged.get(class_type, []),
            static_entries,
        )
    return merged


def _find_node_input_mapping(
    entries: list[dict[str, Any]] | None,
    *,
    input_type: str | None = None,
    param: str | None = None,
) -> dict[str, Any] | None:
    if not entries:
        return None
    if param is not None:
        for entry in entries:
            if entry.get("param") != param:
                continue
            if input_type is None or entry.get("input_type") == input_type:
                return entry
        return None
    if input_type is not None:
        for entry in entries:
            if entry.get("input_type") == input_type:
                return entry
        return None
    return entries[0]


def _parse_node_input_form_key(raw_key: str) -> tuple[str, str | None]:
    parsed = parse_widget_form_key(raw_key)
    if parsed is not None:
        return parsed[0], parsed[1]
    return raw_key, None


def _apply_workflow_media_fallbacks(
    *,
    workflow_rules: dict[str, Any] | None,
    workflow_id: str | None,
    workflow: dict[str, Any],
    injections: dict[str, dict[str, Any]],
    buffered_media: dict[str, dict[str, Any]],
    workflow_warnings: list[dict[str, Any]],
    node_map: dict[str, list[dict[str, Any]]],
) -> None:
    fallback_defs = _resolve_workflow_media_fallbacks(
        workflow_rules=workflow_rules,
        workflow_id=workflow_id,
        workflow_warnings=workflow_warnings,
    )
    if not fallback_defs:
        return

    provided_input_ids = collect_provided_input_ids_from_sources(
        injections,
        buffered_media,
    )

    for fallback in fallback_defs:
        fallback_kind = fallback.get("kind")
        node_id = fallback.get("node_id")
        input_type = fallback.get("input_type")
        explicit_param = fallback.get("param")
        if (
            not isinstance(fallback_kind, str)
            or not isinstance(node_id, str)
            or not isinstance(input_type, str)
        ):
            continue
        if fallback.get("when") is not None and not matches_input_presence_condition(
            fallback.get("when"),
            provided_input_ids,
        ):
            continue
        fallback_spec = WORKFLOW_MEDIA_FALLBACK_SPECS.get(
            f"{fallback_kind}:{input_type}"
        )
        if fallback_spec is None:
            workflow_warnings.append(
                {
                    "code": "media_fallback_unsupported",
                    "message": "Workflow fallback media declaration is not supported",
                    "node_id": node_id,
                    "details": {
                        "kind": fallback_kind,
                        "input_type": input_type,
                    },
                }
            )
            continue
        fallback_path = fallback_spec["path"]

        node = workflow.get(node_id)
        if not isinstance(node, dict):
            continue

        mapping = _find_node_input_mapping(
            node_map.get(node.get("class_type", "")),
            input_type=input_type,
            param=explicit_param if isinstance(explicit_param, str) else None,
        )
        if mapping is None:
            workflow_warnings.append(
                {
                    "code": "media_fallback_mapping_missing",
                    "message": "Could not resolve media input mapping for workflow fallback media",
                    "node_id": node_id,
                    "details": {"received": input_type, "param": explicit_param},
                }
            )
            continue

        buffer_key = f"{node_id}:{mapping['param']}"
        if buffer_key in buffered_media:
            continue

        if not fallback_path.is_file():
            workflow_warnings.append(
                {
                    "code": "media_fallback_missing",
                    "message": "Configured workflow fallback media file was not found",
                    "node_id": node_id,
                    "details": {"path": str(fallback_path)},
                }
            )
            continue

        buffered_media[buffer_key] = {
            "node_id": node_id,
            "param": mapping["param"],
            "input_type": input_type,
            "class_type": node.get("class_type", ""),
            "bytes": fallback_path.read_bytes(),
            "content_type": fallback.get(
                "content_type",
                fallback_spec.get("content_type", "application/octet-stream"),
            ),
            "filename": fallback.get(
                "filename",
                fallback_spec.get("filename", fallback_path.name),
            ),
            "synthetic": fallback.get("synthetic", True) is True,
        }

def _parse_workflow_inputs(workflow: dict) -> list[dict]:
    """Parse a workflow and return discoverable input nodes."""
    node_map = _resolve_input_node_map()
    inputs = []
    for node_id, node_data in workflow.items():
        if not isinstance(node_data, dict):
            continue
        class_type = node_data.get("class_type", "")
        mappings = node_map.get(class_type)
        if not mappings:
            continue
        node_inputs = node_data.get("inputs", {})
        meta = node_data.get("_meta", {})
        has_multiple = len(mappings) > 1
        for mapping in mappings:
            label = mapping.get("label") or meta.get("title", class_type)
            if not has_multiple:
                label = meta.get("title", class_type)
            inputs.append({
                "id": f"{node_id}:{mapping['param']}",
                "nodeId": node_id,
                "classType": class_type,
                "inputType": mapping["input_type"],
                "param": mapping["param"],
                "label": label,
                "description": mapping.get("description"),
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
        workflow_menu_metadata = _load_workflow_menu_metadata()

        # Main dir first – these take precedence.
        if WORKFLOWS_DIR.exists():
            for path in WORKFLOWS_DIR.glob("*.json"):
                if path.name.endswith(".rules.json"):
                    continue
                seen.add(path.name)
                name = path.stem
                rules, _ = load_rules_model_for_workflow(
                    WORKFLOWS_DIR, path.name,
                    fallback_dirs=[DEFAULT_WORKFLOWS_DIR],
                )
                if rules.name:
                    name = rules.name
                workflow_item: dict[str, Any] = {"id": path.name, "name": name}
                workflow_item.update(workflow_menu_metadata.get(path.name, {}))
                if workflow_item.get("hidden"):
                    continue
                workflows.append(workflow_item)

        # Default dir – only add workflows not already seen.
        if DEFAULT_WORKFLOWS_DIR.exists():
            for path in DEFAULT_WORKFLOWS_DIR.glob("*.json"):
                if path.name.endswith(".rules.json"):
                    continue
                if path.name in seen:
                    continue
                name = path.stem
                rules, _ = load_rules_model_for_workflow(DEFAULT_WORKFLOWS_DIR, path.name)
                if rules.name:
                    name = rules.name
                workflow_item = {"id": path.name, "name": name}
                workflow_item.update(workflow_menu_metadata.get(path.name, {}))
                if workflow_item.get("hidden"):
                    continue
                workflows.append(workflow_item)

        workflows.sort(key=_workflow_list_sort_key)
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


@router.post("/workflow/upload")
async def upload_workflow_files(files: list[UploadFile] = File(...)):
    """Persists one or more workflow-side JSON files into backend/assets/workflows."""
    if not files:
        return error_response(
            400,
            "missing_workflow_files",
            "At least one workflow JSON file is required",
            retryable=False,
        )

    uploaded: list[dict[str, str]] = []

    try:
        WORKFLOWS_DIR.mkdir(parents=True, exist_ok=True)

        for upload in files:
            filename = upload.filename.strip() if isinstance(upload.filename, str) else ""
            if not filename:
                return error_response(
                    400,
                    "invalid_workflow_filename",
                    "Workflow upload is missing a filename",
                    retryable=False,
                )
            if not filename.lower().endswith(".json"):
                return error_response(
                    400,
                    "invalid_workflow_extension",
                    "Workflow uploads must use .json filenames",
                    retryable=False,
                    details={"filename": filename},
                )
            if not _is_safe_workflow_filename(filename):
                return error_response(
                    400,
                    "invalid_workflow_filename",
                    "Invalid workflow filename",
                    retryable=False,
                    details={"filename": filename},
                )

            raw_bytes = await upload.read()
            try:
                parsed_json = json.loads(raw_bytes.decode("utf-8"))
            except UnicodeDecodeError:
                return error_response(
                    400,
                    "invalid_workflow_encoding",
                    "Workflow JSON files must be UTF-8 encoded",
                    retryable=False,
                    details={"filename": filename},
                )
            except json.JSONDecodeError as exc:
                return error_response(
                    400,
                    "invalid_workflow_json",
                    "Workflow JSON file is invalid",
                    retryable=False,
                    details={"filename": filename, "reason": exc.msg},
                )

            path = WORKFLOWS_DIR / filename
            path.write_text(json.dumps(parsed_json, indent=2), encoding="utf-8")

            uploaded.append({
                "filename": filename,
                **_classify_uploaded_workflow_filename(filename),
            })

        return {
            "uploaded": uploaded,
        }
    except OSError as exc:
        return error_response(
            500,
            "workflow_upload_failed",
            "Failed to persist workflow upload",
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
        workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
        if not isinstance(workflow, dict):
            logger.warning(
                "[rules/%s] workflow is not a dict: %s",
                filename,
                type(workflow).__name__,
            )
            workflow = {}
        return _resolve_workflow_rules_response(workflow, workflow_id=filename)
    except OSError as exc:
        return error_response(
            500,
            "workflow_rules_failed",
            "Failed to load workflow rules",
            retryable=True,
            details={"reason": str(exc)},
        )


@router.post("/workflow/rules/resolve")
async def resolve_workflow_rules(request: Request):
    """Resolve rules for arbitrary workflow content and optional graph data."""
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return error_response(
            400,
            "invalid_workflow_rules_payload",
            "Workflow rules payload must be valid JSON",
            retryable=False,
        )

    if not isinstance(body, dict):
        return error_response(
            400,
            "invalid_workflow_rules_payload",
            "Workflow rules payload must be an object",
            retryable=False,
        )

    workflow = body.get("workflow")
    if not isinstance(workflow, dict):
        return error_response(
            400,
            "invalid_workflow_payload",
            "Workflow rules resolution requires a workflow object",
            retryable=False,
        )

    graph_data = body.get("graph_data")
    workflow_for_enrichment = graph_data if isinstance(graph_data, dict) else workflow
    workflow_id = body.get("workflow_id")
    if not isinstance(workflow_id, str):
        workflow_id = None

    return _resolve_workflow_rules_response(
        workflow_for_enrichment,
        workflow_id=workflow_id,
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

    project_id_raw = form.get("project_id")
    project_id = project_id_raw.strip() if isinstance(project_id_raw, str) else ""
    if not project_id:
        return error_response(
            400,
            "invalid_project_id",
            "Missing or invalid 'project_id'",
            retryable=False,
        )

    delivery_context_json = form.get("delivery_context")
    if not isinstance(delivery_context_json, str) or not delivery_context_json.strip():
        return error_response(
            400,
            "invalid_delivery_context",
            "Missing or invalid 'delivery_context' JSON",
            retryable=False,
        )
    try:
        delivery_context = json.loads(delivery_context_json)
    except json.JSONDecodeError:
        return error_response(
            400,
            "invalid_delivery_context",
            "Delivery context payload must be valid JSON",
            retryable=False,
        )
    if not isinstance(delivery_context, dict):
        return error_response(
            400,
            "invalid_delivery_context",
            "Delivery context payload must be an object",
            retryable=False,
        )
    delivery_context = _normalize_delivery_context(delivery_context)

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

    workflow_rules: dict[str, Any] | None = None
    workflow_rules_json = form.get("workflow_rules")
    if isinstance(workflow_rules_json, str) and workflow_rules_json.strip():
        try:
            parsed_workflow_rules = json.loads(workflow_rules_json)
        except json.JSONDecodeError:
            return error_response(
                400,
                "invalid_workflow_rules_payload",
                "Workflow rules payload must be valid JSON",
                retryable=False,
            )
        if not isinstance(parsed_workflow_rules, dict):
            return error_response(
                400,
                "invalid_workflow_rules_payload",
                "Workflow rules payload must be an object",
                retryable=False,
            )
        workflow_rules = parsed_workflow_rules

    pipeline_inputs: dict[str, dict[str, Any]] = {}
    pipeline_inputs_json = form.get("pipeline_inputs")
    if isinstance(pipeline_inputs_json, str) and pipeline_inputs_json.strip():
        try:
            parsed_pipeline_inputs = json.loads(pipeline_inputs_json)
        except json.JSONDecodeError:
            return error_response(
                400,
                "invalid_pipeline_inputs_payload",
                "Pipeline inputs payload must be valid JSON",
                retryable=False,
            )
        if not isinstance(parsed_pipeline_inputs, dict):
            return error_response(
                400,
                "invalid_pipeline_inputs_payload",
                "Pipeline inputs payload must be an object",
                retryable=False,
            )
        pipeline_inputs = {
            stage_id: values
            for stage_id, values in parsed_pipeline_inputs.items()
            if isinstance(stage_id, str) and isinstance(values, dict)
        }

    input_metadata: dict[str, dict[str, Any]] = {}
    input_metadata_json = form.get("input_metadata")
    if isinstance(input_metadata_json, str) and input_metadata_json.strip():
        try:
            parsed_input_metadata = json.loads(input_metadata_json)
        except json.JSONDecodeError:
            return error_response(
                400,
                "invalid_input_metadata_payload",
                "Input metadata payload must be valid JSON",
                retryable=False,
            )
        if not isinstance(parsed_input_metadata, dict):
            return error_response(
                400,
                "invalid_input_metadata_payload",
                "Input metadata payload must be an object",
                retryable=False,
            )
        input_metadata = {
            input_id: value
            for input_id, value in parsed_input_metadata.items()
            if isinstance(input_id, str) and isinstance(value, dict)
        }

    # --- Collect injections from form fields ---
    injections: dict[str, dict[str, Any]] = {}
    workflow_warnings: list[dict[str, Any]] = []

    cached_media_inputs_json = form.get("cached_media_inputs")
    if isinstance(cached_media_inputs_json, str) and cached_media_inputs_json.strip():
        try:
            parsed_cached_media_inputs = json.loads(cached_media_inputs_json)
        except json.JSONDecodeError:
            return error_response(
                400,
                "invalid_cached_media_inputs_payload",
                "Cached media inputs payload must be valid JSON",
                retryable=False,
            )
        if not isinstance(parsed_cached_media_inputs, dict):
            return error_response(
                400,
                "invalid_cached_media_inputs_payload",
                "Cached media inputs payload must be an object",
                retryable=False,
            )
        for node_id, values in parsed_cached_media_inputs.items():
            if not isinstance(node_id, str) or not isinstance(values, dict):
                continue
            node = workflow.get(node_id)
            if not isinstance(node, dict):
                continue
            for param, cached_value in values.items():
                if not isinstance(param, str) or cached_value is None:
                    continue
                injections.setdefault(node_id, {})[param] = cached_value

    # --- Collect widget overrides from form fields ---
    widget_overrides: dict[str, dict[str, Any]] = {}
    derived_widget_values: dict[str, Any] = {}
    widget_modes: dict[str, dict[str, str]] = {}

    # Media uploads are buffered so validation can run before dispatch, and
    # video-specific preprocessors can still mutate bytes before upload.
    buffered_media: dict[str, dict[str, Any]] = {}

    node_map = _resolve_input_node_map()

    async def _buffer_uploaded_media(
        *,
        node_id: str,
        explicit_param: str | None,
        upload_file: Any,
        media_type: str,
    ) -> None:
        if not hasattr(upload_file, "read"):
            workflow_warnings.append(
                {
                    "code": "invalid_upload_field",
                    "message": "Upload field is not a file-like object",
                    "node_id": node_id,
                    "details": {"media_type": media_type},
                }
            )
            return

        node = workflow.get(node_id)
        if not isinstance(node, dict):
            return

        mapping = _find_node_input_mapping(
            node_map.get(node.get("class_type", "")),
            input_type=media_type,
            param=explicit_param,
        )
        if mapping is None:
            workflow_warnings.append(
                {
                    "code": "media_mapping_missing",
                    "message": "Could not resolve media input mapping for uploaded media",
                    "node_id": node_id,
                    "details": {"received": media_type, "param": explicit_param},
                }
            )
            return

        file_obj = cast(UploadFile, upload_file)
        media_bytes = await file_obj.read()
        fallback_content_types = {
            "image": "image/png",
            "audio": "audio/wav",
            "video": "video/mp4",
        }
        content_type = getattr(file_obj, "content_type", None) or fallback_content_types[
            media_type
        ]
        filename_value = getattr(file_obj, "filename", f"upload.{media_type}")

        buffered_media[f"{node_id}:{mapping['param']}"] = {
            "node_id": node_id,
            "param": mapping["param"],
            "input_type": media_type,
            "class_type": node.get("class_type", ""),
            "bytes": media_bytes,
            "content_type": content_type,
            "filename": filename_value,
        }

    for key, value in form.multi_items():
        # widget_mode_<nodeId>_<param> -> fixed|randomize
        if key.startswith("widget_mode_"):
            parsed = parse_widget_form_key(key[len("widget_mode_"):])
            if parsed and isinstance(value, str):
                node_id, param = parsed
                mode = value.strip().lower()
                if mode in WIDGET_CONTROL_MODES:
                    widget_modes.setdefault(node_id, {})[param] = mode
            continue

        # derived_widget_<widgetId> -> frontend-derived widget value
        if key.startswith("derived_widget_"):
            derived_widget_id = key[len("derived_widget_"):]
            if derived_widget_id and isinstance(value, str):
                parsed_value: Any = value
                try:
                    if "." in value:
                        parsed_value = float(value)
                    else:
                        parsed_value = int(value)
                except ValueError:
                    pass
                derived_widget_values[derived_widget_id] = parsed_value
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

        # text_<nodeId>_<param> -> inject text value
        if key.startswith("text_"):
            node_id, explicit_param = _parse_node_input_form_key(key[5:])
            node = workflow.get(node_id)
            if node and isinstance(node, dict):
                mapping = _find_node_input_mapping(
                    node_map.get(node.get("class_type", "")),
                    input_type="text",
                    param=explicit_param,
                )
                if mapping:
                    injections.setdefault(node_id, {})[mapping["param"]] = value

        # image_<nodeId>_<param> -> buffer image upload
        elif key.startswith("image_"):
            node_id, explicit_param = _parse_node_input_form_key(key[6:])
            await _buffer_uploaded_media(
                node_id=node_id,
                explicit_param=explicit_param,
                upload_file=value,
                media_type="image",
            )

        # audio_<nodeId>_<param> -> buffer audio upload
        elif key.startswith("audio_"):
            node_id, explicit_param = _parse_node_input_form_key(key[6:])
            await _buffer_uploaded_media(
                node_id=node_id,
                explicit_param=explicit_param,
                upload_file=value,
                media_type="audio",
            )

        # video_<nodeId>_<param> -> buffer for potential mask crop before upload
        elif key.startswith("video_"):
            node_id, explicit_param = _parse_node_input_form_key(key[6:])
            await _buffer_uploaded_media(
                node_id=node_id,
                explicit_param=explicit_param,
                upload_file=value,
                media_type="video",
            )

    _apply_workflow_media_fallbacks(
        workflow_rules=workflow_rules,
        workflow_id=workflow_id,
        workflow=workflow,
        injections=injections,
        buffered_media=buffered_media,
        workflow_warnings=workflow_warnings,
        node_map=node_map,
    )

    # --- Backend request assembly ends here ---
    # The generation service now runs the remaining backend phases explicitly:
    # backend preprocess -> dispatch to ComfyUI -> backend postprocess.
    # --- Check if the frontend pre-resolved the prompt via graphToPrompt ---
    prompt_is_pre_resolved_raw = form.get("prompt_is_pre_resolved")
    prompt_is_pre_resolved = (
        isinstance(prompt_is_pre_resolved_raw, str)
        and prompt_is_pre_resolved_raw.strip().lower() in ("true", "1")
    )

    gen_input = GenerationInput(
        client_id=str(uuid.uuid4()),
        prompt_id=str(uuid.uuid4()),
        workflow=workflow,
        workflow_id=workflow_id,
        rules=workflow_rules,
        rules_override_provided=workflow_rules is not None,
        pipeline_inputs=pipeline_inputs,
        input_metadata=input_metadata,
        injections=injections,
        widget_overrides=widget_overrides,
        derived_widget_values=derived_widget_values,
        widget_modes=widget_modes,
        buffered_media=buffered_media,
        graph_data=graph_data,
        workflow_warnings=workflow_warnings,
        prompt_is_pre_resolved=prompt_is_pre_resolved,
    )
    delivery_id = str(uuid.uuid4())

    await generation_holding_service.create_delivery(
        project_id=project_id,
        delivery_id=delivery_id,
        prompt_id=gen_input.prompt_id or str(uuid.uuid4()),
        client_id=gen_input.client_id,
        delivery_context=delivery_context,
    )
    await generation_holding_service.start_monitor(
        project_id=project_id,
        delivery_id=delivery_id,
        prompt_id=gen_input.prompt_id or "",
        client_id=gen_input.client_id,
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
        await generation_holding_service.cancel_monitor(delivery_id)
        await generation_holding_service.acknowledge_delivery(project_id, delivery_id)
        return error_response(
            503,
            "comfyui_unreachable",
            "Generation failed because ComfyUI is unavailable",
            retryable=True,
            details={"reason": str(exc)},
        )
    except ValueError as exc:
        await generation_holding_service.cancel_monitor(delivery_id)
        await generation_holding_service.acknowledge_delivery(project_id, delivery_id)
        details = None
        if isinstance(exc, WorkflowValidationError) and exc.failures:
            details = {"validation_failures": exc.failures}
        return error_response(
            400,
            "invalid_generation_request",
            str(exc),
            retryable=False,
            details=details,
        )
    except RuntimeError as exc:
        await generation_holding_service.cancel_monitor(delivery_id)
        await generation_holding_service.acknowledge_delivery(project_id, delivery_id)
        return error_response(
            500,
            "generation_failed",
            str(exc),
            retryable=True,
        )

    if result.media_type.lower().startswith("application/json"):
        try:
            payload = json.loads(result.content.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = None
        if isinstance(payload, dict):
            node_errors = payload.get("node_errors")
            if result.status_code >= 400 or (
                isinstance(node_errors, dict) and len(node_errors) > 0
            ):
                await generation_holding_service.cancel_monitor(delivery_id)
                await generation_holding_service.acknowledge_delivery(
                    project_id,
                    delivery_id,
                )
                return Response(
                    content=result.content,
                    status_code=result.status_code,
                    media_type=result.media_type,
                )
            pipeline_outputs = payload.get("pipeline_outputs")
            prepared_mask_video = _extract_stage_output_value(
                pipeline_outputs,
                "processed_mask_video",
            )
            prepared_mask_bytes = None
            if isinstance(prepared_mask_video, str) and prepared_mask_video:
                try:
                    prepared_mask_bytes = base64.b64decode(prepared_mask_video)
                except (ValueError, TypeError):
                    prepared_mask_bytes = None

            await generation_holding_service.update_submission_metadata(
                delivery_id=delivery_id,
                workflow_warnings=payload.get("workflow_warnings")
                if isinstance(payload.get("workflow_warnings"), list)
                else None,
                applied_widget_values=payload.get("applied_widget_values")
                if isinstance(payload.get("applied_widget_values"), dict)
                else None,
                aspect_ratio_processing=_extract_stage_output_value(
                    pipeline_outputs,
                    "aspect_ratio_processing",
                )
                if isinstance(
                    _extract_stage_output_value(
                        pipeline_outputs,
                        "aspect_ratio_processing",
                    ),
                    dict,
                )
                else None,
                generation_metadata=_enrich_generation_metadata(
                    delivery_context.get("generation_metadata"),
                    payload,
                    graph_data,
                ),
                prepared_mask_bytes=prepared_mask_bytes,
                prepared_mask_filename="generation-mask.mp4"
                if prepared_mask_bytes is not None
                else None,
                prepared_mask_content_type="video/mp4"
                if prepared_mask_bytes is not None
                else None,
            )
            payload["delivery_id"] = delivery_id
            result = comfyui_generate_service.GenerationResult(
                content=json.dumps(payload).encode("utf-8"),
                status_code=result.status_code,
                media_type="application/json",
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
