import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import services.generation_delivery.service as delivery_service_module
from services.generation_delivery.service import (
    BINARY_PREVIEW_IMAGE,
    GenerationHoldingService,
    PREVIEW_METADATA_FEATURE_FLAGS,
    _ProjectConsumer,
    _extract_history_error,
    _parse_queue_prompt_ids,
)


class _FakeWebSocket:
    def __init__(self) -> None:
        self.accepted = False
        self.sent_payloads: list[dict] = []

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, payload: dict) -> None:
        self.sent_payloads.append(payload)


class _FakeComfyWebSocket:
    def __init__(self, messages: list[str | bytes]) -> None:
        self.messages = messages
        self.sent_messages: list[str | bytes] = []

    async def send(self, message: str | bytes) -> None:
        self.sent_messages.append(message)

    def __aiter__(self):
        self._message_iter = iter(self.messages)
        return self

    async def __anext__(self):
        try:
            return next(self._message_iter)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class _FakeComfyConnect:
    def __init__(self, websocket: _FakeComfyWebSocket) -> None:
        self.websocket = websocket

    async def __aenter__(self) -> _FakeComfyWebSocket:
        return self.websocket

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None


class _FakeResponse:
    def __init__(self, payload: object) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> object:
        return self._payload


class _FakeHttpClient:
    def __init__(self, responses: dict[str, object]) -> None:
        self._responses = responses

    async def get(self, path: str) -> _FakeResponse:
        return _FakeResponse(self._responses[path])


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
        "uses_save_image_websocket_outputs": False,
        "replay_inputs": {"replayState": {"version": 2}},
    }


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
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
        prepared_mask_filename="prepared-mask.mp4",
        prepared_mask_content_type="video/mp4",
    )

    deliveries = await service.list_project_deliveries("project-1")
    assert len(deliveries) == 1
    delivery = deliveries[0]
    assert delivery["delivery_id"] == "delivery-1"
    assert delivery["workflow_name"] == "Workflow One"
    assert delivery["uses_save_image_websocket_outputs"] is False
    assert delivery["workflow_warnings"] == [{"code": "warning"}]
    assert delivery["applied_widget_values"] == {"145:seed": "123"}
    assert delivery["aspect_ratio_processing"] == {"enabled": True}
    assert delivery["prepared_mask"]["filename"] == "prepared-mask.mp4"
    assert delivery["preview_frames"] == []

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


@pytest.mark.anyio
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


@pytest.mark.anyio
async def test_generation_holding_service_resyncs_all_persisted_deliveries_across_instances(
    tmp_path: Path,
) -> None:
    root = tmp_path / "holding"
    writer = GenerationHoldingService(root=root)
    reader = GenerationHoldingService(root=root)

    await writer.create_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
        delivery_context=_delivery_context(),
    )
    await writer.mark_completed("delivery-1", [])

    initial = await reader.list_project_deliveries("project-1")
    assert [delivery["delivery_id"] for delivery in initial] == ["delivery-1"]
    assert initial[0]["status"] == "completed_pending_ack"

    await writer.record_delivery_nack("delivery-1", "Frontend ingest failed")
    await writer.create_delivery(
        project_id="project-1",
        delivery_id="delivery-2",
        prompt_id="prompt-2",
        client_id="client-2",
        delivery_context=_delivery_context(),
    )
    await writer.mark_completed("delivery-2", [])

    refreshed = await reader.list_project_deliveries("project-1")

    assert [delivery["delivery_id"] for delivery in refreshed] == [
        "delivery-1",
        "delivery-2",
    ]
    assert [delivery["status"] for delivery in refreshed] == [
        "completed_pending_ack",
        "completed_pending_ack",
    ]
    assert refreshed[0]["last_delivery_error"] == "Frontend ingest failed"


