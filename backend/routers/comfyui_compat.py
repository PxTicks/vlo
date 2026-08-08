import json
from pathlib import Path
from urllib.parse import unquote

from fastapi import APIRouter, Request, Response, WebSocket
from fastapi.responses import FileResponse

from services.comfyui.comfyui_proxy import (
    PROXY_HTTP_METHODS,
    compose_upstream_path,
    proxy_http_request,
    proxy_websocket,
    upstream_path_from_raw_request,
)

compat_router = APIRouter(tags=["comfyui-compat"])

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
    response = await proxy_http_request(request, upstream_path)
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
    return await proxy_http_request(request, upstream_path)


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
    return await proxy_http_request(request, compose_upstream_path("prompt", path))


@compat_router.api_route("/queue", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/queue/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_queue_root(request: Request, path: str = ""):
    return await proxy_http_request(request, compose_upstream_path("queue", path))


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
