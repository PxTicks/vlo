import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import services.comfyui.comfyui_client as comfyui_client


class _FakeClient:
    def __init__(self) -> None:
        self.is_closed = False

    async def aclose(self) -> None:
        self.is_closed = True


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_comfyui_url_is_persisted_and_available_after_reload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    override_path = tmp_path / "comfyui_url.json"
    monkeypatch.setattr(comfyui_client, "_URL_OVERRIDE_PATH", override_path)
    monkeypatch.setattr(comfyui_client, "_comfyui_url", "http://old.local")
    monkeypatch.setattr(comfyui_client, "_http_client", None)

    await comfyui_client.set_comfyui_url("https://new.local/")

    assert comfyui_client.get_comfyui_url() == "https://new.local"
    assert comfyui_client._load_persisted_url() == "https://new.local"
    assert json.loads(override_path.read_text(encoding="utf-8")) == {
        "comfyui_url": "https://new.local"
    }


@pytest.mark.anyio
async def test_replaced_comfyui_client_closes_after_grace_period(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    old_client = _FakeClient()
    started = asyncio.Event()
    release = asyncio.Event()
    original_sleep = asyncio.sleep

    async def _controlled_sleep(delay: float) -> None:
        assert delay == comfyui_client._CLIENT_CLOSE_GRACE_SECONDS
        started.set()
        await release.wait()

    monkeypatch.setattr(
        comfyui_client,
        "_URL_OVERRIDE_PATH",
        tmp_path / "comfyui_url.json",
    )
    monkeypatch.setattr(comfyui_client, "_comfyui_url", "http://old.local")
    monkeypatch.setattr(comfyui_client, "_http_client", old_client)
    monkeypatch.setattr(comfyui_client.asyncio, "sleep", _controlled_sleep)

    await comfyui_client.set_comfyui_url("http://new.local")
    await started.wait()
    assert old_client.is_closed is False

    release.set()
    for _ in range(10):
        if old_client.is_closed:
            break
        await original_sleep(0)

    assert old_client.is_closed is True