@pytest.mark.anyio
async def test_generation_holding_service_reattaches_inflight_delivery_on_load(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
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
                "prepared_mask": None,
                "last_delivery_error": None,
            }
        ),
        encoding="utf-8",
    )

    connect_calls: list[str] = []
    fake_comfy_ws = _FakeComfyWebSocket([])

    def _fake_connect(url: str, *args, **kwargs):
        connect_calls.append(url)
        return _FakeComfyConnect(fake_comfy_ws)

    monkeypatch.setattr(
        delivery_service_module.websockets,
        "connect",
        _fake_connect,
    )

    service = GenerationHoldingService(root=root)
    deliveries = await service.list_project_deliveries("project-1")

    # Inflight deliveries are no longer force-errored on load; a monitor is
    # re-attached and the reconcile backstop settles them from history/queue.
    assert len(deliveries) == 1
    assert deliveries[0]["status"] == "queued"
    assert "delivery-1" in service._monitor_tasks

    # The monitor runs as a background task; yield so it reaches connect.
    for _ in range(20):
        if connect_calls:
            break
        await asyncio.sleep(0)
    assert connect_calls and "client-1" in connect_calls[0]

    await service.cancel_monitor("delivery-1")


@pytest.mark.anyio
async def test_generation_holding_service_captures_websocket_outputs_and_finalizes(
    tmp_path: Path,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")
    context = _delivery_context()
    context["uses_save_image_websocket_outputs"] = True
    context["save_image_websocket_node_ids"] = ["42"]

    await service.create_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
        delivery_context=context,
    )

    png_bytes = b"\x89PNG\r\n\x1a\nbody"
    frame = (
        BINARY_PREVIEW_IMAGE.to_bytes(4, "big")
        + (2).to_bytes(4, "big")
        + png_bytes
    )

    captured_one = await service._capture_websocket_output(
        "project-1", "delivery-1", frame, 0
    )
    captured_two = await service._capture_websocket_output(
        "project-1", "delivery-1", frame, 1
    )
    assert captured_one is not None and captured_two is not None

    captured_path = await service.get_delivery_file_path(
        "project-1",
        "delivery-1",
        "preview_frames",
        captured_one["storage_name"],
    )
    assert captured_path is not None
    assert captured_path.read_bytes() == png_bytes
    assert captured_one["mime_type"] == "image/png"

    await service._finalize_delivery(
        "project-1",
        "delivery-1",
        "prompt-1",
        [captured_one, captured_two],
    )

    deliveries = await service.list_project_deliveries("project-1")
    assert len(deliveries) == 1
    delivery = deliveries[0]
    assert delivery["status"] == "completed_pending_ack"
    assert len(delivery["outputs"]) == 1
    assert delivery["outputs"][0]["filename"].startswith("ws-000001")
    assert delivery["outputs"][0]["viewUrl"].startswith(
        "/app/generation-delivery/projects/project-1/deliveries/delivery-1/files/preview_frames/"
    )
    assert len(delivery["preview_frames"]) == 2
    assert delivery["preview_frames"][0]["filename"].startswith("ws-000000")
    assert delivery["preview_frames"][1]["filename"].startswith("ws-000001")


@pytest.mark.anyio
async def test_generation_holding_service_captures_offset_four_websocket_images(
    tmp_path: Path,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")
    context = _delivery_context()
    context["uses_save_image_websocket_outputs"] = True

    await service.create_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
        delivery_context=context,
    )

    png_bytes = b"\x89PNG\r\n\x1a\noffset-four"
    frame = BINARY_PREVIEW_IMAGE.to_bytes(4, "big") + png_bytes

    captured = await service._capture_websocket_output(
        "project-1", "delivery-1", frame, 0
    )

    assert captured is not None
    assert captured["filename"] == "ws-000000.png"
    assert captured["mime_type"] == "image/png"
    captured_path = await service.get_delivery_file_path(
        "project-1",
        "delivery-1",
        "preview_frames",
        captured["storage_name"],
    )
    assert captured_path is not None
    assert captured_path.read_bytes() == png_bytes


@pytest.mark.anyio
async def test_generation_holding_service_scans_preview_header_for_image_payload(
    tmp_path: Path,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")
    context = _delivery_context()
    context["uses_save_image_websocket_outputs"] = True

    await service.create_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
        delivery_context=context,
    )

    jpeg_bytes = b"\xff\xd8\xff\xdbjpeg"
    frame = (
        BINARY_PREVIEW_IMAGE.to_bytes(4, "big")
        + b"custom-preview-header"
        + jpeg_bytes
    )

    captured = await service._capture_websocket_output(
        "project-1", "delivery-1", frame, 0
    )

    assert captured is not None
    assert captured["filename"] == "ws-000000.jpg"
    assert captured["mime_type"] == "image/jpeg"
    captured_path = await service.get_delivery_file_path(
        "project-1",
        "delivery-1",
        "preview_frames",
        captured["storage_name"],
    )
    assert captured_path is not None
    assert captured_path.read_bytes() == jpeg_bytes


