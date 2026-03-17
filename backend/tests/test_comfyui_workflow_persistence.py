import asyncio
import json
import os
import sys

import pytest

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routers import comfyui


class DummyRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


def test_save_workflow_content_persists_to_backend_workflows_dir(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(comfyui, "WORKFLOWS_DIR", tmp_path)
    monkeypatch.setattr(
        comfyui,
        "OBJECT_INFO_PATH",
        tmp_path / ".config" / "object_info.json",
    )

    payload = {
        "workflow": {"nodes": [{"id": 1}], "extra": {"source": "test"}},
        "object_info": {"LoadImage": {"input": {}}},
    }
    result = asyncio.run(
        comfyui.save_workflow_content(
            "wf.json", DummyRequest(payload)
        )
    )

    assert result == {
        "workflow_id": "wf.json",
        "saved": True,
        "object_info_saved": True,
    }
    assert json.loads((tmp_path / "wf.json").read_text(encoding="utf-8")) == {
        "nodes": [{"id": 1}],
        "extra": {"source": "test"},
    }
    assert json.loads(
        (tmp_path / ".config" / "object_info.json").read_text(encoding="utf-8")
    ) == {"LoadImage": {"input": {}}}
