from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import re
import shutil
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any

import httpx
import websockets
from fastapi import WebSocket

from config import RUNTIME_ROOT
from services.comfyui.comfyui_client import get_comfyui_url, get_http_client

logger = logging.getLogger(__name__)

GENERATION_HOLDING_ROOT = RUNTIME_ROOT / "generation_holding"
GENERATION_HOLDING_ROOT.mkdir(parents=True, exist_ok=True)

HISTORY_FETCH_ATTEMPTS = 4
HISTORY_FETCH_RETRY_MS = 0.25


def _sanitize_filename(filename: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9._ -]+", "_", filename).strip(" .")
    return sanitized or "file"


def _guess_extension(content_type: str | None, fallback_name: str = "") -> str:
    if content_type:
        guessed = mimetypes.guess_extension(content_type.split(";", 1)[0].strip())
        if guessed:
            if guessed == ".jpe":
                return ".jpg"
            return guessed
    fallback_suffix = Path(fallback_name).suffix
    return fallback_suffix or ".bin"


def _build_ws_url(client_id: str) -> str:
    parsed = urllib.parse.urlparse(get_comfyui_url())
    ws_scheme = "wss" if parsed.scheme == "https" else "ws"
    base_path = parsed.path.rstrip("/")
    ws_path = f"{base_path}/ws" if base_path else "/ws"
    query = urllib.parse.urlencode({"clientId": client_id})
    return urllib.parse.urlunparse((ws_scheme, parsed.netloc, ws_path, "", query, ""))


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _resolve_output_source_url(item: dict[str, Any]) -> str:
    raw_url = None
    for key in ("view_url", "viewUrl", "url"):
        candidate = item.get(key)
        if isinstance(candidate, str) and candidate.strip():
            raw_url = candidate.strip()
            break

    if raw_url:
        if raw_url.startswith(("http://", "https://")):
            return raw_url
        if raw_url.startswith("/"):
            return raw_url
        return f"/{raw_url}"

    filename = item.get("filename", "")
    subfolder = item.get("subfolder", "")
    output_type = item.get("type", "output")
    params = urllib.parse.urlencode(
        {
            "filename": str(filename),
            "subfolder": str(subfolder),
            "type": str(output_type),
        }
    )
    return f"/view?{params}"


def _parse_node_output_items(node_output: Any) -> list[dict[str, Any]]:
    if not isinstance(node_output, dict):
        return []

    outputs: list[dict[str, Any]] = []
    for key in ("images", "gifs", "videos", "audios", "audio"):
        raw_items = node_output.get(key)
        if not isinstance(raw_items, list):
            continue
        for raw_item in raw_items:
            if not isinstance(raw_item, dict):
                continue
            filename = raw_item.get("filename")
            if not isinstance(filename, str) or not filename.strip():
                continue
            item = dict(raw_item)
            item["filename"] = filename
            item.setdefault("subfolder", "")
            item.setdefault("type", "output")
            item["source_url"] = _resolve_output_source_url(item)
            outputs.append(item)
    return outputs


def _parse_history_outputs(history: Any, prompt_id: str) -> list[dict[str, Any]]:
    if not isinstance(history, dict):
        return []
    prompt_history = history.get(prompt_id)
    if not isinstance(prompt_history, dict):
        return []
    prompt_outputs = prompt_history.get("outputs")
    if not isinstance(prompt_outputs, dict):
        return []

    outputs: list[dict[str, Any]] = []
    for node_output in prompt_outputs.values():
        outputs.extend(_parse_node_output_items(node_output))
    return outputs


class _ProjectConsumer:
    def __init__(self, project_id: str, websocket: WebSocket) -> None:
        self.id = str(uuid.uuid4())
        self.project_id = project_id
        self.websocket = websocket
        self.connected_at = asyncio.get_running_loop().time()