@pytest.mark.anyio
async def test_generation_holding_service_errors_when_no_websocket_outputs_captured(
    tmp_path: Path,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")
    context = _delivery_context()
    context["uses_save_image_websocket_outputs"] = True
    context["save_image_websocket_node_ids"] = ["42"]

    await service.create_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
        delivery_context=context,
    )
    await service._finalize_delivery(
        "project-1", "delivery-1", "prompt-1", []
    )
    delivery = await service.get_delivery("project-1", "delivery-1")
    assert delivery is not None
    assert delivery["status"] == "error"


@pytest.mark.anyio
async def test_generation_monitor_requests_preview_metadata_feature_flag(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")
    fake_comfy_ws = _FakeComfyWebSocket(
        [
            json.dumps(
                {
                    "type": "execution_interrupted",
                    "data": {
                        "prompt_id": "prompt-1",
                        "node_id": "node-1",
                        "node_type": "KSampler",
                        "executed": [],
                    },
                }
            )
        ]
    )

    monkeypatch.setattr(
        delivery_service_module.websockets,
        "connect",
        lambda *args, **kwargs: _FakeComfyConnect(fake_comfy_ws),
    )

    await service.create_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
        delivery_context=_delivery_context(),
    )
    await service._monitor_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
    )

    assert fake_comfy_ws.sent_messages == [PREVIEW_METADATA_FEATURE_FLAGS]


@pytest.mark.anyio
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


def test_queue_prompt_parser_accepts_tuple_and_dictionary_entries() -> None:
    queue = {
        "queue_running": [[1, "tuple-running", {}, {}, []]],
        "queue_pending": [
            (2, "tuple-pending", {}, {}, []),
            {"prompt_id": "dictionary-pending"},
            {"prompt_id": 42},
        ],
    }

    assert _parse_queue_prompt_ids(queue) == {
        "tuple-running",
        "tuple-pending",
        "dictionary-pending",
    }


@pytest.mark.parametrize(
    ("messages", "expected"),
    [
        (
            [["execution_error", {"exception_message": "Model failed"}]],
            "Model failed",
        ),
        ([["execution_interrupted", {}]], "Generation interrupted"),
    ],
)
def test_history_error_parser_reports_failures_and_interruptions(
    messages: list[object],
    expected: str,
) -> None:
    assert (
        _extract_history_error(
            {"status": {"status_str": "error", "messages": messages}}
        )
        == expected
    )


@pytest.mark.anyio
async def test_generation_monitor_history_backstop_handles_every_missed_event(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")
    finalized = asyncio.Event()

    async def _finalize(*_args, **_kwargs) -> None:
        finalized.set()

    async def _completed(_prompt_id: str) -> tuple[str, str | None]:
        return "completed", None

    monkeypatch.setattr(service, "_finalize_delivery", _finalize)
    monkeypatch.setattr(service, "_reconcile_prompt_state", _completed)
    monkeypatch.setattr(
        delivery_service_module,
        "MONITOR_BACKSTOP_INITIAL_DELAY_SECONDS",
        0,
    )
    monkeypatch.setattr(
        delivery_service_module,
        "MONITOR_RECONNECT_ATTEMPTS",
        0,
    )
    monkeypatch.setattr(
        delivery_service_module.websockets,
        "connect",
        lambda *_args, **_kwargs: _FakeComfyConnect(_FakeComfyWebSocket([])),
    )

    await service._monitor_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
    )

    assert finalized.is_set()


