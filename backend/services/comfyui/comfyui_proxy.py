import asyncio
import urllib.parse
import uuid

import httpx
import websockets
from fastapi import Request, Response, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from services.comfyui.comfyui_client import get_comfyui_url, get_http_client

PROXY_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]


def _normalize_upstream_path(path: str) -> str:
    stripped = path.lstrip("/")
    return f"/{stripped}" if stripped else "/"


def _request_raw_path(request: Request) -> str:
    raw_path = request.scope.get("raw_path")
    if isinstance(raw_path, (bytes, bytearray)):
        try:
            return bytes(raw_path).decode("ascii")
        except UnicodeDecodeError:
            return request.url.path
    return request.url.path


def upstream_path_from_raw_request(request: Request, strip_prefix: str = "") -> str:
    raw_path = _request_raw_path(request)
    if strip_prefix and raw_path.startswith(strip_prefix):
        raw_path = raw_path[len(strip_prefix):]
    return _normalize_upstream_path(raw_path)


def compose_upstream_path(prefix: str, path: str = "") -> str:
    parts = [prefix.strip("/")]
    if path:
        parts.append(path.lstrip("/"))
    joined = "/".join(part for part in parts if part)
    return f"/{joined}" if joined else "/"


async def proxy_http_request(request: Request, upstream_path: str) -> Response:
    client = await get_http_client()
    normalized_path = _normalize_upstream_path(upstream_path)
    target_url = (
        f"{normalized_path}?{request.url.query}"
        if request.url.query
        else normalized_path
    )

    body = await request.body() if request.method not in ("GET", "HEAD") else None

    request_headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower()
        not in (
            "host",
            "content-length",
            "transfer-encoding",
            "connection",
            "origin",
            "referer",
        )
    }

    try:
        resp = await client.request(
            method=request.method,
            url=target_url,
            content=body,
            headers=request_headers,
        )
    except httpx.RequestError as exc:
        return Response(
            status_code=502,
            content=f"ComfyUI proxy request failed: {exc.__class__.__name__}",
            media_type="text/plain",
        )

    response_headers = {
        key: value
        for key, value in resp.headers.items()
        if key.lower() not in ("content-encoding", "transfer-encoding", "content-length", "connection")
    }

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=response_headers,
        media_type=resp.headers.get("content-type"),
    )


def _build_comfyui_ws_url(upstream_path: str, query: str) -> str:
    parsed = urllib.parse.urlparse(get_comfyui_url())
    ws_scheme = "wss" if parsed.scheme == "https" else "ws"
    base_path = parsed.path.rstrip("/")
    ws_path = f"{base_path}{_normalize_upstream_path(upstream_path)}" if base_path else _normalize_upstream_path(upstream_path)
    return urllib.parse.urlunparse((ws_scheme, parsed.netloc, ws_path, "", query, ""))


async def proxy_websocket(ws: WebSocket, upstream_path: str = "/ws"):
    await ws.accept()

    query_pairs = list(ws.query_params.multi_items())
    if not any(key == "clientId" for key, _ in query_pairs):
        query_pairs.append(("clientId", str(uuid.uuid4())))
    ws_query = urllib.parse.urlencode(query_pairs)

    comfy_ws_url = _build_comfyui_ws_url(upstream_path, ws_query)

    try:
        async with websockets.connect(
            comfy_ws_url,
            # SaveImageWebsocket can emit large full-size images; the websocket
            # client's default max_size (1 MiB) is too low and can close the
            # upstream connection mid-run.
            max_size=None,
            max_queue=None,
        ) as comfy_ws:
            async def forward_comfy_to_client():
                try:
                    async for message in comfy_ws:
                        try:
                            if isinstance(message, str):
                                await ws.send_text(message)
                            elif isinstance(message, (bytes, bytearray, memoryview)):
                                # websockets can surface binary frames as bytes-like
                                # types. FastAPI expects bytes for send_bytes.
                                await ws.send_bytes(bytes(message))
                            else:
                                # Defensive fallback for unexpected frame payloads.
                                await ws.send_text(str(message))
                        except (WebSocketDisconnect, RuntimeError, OSError):
                            break
                except websockets.ConnectionClosed:
                    pass

            async def forward_client_to_comfy():
                try:
                    while True:
                        data = await ws.receive()
                        if data["type"] == "websocket.receive":
                            if "text" in data and data["text"] is not None:
                                await comfy_ws.send(data["text"])
                            elif "bytes" in data and data["bytes"] is not None:
                                await comfy_ws.send(data["bytes"])
                        elif data["type"] == "websocket.disconnect":
                            break
                except (WebSocketDisconnect, RuntimeError, OSError, websockets.ConnectionClosed):
                    pass

            _, pending = await asyncio.wait(
                [
                    asyncio.create_task(forward_comfy_to_client()),
                    asyncio.create_task(forward_client_to_comfy()),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )

            for task in pending:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    except Exception as e:
        try:
            print(f"Error connecting to ComfyUI WS at {comfy_ws_url}: {e}")
            if (
                ws.client_state == WebSocketState.CONNECTED
                and ws.application_state == WebSocketState.CONNECTED
            ):
                await ws.send_json({"type": "error", "data": {"message": f"ComfyUI connection failed: {e}"}})
        except Exception:
            pass
    finally:
        try:
            if ws.application_state != WebSocketState.DISCONNECTED:
                await ws.close()
        except Exception:
            pass
