import asyncio
import json

import pytest
from fastapi import Response
from fastapi.responses import FileResponse
from starlette.requests import Request

from routers import comfyui_compat


def _request(path: str, method: str = "GET") -> Request:
    raw_path = path.encode("ascii")
    return Request(
        {
            "type": "http",
            "method": method,
            "path": path,
            "raw_path": raw_path,
            "query_string": b"",
            "headers": [],
            "server": ("testserver", 80),
            "scheme": "http",
        }
    )


@pytest.mark.parametrize("path", ["api/extensions", "extensions"])
def test_iframe_extension_list_hosts_bridge_first_and_filters_installed_copy(
    monkeypatch: pytest.MonkeyPatch,
    path: str,
) -> None:
    async def fake_proxy(_request: Request, _upstream_path: str) -> Response:
        return Response(
            content=json.dumps(
                [
                    "/extensions/example/example.js",
                    "/extensions/ComfyUI-vlo/vlo-bridge.js",
                    "/extensions/vlo-host/vlo-bridge.js",
                ]
            ),
            media_type="application/json",
        )

    monkeypatch.setattr(comfyui_compat, "proxy_http_request", fake_proxy)
    response = asyncio.run(
        comfyui_compat.proxy_comfyui_frame(
            _request(f"/comfyui-frame/{path}"), path
        )
    )

    payload = json.loads(bytes(response.body))
    assert payload == [
        "/extensions/vlo-host/vlo-bridge.js",
        "/extensions/example/example.js",
    ]
    assert response.headers["cache-control"] == "no-store"


def test_iframe_extension_list_preserves_upstream_errors_and_malformed_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    responses = [
        Response(status_code=503, content="unavailable"),
        Response(status_code=200, content="not-json"),
    ]

    async def fake_proxy(_request: Request, _upstream_path: str) -> Response:
        return responses.pop(0)

    monkeypatch.setattr(comfyui_compat, "proxy_http_request", fake_proxy)
    error = asyncio.run(
        comfyui_compat.proxy_comfyui_frame(
            _request("/comfyui-frame/api/extensions"), "api/extensions"
        )
    )
    malformed = asyncio.run(
        comfyui_compat.proxy_comfyui_frame(
            _request("/comfyui-frame/api/extensions"), "api/extensions"
        )
    )

    assert error.status_code == 503
    assert bytes(error.body) == b"unavailable"
    assert bytes(malformed.body) == b"not-json"


def test_iframe_html_bootstraps_bridge_before_comfy_finishes_loading(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_proxy(_request: Request, _upstream_path: str) -> Response:
        return Response(
            content=(
                '<!doctype html><html><head><script type="module" '
                'src="./assets/index.js"></script></head><body></body></html>'
            ),
            media_type="text/html",
        )

    monkeypatch.setattr(comfyui_compat, "proxy_http_request", fake_proxy)
    response = asyncio.run(
        comfyui_compat.proxy_comfyui_frame(_request("/comfyui-frame/"), "")
    )

    body = bytes(response.body).decode("utf-8")
    bridge_tag = (
        '<script type="module" '
        'src="/comfyui-frame/extensions/vlo-host/vlo-bridge.js"></script>'
    )
    assert body.count(bridge_tag) == 1
    assert body.index(bridge_tag) < body.index("./assets/index.js")
    assert response.headers["cache-control"] == "no-store"


def test_iframe_html_decoration_leaves_non_html_responses_untouched() -> None:
    response = Response(content="unavailable", status_code=502)

    assert comfyui_compat._decorate_iframe_html(response) is response


@pytest.mark.parametrize(
    ("path", "filename"),
    [
        ("extensions/vlo-host/vlo-bridge.js", "vlo-bridge.js"),
        ("extensions/vlo-host/bridge-core.mjs", "bridge-core.mjs"),
    ],
)
def test_iframe_serves_allowlisted_bridge_assets(path: str, filename: str) -> None:
    response = asyncio.run(
        comfyui_compat.proxy_comfyui_frame(
            _request(f"/comfyui-frame/{path}"), path
        )
    )
    assert isinstance(response, FileResponse)
    assert str(response.path).endswith(filename)
    assert response.media_type == "text/javascript"
    assert response.headers["cache-control"] == "no-store"


def test_iframe_rejects_unknown_hosted_bridge_assets() -> None:
    response = asyncio.run(
        comfyui_compat.proxy_comfyui_frame(
            _request("/comfyui-frame/extensions/vlo-host/../secret.py"),
            "extensions/vlo-host/../secret.py",
        )
    )
    assert response.status_code == 404


def test_root_extension_proxy_is_not_decorated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen_paths: list[str] = []

    async def fake_proxy(_request: Request, upstream_path: str) -> Response:
        seen_paths.append(upstream_path)
        return Response(content='["/extensions/example.js"]', media_type="application/json")

    monkeypatch.setattr(comfyui_compat, "proxy_http_request", fake_proxy)
    response = asyncio.run(
        comfyui_compat.proxy_extensions_root(_request("/extensions"), "")
    )
    assert bytes(response.body) == b'["/extensions/example.js"]'
    assert seen_paths == ["/extensions"]