@pytest.mark.anyio
async def test_backstop_only_monitor_never_opens_a_websocket(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Adopted in-editor generations must not open a socket on the iframe's
    client_id (that would steal the iframe's own job events); they settle from
    history/queue polling only."""
    service = GenerationHoldingService(root=tmp_path / "holding")
    finalized = asyncio.Event()

    async def _finalize(*_args, **_kwargs) -> None:
        finalized.set()

    async def _completed(_prompt_id: str) -> tuple[str, str | None]:
        return "completed", None

    def _forbid_connect(*_args, **_kwargs):
        raise AssertionError("backstop-only monitor must not open a websocket")

    monkeypatch.setattr(service, "_finalize_delivery", _finalize)
    monkeypatch.setattr(service, "_reconcile_prompt_state", _completed)
    monkeypatch.setattr(
        delivery_service_module, "MONITOR_BACKSTOP_INITIAL_DELAY_SECONDS", 0
    )
    monkeypatch.setattr(
        delivery_service_module.websockets, "connect", _forbid_connect
    )

    await service._monitor_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
        monitor_mode="backstop",
    )

    assert finalized.is_set()


@pytest.mark.anyio
async def test_adopt_delivery_is_idempotent_and_reports_progress(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")
    started: list[dict] = []

    async def _fake_start_monitor(**kwargs) -> None:
        started.append(kwargs)

    monkeypatch.setattr(service, "start_monitor", _fake_start_monitor)

    first = await service.adopt_delivery(project_id="p1", prompt_id="prompt-1")
    second = await service.adopt_delivery(project_id="p1", prompt_id="prompt-1")

    # Idempotent per (project, prompt): one delivery, one monitor.
    assert first["delivery_id"] == second["delivery_id"]
    assert len(started) == 1
    assert started[0]["monitor_mode"] == "backstop"
    assert first["status"] == "queued"
    assert first["generation_metadata"]["source"] == "generated"
    assert service._deliveries[first["delivery_id"]]["monitor_mode"] == "backstop"

    # Bridge-forwarded progress marks the delivery running.
    assert (
        await service.mark_running_for_prompt(
            "p1", "prompt-1", progress=42, current_node="node-9"
        )
        is True
    )
    delivery = await service.get_delivery("p1", first["delivery_id"])
    assert delivery["status"] == "running"
    assert delivery["progress"] == 42
    assert delivery["current_node"] == "node-9"

    # Unknown prompt -> no-op signal.
    assert await service.mark_running_for_prompt("p1", "ghost", progress=10) is False

    # A late progress ping cannot resurrect a delivery the backstop settled.
    await service.mark_error(first["delivery_id"], "boom")
    assert (
        await service.mark_running_for_prompt("p1", "prompt-1", progress=99) is False
    )


@pytest.mark.anyio
async def test_adopted_delivery_reattaches_in_backstop_mode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "holding"
    service = GenerationHoldingService(root=root)

    async def _noop_start_monitor(**_kwargs) -> None:
        return None

    monkeypatch.setattr(service, "start_monitor", _noop_start_monitor)
    adopted = await service.adopt_delivery(project_id="p1", prompt_id="prompt-1")
    assert adopted["status"] == "queued"  # inflight -> eligible for re-attach

    fresh = GenerationHoldingService(root=root)
    modes: list[str | None] = []

    async def _capture_start_monitor(**kwargs) -> None:
        modes.append(kwargs.get("monitor_mode"))

    monkeypatch.setattr(fresh, "start_monitor", _capture_start_monitor)
    await fresh._ensure_loaded()

    assert modes == ["backstop"]


@pytest.mark.anyio
async def test_generation_monitor_resets_reconnect_budget_after_healthy_traffic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")
    finalized = asyncio.Event()
    progress_event = json.dumps(
        {
            "type": "progress",
            "data": {"prompt_id": "prompt-1", "value": 1, "max": 2},
        }
    )
    success_event = json.dumps(
        {"type": "execution_success", "data": {"prompt_id": "prompt-1"}}
    )
    sockets = [
        _FakeComfyWebSocket([progress_event]),
        _FakeComfyWebSocket([progress_event]),
        _FakeComfyWebSocket([success_event]),
    ]

    async def _finalize(*_args, **_kwargs) -> None:
        finalized.set()

    def _connect(*_args, **_kwargs) -> _FakeComfyConnect:
        return _FakeComfyConnect(sockets.pop(0))

    monkeypatch.setattr(service, "_finalize_delivery", _finalize)
    monkeypatch.setattr(delivery_service_module.websockets, "connect", _connect)
    monkeypatch.setattr(
        delivery_service_module,
        "MONITOR_RECONNECT_ATTEMPTS",
        1,
    )
    monkeypatch.setattr(
        delivery_service_module,
        "MONITOR_RECONNECT_BASE_DELAY_SECONDS",
        0,
    )
    monkeypatch.setattr(
        delivery_service_module,
        "MONITOR_BACKSTOP_INITIAL_DELAY_SECONDS",
        60,
    )

    await service._monitor_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
    )

    assert finalized.is_set()
    assert sockets == []


@pytest.mark.anyio
async def test_generation_monitor_marks_disappeared_prompt_as_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")
    await service.create_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
        delivery_context=_delivery_context(),
    )

    async def _missing(_prompt_id: str) -> tuple[str, str | None]:
        return "missing", None

    monkeypatch.setattr(service, "_reconcile_prompt_state", _missing)
    monkeypatch.setattr(
        delivery_service_module,
        "MONITOR_BACKSTOP_INITIAL_DELAY_SECONDS",
        0,
    )
    monkeypatch.setattr(
        delivery_service_module,
        "MONITOR_BACKSTOP_INTERVAL_SECONDS",
        0,
    )
    monkeypatch.setattr(
        delivery_service_module,
        "MONITOR_BACKSTOP_MISS_THRESHOLD",
        2,
    )
    monkeypatch.setattr(
        delivery_service_module,
        "MONITOR_RECONNECT_ATTEMPTS",
        0,
    )
    monkeypatch.setattr(
        delivery_service_module.websockets,
        "connect",
        lambda *_args, **_kwargs: _FakeComfyConnect(_FakeComfyWebSocket([])),
    )

    await service._monitor_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
    )

    delivery = await service.get_delivery("project-1", "delivery-1")
    assert delivery is not None
    assert delivery["status"] == "error"
    assert delivery["error"] == "Prompt is no longer known to ComfyUI"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("message", "expected"),
    [
        (
            ["execution_error", {"exception_message": "Sampler failed"}],
            "Sampler failed",
        ),
        (["execution_interrupted", {}], "Generation interrupted"),
    ],
)
async def test_reconcile_prompt_state_reads_history_terminal_errors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    message: list[object],
    expected: str,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")
    client = _FakeHttpClient(
        {
            "/history/prompt-1": {
                "prompt-1": {
                    "status": {"status_str": "error", "messages": [message]}
                }
            }
        }
    )

    async def _client() -> _FakeHttpClient:
        return client

    monkeypatch.setattr(delivery_service_module, "get_http_client", _client)

    assert await service._reconcile_prompt_state("prompt-1") == (
        "completed",
        expected,
    )


@pytest.mark.anyio
async def test_start_monitor_reports_connection_and_returns_after_timeout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")
    release = asyncio.Event()

    async def _hanging_monitor(**_kwargs) -> None:
        await release.wait()

    monkeypatch.setattr(service, "_monitor_delivery", _hanging_monitor)
    monkeypatch.setattr(
        delivery_service_module,
        "MONITOR_CONNECT_TIMEOUT_SECONDS",
        0.001,
    )

    await service.start_monitor(
        project_id="project-1",
        delivery_id="delivery-timeout",
        prompt_id="prompt-1",
        client_id="client-1",
        wait_for_connection=True,
    )

    assert "delivery-timeout" in service._monitor_tasks
    release.set()
    await service.cancel_monitor("delivery-timeout")


@pytest.mark.anyio
async def test_monitor_sets_connected_event_when_websocket_opens(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GenerationHoldingService(root=tmp_path / "holding")
    connected = asyncio.Event()
    interrupted = json.dumps(
        {
            "type": "execution_interrupted",
            "data": {"prompt_id": "prompt-1"},
        }
    )
    monkeypatch.setattr(
        delivery_service_module.websockets,
        "connect",
        lambda *_args, **_kwargs: _FakeComfyConnect(
            _FakeComfyWebSocket([interrupted])
        ),
    )

    await service._monitor_delivery(
        project_id="project-1",
        delivery_id="delivery-1",
        prompt_id="prompt-1",
        client_id="client-1",
        connected_event=connected,
    )

    assert connected.is_set()
