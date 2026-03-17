import os
import sys
from typing import Any

import pytest

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.gen_pipeline import BackendPipelineContext  # noqa: E402
from services.gen_pipeline.processors.submit_prompt import (  # noqa: E402
    create_submit_prompt_processor,
)
from services.gen_pipeline.processors.utils.graph_metadata import (  # noqa: E402
    project_prompt_to_graph_data,
)
from services.workflow_rules.object_info import set_object_info_cache  # noqa: E402


class _FakeResponse:
    status_code = 200
    headers = {"content-type": "application/json"}
    content = b'{"prompt_id":"p1"}'


class _FakeClient:
    def __init__(self) -> None:
        self.payload: dict[str, Any] | None = None

    async def post(self, url: str, **kwargs):
        assert url == "/prompt"
        self.payload = kwargs.get("json")
        return _FakeResponse()


@pytest.fixture(autouse=True)
def object_info_cache_guard():
    set_object_info_cache({})
    yield
    set_object_info_cache(None)


def _object_info() -> dict[str, Any]:
    return {
        "LoadVideo": {
            "input": {
                "required": {
                    "file": ["STRING", {}],
                    "video-preview": ["STRING", {}],
                }
            },
            "input_order": {"required": ["file", "video-preview"]},
        },
        "CLIPTextEncode": {
            "input": {
                "required": {
                    "text": ["STRING", {}],
                    "clip": ["CLIP", {}],
                }
            },
            "input_order": {"required": ["text", "clip"]},
        },
        "KSampler": {
            "input": {
                "required": {
                    "seed": ["INT", {"control_after_generate": True}],
                    "steps": ["INT", {}],
                    "cfg": ["FLOAT", {}],
                    "sampler_name": [["euler", "uni_pc"], {}],
                    "scheduler": [["normal", "simple"], {}],
                    "denoise": ["FLOAT", {}],
                    "model": ["MODEL", {}],
                    "positive": ["CONDITIONING", {}],
                    "negative": ["CONDITIONING", {}],
                    "latent_image": ["LATENT", {}],
                }
            },
            "input_order": {
                "required": [
                    "seed",
                    "steps",
                    "cfg",
                    "sampler_name",
                    "scheduler",
                    "denoise",
                    "model",
                    "positive",
                    "negative",
                    "latent_image",
                ]
            },
        },
        "ResizeImageMaskNode": {
            "input": {
                "required": {
                    "resize_type": [["scale dimensions"], {}],
                    "resize_type.width": ["INT", {}],
                    "resize_type.height": ["INT", {}],
                    "resize_type.crop": [["disabled"], {}],
                    "scale_method": [["area"], {}],
                    "input": ["IMAGE", {}],
                }
            },
            "input_order": {
                "required": [
                    "resize_type",
                    "resize_type.width",
                    "resize_type.height",
                    "resize_type.crop",
                    "scale_method",
                    "input",
                ]
            },
        },
        "EmptyImage": {
            "input": {
                "required": {
                    "width": ["INT", {}],
                    "height": ["INT", {}],
                    "batch_size": ["INT", {}],
                    "color": ["INT", {}],
                }
            },
            "input_order": {
                "required": ["width", "height", "batch_size", "color"]
            },
        },
    }


