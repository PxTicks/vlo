import json
from pathlib import Path

import pytest

from services.generation_delivery.service import (
    GenerationHoldingService,
    _ProjectConsumer,
)


class _FakeWebSocket:
    def __init__(self) -> None:
        self.accepted = False
        self.sent_payloads: list[dict] = []

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, payload: dict) -> None:
        self.sent_payloads.append(payload)


def _delivery_context() -> dict:
    return {
        "plan_id": "plan-1",
        "workflow_name": "Workflow One",
        "workflow_source_id": "wf.json",
        "generation_metadata": {
            "source": "generated",
            "workflowName": "Workflow One",
            "inputs": [],
        },
        "postprocess_config": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
        "auto_family_request_key": "generation-family-request:v1:test",
        "uses_save_image_websocket_outputs": True,
        "replay_inputs": {"replayState": {"version": 2}},
    }


@pytest.mark.asyncio
async def test_generation_holding_service_persists_and_acknowledges_delivery(
    tmp_path: Path,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")

    await service.create_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
        delivery_context=_delivery_context(),
    )
    await service.update_submission_metadata(
        delivery_id="delivery-1",
        workflow_warnings=[{"code": "warning"}],
        applied_widget_values={"145:seed": "123"},
        aspect_ratio_processing={"enabled": True},
        generation_metadata={
            "source": "generated",
            "workflowName": "Workflow One",
            "inputs": [],
            "maskCropMetadata": {"mode": "crop"},
        },
        prepared_mask_bytes=b"mask-bytes",
        prepared_mask_filename="prepared-mask.webm",
        prepared_mask_content_type="video/webm",
    )

    deliveries = await service.list_project_deliveries("project-1")
    assert len(deliveries) == 1
    delivery = deliveries[0]
    assert delivery["delivery_id"] == "delivery-1"
    assert delivery["workflow_name"] == "Workflow One"
    assert delivery["uses_save_image_websocket_outputs"] is True
    assert delivery["workflow_warnings"] == [{"code": "warning"}]
    assert delivery["applied_widget_values"] == {"145:seed": "123"}
    assert delivery["aspect_ratio_processing"] == {"enabled": True}
    assert delivery["prepared_mask"]["filename"] == "prepared-mask.webm"

    stored_manifest = service._deliveries["delivery-1"]
    prepared_mask = stored_manifest["prepared_mask"]
    prepared_mask_path = await service.get_delivery_file_path(
        "project-1",
        "delivery-1",
        "mask",
        prepared_mask["storage_name"],
    )
    assert prepared_mask_path is not None
    assert prepared_mask_path.read_bytes() == b"mask-bytes"

    assert await service.acknowledge_delivery("project-1", "delivery-1") is True
    assert await service.list_project_deliveries("project-1") == []
    assert not (tmp_path / "holding" / "project-1" / "delivery-1").exists()


@pytest.mark.asyncio
async def test_generation_holding_service_keeps_nacked_delivery_pending(
    tmp_path: Path,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")

    await service.create_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
        delivery_context=_delivery_context(),
    )
    await service.record_delivery_nack("delivery-1", "Frontend ingest failed")

    delivery = await service.get_delivery("project-1", "delivery-1")
    assert delivery is not None
    assert delivery["last_delivery_error"] == "Frontend ingest failed"


@pytest.mark.asyncio
async def test_generation_holding_service_marks_stale_inflight_delivery_on_load(
    tmp_path: Path,
) -> None:
    root = tmp_path / "holding"
    manifest_root = root / "project-1" / "delivery-1"
    manifest_root.mkdir(parents=True, exist_ok=True)
    (manifest_root / "manifest.json").write_text(
        json.dumps(
            {
                "delivery_id": "delivery-1",
                "project_id": "project-1",
                "prompt_id": "prompt-1",
                "client_id": "client-1",
                "status": "queued",
                "progress": 0,
                "current_node": None,
                "error": None,
                "created_at": 1,
                "updated_at": 1,
                "submitted_at": 1,
                "completed_at": None,
                "plan_id": "plan-1",
                "workflow_name": "Workflow One",
                "workflow_source_id": "wf.json",
                "generation_metadata": {},
                "postprocess_config": {},
                "auto_family_request_key": None,
                "uses_save_image_websocket_outputs": False,
                "delivery_context": {},
                "workflow_warnings": [],
                "applied_widget_values": {},
                "aspect_ratio_processing": None,
                "outputs": [],
                "preview_frames": [],
                "prepared_mask": None,
                "last_delivery_error": None,
            }
        ),
        encoding="utf-8",
    )

    service = GenerationHoldingService(root=root)
    deliveries = await service.list_project_deliveries("project-1")

    assert len(deliveries) == 1
    assert deliveries[0]["status"] == "error"
    assert deliveries[0]["error"] == "Backend restarted before delivery completed"


@pytest.mark.asyncio
async def test_generation_holding_service_project_lease_switches_to_latest_consumer(
    tmp_path: Path,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")
    await service.create_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
        delivery_context=_delivery_context(),
    )

    ws_one = _FakeWebSocket()
    consumer_one = _ProjectConsumer("project-1", ws_one)
    await service._register_consumer(consumer_one)

    assert ws_one.sent_payloads[0] == {
        "type": "lease_state",
        "data": {"project_id": "project-1", "active": True},
    }
    assert ws_one.sent_payloads[1]["type"] == "snapshot"
    assert ws_one.sent_payloads[1]["data"]["deliveries"][0]["delivery_id"] == "delivery-1"

    ws_two = _FakeWebSocket()
    consumer_two = _ProjectConsumer("project-1", ws_two)
    await service._register_consumer(consumer_two)

    assert ws_one.sent_payloads[-1] == {
        "type": "lease_state",
        "data": {"project_id": "project-1", "active": False},
    }
    assert ws_two.sent_payloads[0] == {
        "type": "lease_state",
        "data": {"project_id": "project-1", "active": True},
    }
    assert ws_two.sent_payloads[1]["type"] == "snapshot"

    await service._unregister_consumer(consumer_two)

    assert ws_one.sent_payloads[-2] == {
        "type": "lease_state",
        "data": {"project_id": "project-1", "active": True},
    }
    assert ws_one.sent_payloads[-1]["type"] == "snapshot"
