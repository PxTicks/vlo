import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI, Response
from fastapi.responses import FileResponse
from starlette.requests import Request

from routers import comfyui_compat, generation_delivery


def _request(
    path: str,
    method: str = "GET",
    *,
    body: bytes = b"",
    headers: dict[str, str] | None = None,
) -> Request:
    raw_path = path.encode("ascii")
    request_headers = [
        (key.lower().encode("ascii"), value.encode("utf-8"))
        for key, value in (headers or {}).items()
    ]

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        {
            "type": "http",
            "method": method,
            "path": path,
            "raw_path": raw_path,
            "query_string": b"",
            "headers": request_headers,
            "server": ("testserver", 80),
            "scheme": "http",
        },
        receive,
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


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("request_path", "expected_upstream"),
    [
        ("/comfyui-frame/api/prompt", "/api/prompt"),
        ("/api/prompt", "/api/prompt"),
        ("/prompt", "/prompt"),
    ],
)
async def test_registered_iframe_prompt_routes_are_adopted_at_submission_time(
    monkeypatch: pytest.MonkeyPatch,
    request_path: str,
    expected_upstream: str,
) -> None:
    prompt = {"7": {"class_type": "LoadImage", "inputs": {"image": "a.png"}}}
    workflow = {"nodes": [{"id": 7, "type": "LoadImage"}], "links": []}
    request_payload = {
        "prompt": prompt,
        "client_id": "iframe-client",
        "extra_data": {"extra_pnginfo": {"workflow": workflow}},
    }
    adopted: list[dict] = []
    upstream_paths: list[str] = []
    bindings: dict[str, str] = {}

    async def fake_proxy(_request: Request, upstream_path: str) -> Response:
        upstream_paths.append(upstream_path)
        return Response(
            content=json.dumps({"prompt_id": "prompt-1", "number": 4}),
            media_type="application/json",
        )

    async def fake_project_for_client(client_id: str) -> str | None:
        return bindings.get(client_id)

    async def fake_register_client(
        *,
        client_id: str,
        project_id: str,
        binding_version: int,
    ) -> str:
        assert binding_version == 7
        bindings[client_id] = project_id
        return project_id

    async def fake_adopt(**kwargs):
        adopted.append(kwargs)
        return {}

    monkeypatch.setattr(comfyui_compat, "proxy_http_request", fake_proxy)
    monkeypatch.setattr(
        comfyui_compat.generation_holding_service,
        "adopt_delivery",
        fake_adopt,
    )
    monkeypatch.setattr(
        comfyui_compat.generation_holding_service,
        "get_iframe_client_project",
        fake_project_for_client,
    )
    monkeypatch.setattr(
        generation_delivery.generation_holding_service,
        "register_iframe_client_project",
        fake_register_client,
    )
    app = FastAPI()
    app.include_router(generation_delivery.router)
    app.include_router(comfyui_compat.compat_router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        registration = await client.put(
            "/app/generation-delivery/projects/project-1/iframe-clients/iframe-client",
            json={"binding_version": 7},
        )
        response = await client.post(
            request_path,
            json=request_payload,
        )

    assert registration.status_code == 200
    assert registration.json()["accepted"] is True
    assert response.status_code == 200
    assert upstream_paths == [expected_upstream]
    assert adopted == [
        {
            "project_id": "project-1",
            "prompt_id": "prompt-1",
            "client_id": "iframe-client",
            "generation_metadata": {
                "comfyuiPrompt": prompt,
                "comfyuiWorkflow": workflow,
            },
        }
    ]


@pytest.mark.anyio
async def test_unregistered_prompt_client_is_not_adopted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adopted: list[dict] = []

    async def fake_proxy(_request: Request, _upstream_path: str) -> Response:
        return Response(
            content=json.dumps({"prompt_id": "prompt-1"}),
            media_type="application/json",
        )

    async def fake_adopt(**kwargs):
        adopted.append(kwargs)
        return {}

    async def no_registered_project(_client_id: str) -> None:
        return None

    monkeypatch.setattr(comfyui_compat, "proxy_http_request", fake_proxy)
    monkeypatch.setattr(
        comfyui_compat.generation_holding_service,
        "adopt_delivery",
        fake_adopt,
    )
    monkeypatch.setattr(
        comfyui_compat.generation_holding_service,
        "get_iframe_client_project",
        no_registered_project,
    )
    app = FastAPI()
    app.include_router(comfyui_compat.compat_router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.post(
            "/comfyui-frame/api/prompt",
            json={"prompt": {}, "client_id": "other"},
        )

    assert response.status_code == 200
    assert adopted == []


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