class GenerationHoldingService:
    def __init__(self, root: Path | None = None) -> None:
        self._root = (root or GENERATION_HOLDING_ROOT).resolve()
        self._root.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()
        self._loaded = False
        self._deliveries: dict[str, dict[str, Any]] = {}
        self._project_index: dict[str, set[str]] = {}
        self._project_consumers: dict[str, list[_ProjectConsumer]] = {}
        self._active_consumer_id_by_project: dict[str, str] = {}
        self._monitor_tasks: dict[str, asyncio.Task[None]] = {}

    async def _ensure_loaded(self) -> None:
        async with self._lock:
            if self._loaded:
                return

            for project_dir in self._root.iterdir():
                if not project_dir.is_dir():
                    continue
                for delivery_dir in project_dir.iterdir():
                    manifest_path = delivery_dir / "manifest.json"
                    if not manifest_path.is_file():
                        continue
                    try:
                        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError) as exc:
                        logger.warning("Failed to load generation manifest %s: %s", manifest_path, exc)
                        continue
                    delivery_id = manifest.get("delivery_id")
                    project_id = manifest.get("project_id")
                    if not isinstance(delivery_id, str) or not isinstance(project_id, str):
                        continue
                    if manifest.get("status") in {"queued", "running"}:
                        manifest["status"] = "error"
                        manifest["error"] = "Backend restarted before delivery completed"
                        manifest["updated_at"] = _now_ms()
                        try:
                            manifest_path.write_text(
                                json.dumps(manifest, indent=2, sort_keys=True),
                                encoding="utf-8",
                            )
                        except OSError:
                            logger.warning("Failed to rewrite stale manifest %s", manifest_path)
                    self._deliveries[delivery_id] = manifest
                    self._project_index.setdefault(project_id, set()).add(delivery_id)

            self._loaded = True

    def _project_root(self, project_id: str) -> Path:
        return self._root / project_id

    def _delivery_root(self, project_id: str, delivery_id: str) -> Path:
        return self._project_root(project_id) / delivery_id

    def _manifest_path(self, project_id: str, delivery_id: str) -> Path:
        return self._delivery_root(project_id, delivery_id) / "manifest.json"

    def _file_url(
        self,
        project_id: str,
        delivery_id: str,
        category: str,
        storage_name: str,
    ) -> str:
        quoted_storage_name = urllib.parse.quote(storage_name, safe="")
        return (
            "/app/generation-delivery/projects/"
            f"{urllib.parse.quote(project_id, safe='')}/deliveries/"
            f"{urllib.parse.quote(delivery_id, safe='')}/files/"
            f"{urllib.parse.quote(category, safe='')}/{quoted_storage_name}"
        )

    def _serialize_file_ref(
        self,
        project_id: str,
        delivery_id: str,
        category: str,
        ref: dict[str, Any],
    ) -> dict[str, Any]:
        payload = dict(ref)
        storage_name = payload.pop("storage_name", None)
        if isinstance(storage_name, str):
            payload["download_url"] = self._file_url(
                project_id,
                delivery_id,
                category,
                storage_name,
            )
        return payload

    def _serialize_delivery(self, manifest: dict[str, Any]) -> dict[str, Any]:
        project_id = manifest["project_id"]
        delivery_id = manifest["delivery_id"]
        outputs = [
            {
                "filename": entry.get("filename", ""),
                "subfolder": entry.get("subfolder", ""),
                "type": entry.get("type", "output"),
                "viewUrl": self._file_url(project_id, delivery_id, "outputs", entry["storage_name"]),
                **(
                    {"mime_type": entry["mime_type"]}
                    if isinstance(entry.get("mime_type"), str)
                    else {}
                ),
            }
            for entry in manifest.get("outputs", [])
            if isinstance(entry, dict) and isinstance(entry.get("storage_name"), str)
        ]
        prepared_mask = manifest.get("prepared_mask")
        serialized_mask = (
            self._serialize_file_ref(project_id, delivery_id, "mask", prepared_mask)
            if isinstance(prepared_mask, dict)
            else None
        )
        return {
            "delivery_id": delivery_id,
            "project_id": project_id,
            "prompt_id": manifest.get("prompt_id"),
            "client_id": manifest.get("client_id"),
            "status": manifest.get("status"),
            "progress": manifest.get("progress"),
            "current_node": manifest.get("current_node"),
            "error": manifest.get("error"),
            "created_at": manifest.get("created_at"),
            "updated_at": manifest.get("updated_at"),
            "submitted_at": manifest.get("submitted_at"),
            "completed_at": manifest.get("completed_at"),
            "plan_id": manifest.get("plan_id"),
            "workflow_name": manifest.get("workflow_name"),
            "workflow_source_id": manifest.get("workflow_source_id"),
            "generation_metadata": manifest.get("generation_metadata"),
            "postprocess_config": manifest.get("postprocess_config"),
            "auto_family_request_key": manifest.get("auto_family_request_key"),
            "uses_save_image_websocket_outputs": manifest.get(
                "uses_save_image_websocket_outputs",
                False,
            ),
            "workflow_warnings": manifest.get("workflow_warnings", []),
            "applied_widget_values": manifest.get("applied_widget_values", {}),
            "aspect_ratio_processing": manifest.get("aspect_ratio_processing"),
            "outputs": outputs,
            "preview_frames": [],
            "prepared_mask": serialized_mask,
            "delivery_context": manifest.get("delivery_context"),
            "last_delivery_error": manifest.get("last_delivery_error"),
        }

    async def _persist_manifest(self, manifest: dict[str, Any]) -> None:
        project_id = manifest["project_id"]
        delivery_id = manifest["delivery_id"]
        delivery_root = self._delivery_root(project_id, delivery_id)
        delivery_root.mkdir(parents=True, exist_ok=True)
        self._manifest_path(project_id, delivery_id).write_text(
            json.dumps(manifest, indent=2, sort_keys=True),
            encoding="utf-8",
        )

    async def create_delivery(
        self,
        *,
        project_id: str,
        delivery_id: str,
        prompt_id: str,
        client_id: str,
        delivery_context: dict[str, Any],
    ) -> dict[str, Any]:
        await self._ensure_loaded()

        now = _now_ms()
        manifest = {
            "delivery_id": delivery_id,
            "project_id": project_id,
            "prompt_id": prompt_id,
            "client_id": client_id,
            "status": "queued",
            "progress": 0,
            "current_node": None,
            "error": None,
            "created_at": now,
            "updated_at": now,
            "submitted_at": now,
            "completed_at": None,
            "plan_id": delivery_context.get("plan_id"),
            "workflow_name": delivery_context.get("workflow_name"),
            "workflow_source_id": delivery_context.get("workflow_source_id"),
            "generation_metadata": delivery_context.get("generation_metadata", {}),
            "postprocess_config": delivery_context.get("postprocess_config", {}),
            "auto_family_request_key": delivery_context.get("auto_family_request_key"),
            "uses_save_image_websocket_outputs": delivery_context.get(
                "uses_save_image_websocket_outputs",
                False,
            ),
            "delivery_context": delivery_context,
            "workflow_warnings": [],
            "applied_widget_values": {},
            "aspect_ratio_processing": None,
            "outputs": [],
            "prepared_mask": None,
            "last_delivery_error": None,
        }

        async with self._lock:
            self._deliveries[delivery_id] = manifest
            self._project_index.setdefault(project_id, set()).add(delivery_id)
            await self._persist_manifest(manifest)

        await self._broadcast_delivery_update(project_id, manifest)
        return manifest

    async def update_submission_metadata(
        self,
        *,
        delivery_id: str,
        workflow_warnings: list[dict[str, Any]] | None = None,
        applied_widget_values: dict[str, Any] | None = None,
        aspect_ratio_processing: dict[str, Any] | None = None,
        generation_metadata: dict[str, Any] | None = None,
        prepared_mask_bytes: bytes | None = None,
        prepared_mask_filename: str | None = None,
        prepared_mask_content_type: str | None = None,
    ) -> None:
        await self._ensure_loaded()
        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if not manifest:
                return
            manifest["updated_at"] = _now_ms()
            if workflow_warnings is not None:
                manifest["workflow_warnings"] = workflow_warnings
            if applied_widget_values is not None:
                manifest["applied_widget_values"] = applied_widget_values
            if aspect_ratio_processing is not None:
                manifest["aspect_ratio_processing"] = aspect_ratio_processing
            if generation_metadata is not None:
                manifest["generation_metadata"] = generation_metadata
            if prepared_mask_bytes is not None:
                storage_name = await self._write_file(
                    manifest["project_id"],
                    delivery_id,
                    "mask",
                    prepared_mask_filename or "generation-mask.webm",
                    prepared_mask_bytes,
                )
                manifest["prepared_mask"] = {
                    "filename": prepared_mask_filename or "generation-mask.webm",
                    "mime_type": prepared_mask_content_type or "video/webm",
                    "storage_name": storage_name,
                }
            await self._persist_manifest(manifest)

    async def mark_running(
        self,
        delivery_id: str,
        *,
        progress: int | None = None,
        current_node: str | None = None,
    ) -> None:
        await self._ensure_loaded()
        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if not manifest:
                return
            manifest["status"] = "running"
            if progress is not None:
                manifest["progress"] = progress
            if current_node is not None:
                manifest["current_node"] = current_node
            manifest["updated_at"] = _now_ms()
            await self._persist_manifest(manifest)
            serialized = self._serialize_delivery(manifest)
        await self._broadcast_payload(manifest["project_id"], {"type": "delivery_update", "data": {"delivery": serialized}})

    async def mark_error(self, delivery_id: str, error_message: str) -> None:
        await self._ensure_loaded()
        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if not manifest:
                return
            manifest["status"] = "error"
            manifest["error"] = error_message
            manifest["current_node"] = None
            manifest["completed_at"] = _now_ms()
            manifest["updated_at"] = manifest["completed_at"]
            await self._persist_manifest(manifest)
            serialized = self._serialize_delivery(manifest)
        await self._broadcast_payload(manifest["project_id"], {"type": "delivery_update", "data": {"delivery": serialized}})

    async def mark_completed(
        self,
        delivery_id: str,
        outputs: list[dict[str, Any]],
    ) -> None:
        await self._ensure_loaded()
        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if not manifest:
                return
            manifest["status"] = "completed_pending_ack"
            manifest["progress"] = 100
            manifest["current_node"] = None
            manifest["outputs"] = outputs
            manifest["completed_at"] = _now_ms()
            manifest["updated_at"] = manifest["completed_at"]
            await self._persist_manifest(manifest)
            serialized = self._serialize_delivery(manifest)
        await self._broadcast_payload(manifest["project_id"], {"type": "delivery_update", "data": {"delivery": serialized}})

    async def record_delivery_nack(
        self,
        delivery_id: str,
        error_message: str | None,
    ) -> None:
        await self._ensure_loaded()
        if not error_message:
            return
        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if not manifest:
                return
            manifest["last_delivery_error"] = error_message
            manifest["updated_at"] = _now_ms()
            await self._persist_manifest(manifest)

    async def acknowledge_delivery(self, project_id: str, delivery_id: str) -> bool:
        await self._ensure_loaded()
        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if not manifest or manifest.get("project_id") != project_id:
                return False
            self._deliveries.pop(delivery_id, None)
            project_deliveries = self._project_index.get(project_id)
            if project_deliveries is not None:
                project_deliveries.discard(delivery_id)
            delivery_root = self._delivery_root(project_id, delivery_id)
            if delivery_root.exists():
                shutil.rmtree(delivery_root, ignore_errors=True)
        await self._broadcast_payload(
            project_id,
            {
                "type": "delivery_removed",
                "data": {
                    "delivery_id": delivery_id,
                    "prompt_id": manifest.get("prompt_id") if manifest else None,
                },
            },
        )
        return True

    async def list_project_deliveries(self, project_id: str) -> list[dict[str, Any]]:
        await self._ensure_loaded()
        async with self._lock:
            delivery_ids = sorted(
                self._project_index.get(project_id, set()),
                key=lambda delivery_id: (
                    self._deliveries.get(delivery_id, {}).get("created_at", 0),
                    delivery_id,
                ),
            )
            return [
                self._serialize_delivery(self._deliveries[delivery_id])
                for delivery_id in delivery_ids
                if delivery_id in self._deliveries
            ]

    async def get_delivery(self, project_id: str, delivery_id: str) -> dict[str, Any] | None:
        await self._ensure_loaded()
        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if not manifest or manifest.get("project_id") != project_id:
                return None
            return self._serialize_delivery(manifest)

    async def get_delivery_file_path(
        self,
        project_id: str,
        delivery_id: str,
        category: str,
        storage_name: str,
    ) -> Path | None:
        await self._ensure_loaded()
        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if not manifest or manifest.get("project_id") != project_id:
                return None
            file_path = self._delivery_root(project_id, delivery_id) / category / storage_name
            return file_path if file_path.is_file() else None

    async def attach_consumer(self, project_id: str, websocket: WebSocket) -> None:
        await self._ensure_loaded()
        consumer = _ProjectConsumer(project_id, websocket)

        await websocket.accept()
        await self._register_consumer(consumer)

        try:
            while True:
                payload = await websocket.receive_json()
                message_type = payload.get("type")
                if message_type == "ack":
                    delivery_id = payload.get("delivery_id")
                    if isinstance(delivery_id, str) and delivery_id:
                        await self.acknowledge_delivery(project_id, delivery_id)
                elif message_type == "nack":
                    delivery_id = payload.get("delivery_id")
                    error_message = payload.get("error")
                    if isinstance(delivery_id, str) and delivery_id:
                        await self.record_delivery_nack(
                            delivery_id,
                            error_message if isinstance(error_message, str) else None,
                        )
        except Exception:
            pass
        finally:
            await self._unregister_consumer(consumer)

    async def start_monitor(
        self,
        *,
        project_id: str,
        delivery_id: str,
        prompt_id: str,
        client_id: str,
    ) -> None:
        await self._ensure_loaded()
        existing = self._monitor_tasks.get(delivery_id)
        if existing and not existing.done():
            return
        task = asyncio.create_task(
            self._monitor_delivery(
                project_id=project_id,
                delivery_id=delivery_id,
                prompt_id=prompt_id,
                client_id=client_id,
            )
        )
        self._monitor_tasks[delivery_id] = task

    async def cancel_monitor(self, delivery_id: str) -> None:
        task = self._monitor_tasks.pop(delivery_id, None)
        if not task:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _register_consumer(self, consumer: _ProjectConsumer) -> None:
        async with self._lock:
            consumers = self._project_consumers.setdefault(consumer.project_id, [])
            consumers.append(consumer)
            previous_active_id = self._active_consumer_id_by_project.get(consumer.project_id)
            self._active_consumer_id_by_project[consumer.project_id] = consumer.id
            previous_active = next(
                (candidate for candidate in consumers if candidate.id == previous_active_id),
                None,
            )

        if previous_active and previous_active.id != consumer.id:
            await self._send_payload(
                previous_active,
                {
                    "type": "lease_state",
                    "data": {"project_id": consumer.project_id, "active": False},
                },
            )

        await self._send_payload(
            consumer,
            {"type": "lease_state", "data": {"project_id": consumer.project_id, "active": True}},
        )
        await self._send_payload(
            consumer,
            {
                "type": "snapshot",
                "data": {
                    "project_id": consumer.project_id,
                    "deliveries": await self.list_project_deliveries(consumer.project_id),
                },
            },
        )

    async def _unregister_consumer(self, consumer: _ProjectConsumer) -> None:
        replacement: _ProjectConsumer | None = None
        async with self._lock:
            consumers = self._project_consumers.get(consumer.project_id, [])
            self._project_consumers[consumer.project_id] = [
                candidate for candidate in consumers if candidate.id != consumer.id
            ]
            active_id = self._active_consumer_id_by_project.get(consumer.project_id)
            if active_id == consumer.id:
                remaining = self._project_consumers.get(consumer.project_id, [])
                if remaining:
                    replacement = max(remaining, key=lambda candidate: candidate.connected_at)
                    self._active_consumer_id_by_project[consumer.project_id] = replacement.id
                else:
                    self._active_consumer_id_by_project.pop(consumer.project_id, None)

        if replacement:
            await self._send_payload(
                replacement,
                {
                    "type": "lease_state",
                    "data": {"project_id": consumer.project_id, "active": True},
                },
            )
            await self._send_payload(
                replacement,
                {
                    "type": "snapshot",
                    "data": {
                        "project_id": consumer.project_id,
                        "deliveries": await self.list_project_deliveries(consumer.project_id),
                    },
                },
            )

    async def _send_payload(self, consumer: _ProjectConsumer, payload: dict[str, Any]) -> bool:
        try:
            await consumer.websocket.send_json(payload)
            return True
        except Exception:
            return False

    async def _broadcast_payload(self, project_id: str, payload: dict[str, Any]) -> None:
        async with self._lock:
            consumers = list(self._project_consumers.get(project_id, []))
            active_id = self._active_consumer_id_by_project.get(project_id)
            active_consumer = next(
                (consumer for consumer in consumers if consumer.id == active_id),
                None,
            )
        if active_consumer is None:
            return
        sent = await self._send_payload(active_consumer, payload)
        if not sent:
            await self._unregister_consumer(active_consumer)

    async def _broadcast_delivery_update(self, project_id: str, manifest: dict[str, Any]) -> None:
        await self._broadcast_payload(
            project_id,
            {"type": "delivery_update", "data": {"delivery": self._serialize_delivery(manifest)}},
        )

    async def _write_file(
        self,
        project_id: str,
        delivery_id: str,
        category: str,
        original_name: str,
        content: bytes,
    ) -> str:
        target_dir = self._delivery_root(project_id, delivery_id) / category
        target_dir.mkdir(parents=True, exist_ok=True)
        safe_name = _sanitize_filename(original_name)
        prefix = str(uuid.uuid4())
        storage_name = f"{prefix}_{safe_name}"
        (target_dir / storage_name).write_bytes(content)
        return storage_name

    async def _fetch_history_outputs(
        self,
        prompt_id: str,
    ) -> list[dict[str, Any]]:
        client = await get_http_client()
        last_error: Exception | None = None
        for attempt in range(HISTORY_FETCH_ATTEMPTS):
            try:
                response = await client.get(f"/history/{prompt_id}")
                response.raise_for_status()
                outputs = _parse_history_outputs(response.json(), prompt_id)
                if outputs:
                    return outputs
            except Exception as exc:  # pragma: no cover - defensive fetch fallback
                last_error = exc if isinstance(exc, Exception) else Exception(str(exc))
            if attempt < HISTORY_FETCH_ATTEMPTS - 1:
                await asyncio.sleep(HISTORY_FETCH_RETRY_MS)
        if last_error:
            raise last_error
        return []

    async def _download_output_bytes(
        self,
        output_item: dict[str, Any],
    ) -> tuple[bytes, str]:
        client = await get_http_client()
        source_url = output_item.get("source_url")
        if not isinstance(source_url, str) or not source_url:
            raise RuntimeError("Missing output source URL")
        response = await client.get(source_url)
        response.raise_for_status()
        content_type = response.headers.get("content-type") or "application/octet-stream"
        return response.content, content_type

    async def _capture_history_outputs(
        self,
        project_id: str,
        delivery_id: str,
        prompt_id: str,
    ) -> list[dict[str, Any]]:
        outputs = await self._fetch_history_outputs(prompt_id)
        stored_outputs: list[dict[str, Any]] = []
        for index, output_item in enumerate(outputs):
            content, content_type = await self._download_output_bytes(output_item)
            original_name = output_item.get("filename", f"output-{index}")
            storage_name = await self._write_file(
                project_id,
                delivery_id,
                "outputs",
                f"{index:03d}_{original_name}",
                content,
            )
            stored_outputs.append(
                {
                    "filename": original_name,
                    "subfolder": output_item.get("subfolder", ""),
                    "type": output_item.get("type", "output"),
                    "mime_type": content_type,
                    "storage_name": storage_name,
                }
            )
        return stored_outputs

    async def _finalize_delivery(
        self,
        project_id: str,
        delivery_id: str,
        prompt_id: str,
    ) -> None:
        outputs = await self._capture_history_outputs(project_id, delivery_id, prompt_id)
        if not outputs:
            await self.mark_error(
                delivery_id,
                "Generation completed without persisted final outputs for delivery",
            )
            return
        await self.mark_completed(delivery_id, outputs)

    async def _monitor_delivery(
        self,
        *,
        project_id: str,
        delivery_id: str,
        prompt_id: str,
        client_id: str,
    ) -> None:
        finalized = False
        try:
            async with websockets.connect(
                _build_ws_url(client_id),
                max_size=None,
                max_queue=None,
            ) as comfy_ws:
                async for message in comfy_ws:
                    if isinstance(message, str):
                        try:
                            event = json.loads(message)
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(event, dict):
                            continue
                        event_type = event.get("type")
                        data = event.get("data")
                        if not isinstance(data, dict):
                            continue
                        if data.get("prompt_id") != prompt_id:
                            continue

                        if event_type == "progress":
                            value = data.get("value")
                            maximum = data.get("max")
                            progress = 0
                            if isinstance(value, (int, float)) and isinstance(maximum, (int, float)) and maximum:
                                progress = max(0, min(100, round((float(value) / float(maximum)) * 100)))
                            await self.mark_running(
                                delivery_id,
                                progress=progress,
                                current_node=data.get("node") if isinstance(data.get("node"), str) else None,
                            )
                        elif event_type == "executing":
                            node = data.get("node")
                            if node is None:
                                if not finalized:
                                    finalized = True
                                    await self._finalize_delivery(project_id, delivery_id, prompt_id)
                                break
                            if isinstance(node, str):
                                await self.mark_running(delivery_id, current_node=node)
                        elif event_type == "execution_success":
                            if not finalized:
                                finalized = True
                                await self._finalize_delivery(project_id, delivery_id, prompt_id)
                            break
                        elif event_type == "execution_error":
                            await self.mark_error(
                                delivery_id,
                                data.get("exception_message")
                                if isinstance(data.get("exception_message"), str)
                                else "Generation failed",
                            )
                            break
                        elif event_type == "execution_interrupted":
                            await self.mark_error(delivery_id, "Generation interrupted")
                            break
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Generation delivery monitor failed for %s: %s", delivery_id, exc)
            if not finalized:
                try:
                    await self._finalize_delivery(project_id, delivery_id, prompt_id)
                except Exception:
                    await self.mark_error(
                        delivery_id,
                        f"Generation monitor failed: {exc}",
                    )
        finally:
            self._monitor_tasks.pop(delivery_id, None)


generation_holding_service = GenerationHoldingService()


__all__ = ["GenerationHoldingService", "generation_holding_service"]