def test_project_prompt_to_graph_data_preserves_linked_widget_defaults():
    set_object_info_cache(_object_info())

    workflow = {
        "1": {
            "class_type": "LoadVideo",
            "inputs": {"file": "uploaded_video.mp4", "video-preview": "image"},
        },
        "2": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "updated prompt", "clip": ["4", 0]},
        },
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 123456,
                "steps": 6,
                "cfg": 1.0,
                "sampler_name": "uni_pc",
                "scheduler": "simple",
                "denoise": 1.0,
                "model": ["4", 0],
                "positive": ["4", 0],
                "negative": ["4", 0],
                "latent_image": ["4", 0],
            },
        },
        "5": {"class_type": "Consumer", "inputs": {"input": ["6", 0]}},
        "7": {
            "class_type": "ResizeImageMaskNode",
            "inputs": {
                "resize_type": "scale dimensions",
                "resize_type.width": 1280,
                "resize_type.height": 720,
                "resize_type.crop": "disabled",
                "scale_method": "area",
                "input": ["4", 0],
            },
        },
        "8": {
            "class_type": "EmptyImage",
            "inputs": {
                "width": ["4", 0],
                "height": ["4", 1],
                "batch_size": ["4", 2],
                "color": 8355711,
            },
        },
    }
    graph_data = {
        "last_link_id": 20,
        "nodes": [
            {
                "id": 1,
                "type": "LoadVideo",
                "inputs": [],
                "outputs": [{"name": "VIDEO", "links": None}],
                "widgets_values": ["default.mp4", "image"],
            },
            {
                "id": 2,
                "type": "CLIPTextEncode",
                "inputs": [{"name": "clip", "type": "CLIP", "link": 11}],
                "outputs": [],
                "widgets_values": ["old prompt"],
            },
            {
                "id": 3,
                "type": "KSampler",
                "inputs": [
                    {"name": "model", "type": "MODEL", "link": 13},
                    {"name": "positive", "type": "CONDITIONING", "link": 14},
                    {"name": "negative", "type": "CONDITIONING", "link": 15},
                    {"name": "latent_image", "type": "LATENT", "link": 16},
                ],
                "outputs": [],
                "widgets_values": [0, "randomize", 20, 1, "euler", "normal", 1],
            },
            {
                "id": 4,
                "type": "Source",
                "inputs": [],
                "outputs": [
                    {"name": "OUT0", "links": [11, 12, 13, 14, 15, 16, 20]},
                    {"name": "OUT1", "links": [18]},
                    {"name": "OUT2", "links": [19]},
                ],
            },
            {
                "id": 5,
                "type": "Consumer",
                "inputs": [{"name": "input", "type": "IMAGE", "link": 12}],
                "outputs": [],
            },
            {
                "id": 6,
                "type": "Source",
                "inputs": [],
                "outputs": [{"name": "OUT0", "links": None}],
            },
            {
                "id": 7,
                "type": "ResizeImageMaskNode",
                "inputs": [{"name": "input", "type": "IMAGE,MASK", "link": 20}],
                "outputs": [],
                "widgets_values": ["scale dimensions", 512, 512, "disabled", "area"],
            },
            {
                "id": 8,
                "type": "EmptyImage",
                "inputs": [
                    {
                        "name": "width",
                        "type": "INT",
                        "widget": {"name": "width"},
                        "link": 17,
                    },
                    {
                        "name": "height",
                        "type": "INT",
                        "widget": {"name": "height"},
                        "link": 18,
                    },
                    {
                        "name": "batch_size",
                        "type": "INT",
                        "widget": {"name": "batch_size"},
                        "link": 19,
                    },
                ],
                "outputs": [],
                "widgets_values": [512, 512, 1, 0],
            },
        ],
        "links": [
            [11, 4, 0, 2, 0, "CLIP"],
            [12, 4, 0, 5, 0, "IMAGE"],
            [13, 4, 0, 3, 0, "MODEL"],
            [14, 4, 0, 3, 1, "CONDITIONING"],
            [15, 4, 0, 3, 2, "CONDITIONING"],
            [16, 4, 0, 3, 3, "LATENT"],
            [17, 4, 0, 8, 0, "INT"],
            [18, 4, 1, 8, 1, "INT"],
            [19, 4, 2, 8, 2, "INT"],
            [20, 4, 0, 7, 0, "IMAGE,MASK"],
        ],
    }

    projected = project_prompt_to_graph_data(workflow, graph_data)

    assert projected is not None
    node_by_id = {
        str(node["id"]): node
        for node in projected["nodes"]
        if isinstance(node, dict) and "id" in node
    }

    assert node_by_id["1"]["widgets_values"][0] == "uploaded_video.mp4"
    assert node_by_id["2"]["widgets_values"][0] == "updated prompt"
    assert node_by_id["3"]["widgets_values"][0] == 123456
    assert node_by_id["3"]["widgets_values"][1] == "randomize"
    assert node_by_id["7"]["widgets_values"] == [
        "scale dimensions",
        1280,
        720,
        "disabled",
        "area",
    ]
    assert node_by_id["8"]["widgets_values"] == [512, 512, 1, 8355711]
    assert node_by_id["5"]["inputs"][0]["link"] == 12
    assert node_by_id["4"]["outputs"][0]["links"] == [11, 13, 14, 15, 16, 20]
    assert node_by_id["6"]["outputs"][0]["links"] == [12]
    assert [12, 6, 0, 5, 0, "IMAGE"] in projected["links"]


@pytest.mark.anyio
async def test_submit_prompt_sends_native_extra_pnginfo_workflow_only():
    set_object_info_cache(_object_info())

    fake_client = _FakeClient()
    processor = create_submit_prompt_processor(lambda: "prompt-1")
    ctx = BackendPipelineContext(
        client=fake_client,
        client_id="client-1",
        workflow={
            "1": {
                "class_type": "LoadVideo",
                "inputs": {"file": "uploaded_video.mp4", "video-preview": "image"},
            }
        },
        graph_data={
            "nodes": [
                {
                    "id": 1,
                    "type": "LoadVideo",
                    "inputs": [],
                    "outputs": [],
                    "widgets_values": ["default.mp4", "image"],
                }
            ],
            "links": [],
        },
    )

    await processor.execute(ctx)

    assert fake_client.payload is not None
    assert fake_client.payload["prompt"] == ctx.workflow
    assert fake_client.payload["prompt_id"] == "prompt-1"
    assert "prompt" not in fake_client.payload["extra_data"]["extra_pnginfo"]
    assert fake_client.payload["extra_data"]["extra_pnginfo"]["workflow"]["nodes"][0][
        "widgets_values"
    ][0] == "uploaded_video.mp4"


@pytest.mark.anyio
async def test_submit_prompt_omits_extra_data_without_graph_data():
    fake_client = _FakeClient()
    processor = create_submit_prompt_processor(lambda: "prompt-2")
    ctx = BackendPipelineContext(
        client=fake_client,
        client_id="client-2",
        workflow={"1": {"class_type": "LoadVideo", "inputs": {"file": "clip.mp4"}}},
    )

    await processor.execute(ctx)

    assert fake_client.payload is not None
    assert "extra_data" not in fake_client.payload
