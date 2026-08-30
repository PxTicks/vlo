import asyncio
import json
import logging
from pathlib import Path
from urllib.parse import unquote

from fastapi import APIRouter, Request, Response, WebSocket
from fastapi.responses import FileResponse, JSONResponse

from services.comfyui.comfyui_proxy import (
    PROXY_HTTP_METHODS,
    compose_upstream_path,
    is_proxy_transport_failure,
    proxy_http_request,
    proxy_websocket,
    upstream_path_from_raw_request,
)
from services.generation_delivery import generation_holding_service
from services.model_work.comfyui_admission import (
    ComfyGpuBusyError,
    ComfyPromptAdmission,
)
from services.model_work.leases import CoordinatorNotReadyError

compat_router = APIRouter(tags=["comfyui-compat"])
logger = logging.getLogger(__name__)

_BRIDGE_EXTENSION_URL = "/extensions/vlo-host/vlo-bridge.js"
_BRIDGE_ASSET_ROOT = (
    Path(__file__).resolve().parent.parent / "assets" / "comfyui_bridge"
)
_BRIDGE_ASSETS = {
    "extensions/vlo-host/vlo-bridge.js": _BRIDGE_ASSET_ROOT / "vlo-bridge.js",
    "extensions/vlo-host/bridge-core.mjs": _BRIDGE_ASSET_ROOT / "bridge-core.mjs",
}
_BRIDGE_BOOTSTRAP_TAG = (
    b'<script type="module" '
    b'src="/comfyui-frame/extensions/vlo-host/vlo-bridge.js"></script>'
)
_IFRAME_EXTENSION_LIST_PATHS = {"api/extensions", "extensions"}
_PROMPT_UPSTREAM_PATHS = {"/prompt", "/api/prompt"}
_QUEUE_UPSTREAM_PATHS = {"/queue", "/api/queue"}
_PROMPT_WATCHDOGS: set[asyncio.Task[None]] = set()


def _is_installed_vlo_bridge(extension_url: str) -> bool:
    normalized = unquote(extension_url).replace("\\", "/").lower()
    return normalized.endswith("/comfyui-vlo/vlo-bridge.js")


