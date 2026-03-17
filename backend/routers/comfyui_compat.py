from fastapi import APIRouter, Request, WebSocket

from services.comfyui.comfyui_proxy import (
    PROXY_HTTP_METHODS,
    compose_upstream_path,
    proxy_http_request,
    proxy_websocket,
    upstream_path_from_raw_request,
)

compat_router = APIRouter(tags=["comfyui-compat"])


# ---------------------------------------------------------------------------
# Root compatibility routes for same-origin ComfyUI iframe usage
# ---------------------------------------------------------------------------

@compat_router.api_route("/comfyui-frame", methods=PROXY_HTTP_METHODS)
@compat_router.api_route("/comfyui-frame/{path:path}", methods=PROXY_HTTP_METHODS)
async def proxy_comfyui_frame(request: Request, path: str = ""):
    # Preserve raw encoded file paths when proxying iframe-scoped requests.
    upstream_path = upstream_path_from_raw_request(request, "/comfyui-frame")
    return await proxy_http_request(request, upstream_path)


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