def _decorate_extension_list(response: Response) -> Response:
    if response.status_code < 200 or response.status_code >= 300:
        return response
    try:
        payload = json.loads(bytes(response.body))
    except (AttributeError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return response
    if not isinstance(payload, list) or not all(
        isinstance(item, str) for item in payload
    ):
        return response

    extensions = [
        item
        for item in payload
        if item != _BRIDGE_EXTENSION_URL and not _is_installed_vlo_bridge(item)
    ]
    # Start the hosted bridge before third-party extensions. On a cold browser
    # load ComfyUI can spend longer than the parent's readiness deadline
    # scheduling a large extension list; loading the bridge first lets it emit
    # `booting` immediately and prevents recovery from reloading ComfyUI before
    # initialization can finish.
    extensions.insert(0, _BRIDGE_EXTENSION_URL)
    return Response(
        content=json.dumps(extensions),
        status_code=response.status_code,
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


def _decorate_iframe_html(response: Response) -> Response:
    if response.status_code < 200 or response.status_code >= 300:
        return response
    if "text/html" not in response.headers.get("content-type", "").lower():
        return response

    try:
        body = bytes(response.body)
    except (AttributeError, TypeError):
        return response
    if _BRIDGE_BOOTSTRAP_TAG in body:
        return response

    lower_body = body.lower()
    head_start = lower_body.find(b"<head")
    head_open_end = lower_body.find(b">", head_start) if head_start >= 0 else -1
    if head_open_end < 0:
        return response

    insert_at = head_open_end + 1
    decorated = body[:insert_at] + _BRIDGE_BOOTSTRAP_TAG + body[insert_at:]
    headers = dict(response.headers)
    headers.pop("content-length", None)
    headers["cache-control"] = "no-store"
    return Response(
        content=decorated,
        status_code=response.status_code,
        headers=headers,
        media_type=response.media_type,
    )


def _iframe_submission_metadata(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        return {}
    metadata: dict[str, object] = {}
    prompt = payload.get("prompt")
    if isinstance(prompt, dict) and prompt:
        metadata["comfyuiPrompt"] = prompt
    extra_data = payload.get("extra_data")
    if isinstance(extra_data, dict):
        extra_pnginfo = extra_data.get("extra_pnginfo")
        if isinstance(extra_pnginfo, dict):
            workflow = extra_pnginfo.get("workflow")
            if isinstance(workflow, dict) and workflow:
                metadata["comfyuiWorkflow"] = workflow
    return metadata


async def _adopt_accepted_iframe_prompt(
    request_payload: object,
    prompt_id: str,
) -> bool:
    """Create a delivery for an accepted iframe prompt.

    Returns whether a delivery monitor now owns this prompt. When it does not,
    the caller must give the prompt's GPU occupancy its own watchdog.
    """

    if not isinstance(request_payload, dict):
        return False
    client_id = request_payload.get("client_id")
    if not isinstance(client_id, str) or not client_id.strip():
        return False
    normalized_client_id = client_id.strip()
    project_id = await generation_holding_service.get_iframe_client_project(
        normalized_client_id
    )
    if project_id is None:
        return False
    try:
        await generation_holding_service.adopt_delivery(
            project_id=project_id,
            prompt_id=prompt_id,
            client_id=normalized_client_id,
            generation_metadata=_iframe_submission_metadata(request_payload),
        )
    except Exception:
        # The accepted ComfyUI submission must still reach the iframe. Bridge
        # lifecycle adoption remains a retrying fallback for this rare failure.
        logger.exception(
            "Failed to create holding delivery for iframe prompt %s",
            prompt_id,
        )
        return False
    return True


def _accepted_iframe_prompt_id(response: Response) -> str | None:
    if not 200 <= response.status_code < 300:
        return None
    try:
        payload = json.loads(bytes(response.body))
    except (AttributeError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    prompt_id = payload.get("prompt_id")
    if not isinstance(prompt_id, str) or not prompt_id.strip():
        return None
    return prompt_id.strip()


async def _proxy_with_prompt_adoption(
    request: Request,
    upstream_path: str,
) -> Response:
    normalized_path = f"/{upstream_path.lstrip('/')}"
    is_prompt_submission = (
        request.method == "POST" and normalized_path in _PROMPT_UPSTREAM_PATHS
    )
    request_payload: object = None
    if is_prompt_submission:
        try:
            request_payload = await request.json()
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass

    if not is_prompt_submission:
        return await proxy_queue_mutation(request, upstream_path)

    # Fail-fast admission, taken *before* forwarding. Observe-only admission
    # cannot exclude anything: by the time adoption runs, ComfyUI already has
    # the prompt. Reservation applies to every prompt on this proxy path even
    # when adoption metadata is unavailable.
    admission = ComfyPromptAdmission(
        source="comfyui-iframe",
        label="ComfyUI (in-editor)",
    )
    try:
        admission.reserve()
    except ComfyGpuBusyError as exc:
        return _gpu_busy_response(exc)
    except CoordinatorNotReadyError as exc:
        return _not_ready_response(exc)

    ambiguous_lease = None
    with admission:
        response = await proxy_http_request(request, upstream_path)
        prompt_id = _accepted_iframe_prompt_id(response)
        if prompt_id is not None:
            admission.accept(prompt_id)
        elif is_proxy_transport_failure(response):
            # The request never completed, so ComfyUI may or may not have queued
            # the prompt — and the prompt id only ever arrives in the response
            # that failed. Letting the context release here would be a guess.
            ambiguous_lease = admission.detach()

    if prompt_id is not None:
        adopted = await _adopt_accepted_iframe_prompt(request_payload, prompt_id)
        if not adopted:
            # A prompt from an unregistered client still holds the GPU, and no
            # delivery monitor exists to release it. Give it its own watchdog
            # rather than leaking the occupancy or freeing it on a guess.
            _spawn_watchdog(
                generation_holding_service.watch_unadopted_prompt(prompt_id)
            )
    elif ambiguous_lease is not None:
        _spawn_watchdog(
            generation_holding_service.watch_ambiguous_submission(ambiguous_lease)
        )
    return response


async def proxy_queue_mutation(request: Request, upstream_path: str) -> Response:
    """Forward a queue request, and give a delete/clear vlo did not originate
    its meaning.

    ComfyUI's own Clear button posts straight through this proxy, and the only
    trace it leaves behind is prompts silently absent from the next /queue poll
    — which every monitor would otherwise settle as a failure.

    The body is read before forwarding (Starlette caches it, so the forwarded
    request is unaffected) but recorded only *after* ComfyUI accepts it. A
    rejected mutation changed nothing, and a note that outlives its own request
    would relabel a later, genuine failure as a cancellation.
    """

    normalized_path = f"/{upstream_path.lstrip('/')}".rstrip("/")
    cancelled: list[str] = []
    if request.method == "POST" and normalized_path in _QUEUE_UPSTREAM_PATHS:
        try:
            payload: object = await request.json()
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = None
        # Resolved *before* forwarding, because a `clear` names no ids: they can
        # only be read off the queue ComfyUI is about to empty. Reading the body
        # here is free — Starlette caches it, so the forwarded request is
        # unaffected.
        cancelled = await generation_holding_service.resolve_queue_mutation(payload)

    response = await proxy_http_request(request, upstream_path)
    # Recorded only once ComfyUI accepts it: a note for a rejected mutation
    # would outlive its own request and relabel a later, genuine failure.
    if cancelled and 200 <= response.status_code < 300:
        await generation_holding_service.note_prompts_cancelled(cancelled)
    return response


def _spawn_watchdog(coroutine) -> None:
    task = asyncio.create_task(coroutine)
    # Without a strong reference the loop may garbage-collect the task and the
    # occupancy would never be reconciled.
    _PROMPT_WATCHDOGS.add(task)
    task.add_done_callback(_PROMPT_WATCHDOGS.discard)


def _gpu_busy_response(exc: ComfyGpuBusyError) -> Response:
    # ComfyUI's frontend surfaces the `error` field of a non-2xx /prompt
    # response as a toast, so the message has to be self-explanatory there.
    occupant = f" ({exc.occupied_by})" if exc.occupied_by else ""
    return JSONResponse(
        status_code=429,
        headers={"Retry-After": "5"},
        content={
            "error": {
                "type": "gpu_busy",
                "message": f"vlo is using the GPU{occupant}. Try again shortly.",
                "details": "vlo serialises GPU work between its own models and ComfyUI.",
            },
            "node_errors": {},
        },
    )


def _not_ready_response(exc: CoordinatorNotReadyError) -> Response:
    return JSONResponse(
        status_code=503,
        headers={"Retry-After": "5"},
        content={
            "error": {
                "type": "model_work_not_ready",
                "message": "vlo is still restoring in-flight generations. Try again shortly.",
                "details": str(exc),
            },
            "node_errors": {},
        },
    )


# ---------------------------------------------------------------------------
# Root compatibility routes for same-origin ComfyUI iframe usage
# ---------------------------------------------------------------------------

@compat_router.api_route("/comfyui-frame", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/comfyui-frame/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_comfyui_frame(request: Request, path: str = ""):
    normalized_path = path.strip("/")
    bridge_asset = _BRIDGE_ASSETS.get(normalized_path)
    if bridge_asset is not None:
        return FileResponse(
            bridge_asset,
            media_type="text/javascript",
            headers={"Cache-Control": "no-store"},
        )
    if normalized_path.startswith("extensions/vlo-host/"):
        return Response(status_code=404, content="Bridge asset not found")

    # Preserve raw encoded file paths when proxying iframe-scoped requests.
    upstream_path = upstream_path_from_raw_request(request, "/comfyui-frame")
    response = await _proxy_with_prompt_adoption(request, upstream_path)
    if request.method == "GET" and normalized_path == "":
        return _decorate_iframe_html(response)
    if request.method == "GET" and normalized_path in _IFRAME_EXTENSION_LIST_PATHS:
        return _decorate_extension_list(response)
    return response


@compat_router.api_route("/api", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/api/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_api_root(request: Request, path: str = ""):
    # Preserve both the /api prefix and raw encoded path segments.
    upstream_path = upstream_path_from_raw_request(request)
    return await _proxy_with_prompt_adoption(request, upstream_path)


@compat_router.api_route("/scripts", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/scripts/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_scripts_root(request: Request, path: str = ""):
    return await proxy_http_request(request, compose_upstream_path("scripts", path))


@compat_router.api_route("/extensions", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/extensions/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_extensions_root(request: Request, path: str = ""):
    return await proxy_http_request(request, compose_upstream_path("extensions", path))


@compat_router.api_route("/prompt", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/prompt/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_prompt_root(request: Request, path: str = ""):
    return await _proxy_with_prompt_adoption(
        request,
        compose_upstream_path("prompt", path),
    )


@compat_router.api_route("/queue", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/queue/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_queue_root(request: Request, path: str = ""):
    return await proxy_queue_mutation(request, compose_upstream_path("queue", path))


@compat_router.api_route("/view", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/view/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_view_root(request: Request, path: str = ""):
    return await proxy_http_request(request, compose_upstream_path("view", path))


@compat_router.api_route("/upload", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/upload/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_upload_root(request: Request, path: str = ""):
    return await proxy_http_request(request, compose_upstream_path("upload", path))


@compat_router.api_route("/object_info", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/object_info/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_object_info_root(request: Request, path: str = ""):
    return await proxy_http_request(request, compose_upstream_path("object_info", path))


@compat_router.api_route("/embeddings", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/embeddings/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_embeddings_root(request: Request, path: str = ""):
    return await proxy_http_request(request, compose_upstream_path("embeddings", path))


@compat_router.api_route("/system_stats", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/system_stats/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_system_stats_root(request: Request, path: str = ""):
    return await proxy_http_request(request, compose_upstream_path("system_stats", path))


@compat_router.api_route("/history", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/history/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_history_root(request: Request, path: str = ""):
    return await proxy_http_request(request, compose_upstream_path("history", path))


@compat_router.api_route("/internal", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/internal/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_internal_root(request: Request, path: str = ""):
    return await proxy_http_request(request, compose_upstream_path("internal", path))


@compat_router.websocket("/ws")
async def websocket_proxy_root(ws: WebSocket):
    await proxy_websocket(ws, "/ws")


@compat_router.websocket("/api/ws")
async def websocket_proxy_root_api_alias(ws: WebSocket):
    await proxy_websocket(ws, "/ws")


@compat_router.websocket("/comfyui-frame/ws")
async def websocket_proxy_comfyui_frame_alias(ws: WebSocket):
    await proxy_websocket(ws, "/ws")


@compat_router.websocket("/comfyui-frame/api/ws")
async def websocket_proxy_comfyui_frame_api_alias(ws: WebSocket):
    await proxy_websocket(ws, "/ws")
