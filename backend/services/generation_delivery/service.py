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
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

import httpx
import websockets
from fastapi import WebSocket, WebSocketDisconnect

from config import RUNTIME_ROOT
from services.comfyui.comfyui_client import get_comfyui_url, get_http_client
from services.model_work import get_model_work_coordinator
from services.model_work.comfyui_admission import (
    COMFY_OWNER,
    mark_prompt_suspected_stale,
    report_prompt_progress,
    settle_prompt,
)
from services.model_work.locality import comfy_resource_key

logger = logging.getLogger(__name__)

GENERATION_HOLDING_ROOT = RUNTIME_ROOT / "generation_holding"
GENERATION_HOLDING_ROOT.mkdir(parents=True, exist_ok=True)

HISTORY_FETCH_ATTEMPTS = 4
HISTORY_FETCH_RETRY_SECONDS = 0.25

# How long a /generate request waits for the monitor websocket to be
# registered with ComfyUI before dispatching anyway (the reconcile backstop
# covers the miss).
MONITOR_CONNECT_TIMEOUT_SECONDS = 5.0
# Websocket drop tolerance: reconnect with the same clientId (ComfyUI re-binds
# the sid) before handing resolution over to the reconcile backstop.
MONITOR_RECONNECT_ATTEMPTS = 5
MONITOR_RECONNECT_BASE_DELAY_SECONDS = 0.5
MONITOR_RECONNECT_MAX_DELAY_SECONDS = 10.0
# Reconcile backstop: poll /history + /queue so a delivery can settle even if
# every websocket event was missed.
MONITOR_BACKSTOP_INITIAL_DELAY_SECONDS = 10.0
MONITOR_BACKSTOP_INTERVAL_SECONDS = 5.0
MONITOR_BACKSTOP_MISS_THRESHOLD = 3
# While a delivery is still queued (pre-running) the backstop polls tighter and
# settles a vanished prompt after fewer misses: this is the window where a queue
# clear/delete (e.g. from the ComfyUI iframe) removes a job that will never run,
# and there is no websocket progress to wait for. A prompt that actually ran
# leaves a /history entry, so a queued prompt that disappears without one was
# removed — only the sub-second queue→history transition can briefly read as
# "missing", which two consecutive misses rule out.
# Consecutive unreachable reconcile passes before a prompt's retained GPU
# occupancy is surfaced as suspected-stale in the Queue panel.
MONITOR_UNREACHABLE_STALE_THRESHOLD = 3
# Consecutive empty-queue polls before an ambiguous submission's reservation is
# released. More than one, because a prompt can sit between "accepted" and
# "queued" for a moment.
AMBIGUOUS_SUBMISSION_IDLE_THRESHOLD = 2
# Every backstop that has not seen its prompt in /history falls through to
# /queue, and /queue returns the *full prompt payload* for every entry. Now
# that a batch is submitted ahead, N deliveries would each pull the whole queue
# every couple of seconds, so one snapshot is fetched and shared. Kept just
# under the queued poll interval so a round of backstops coalesces onto one
# fetch without any of them reading a snapshot older than its own cadence.
QUEUE_SNAPSHOT_TTL_SECONDS = 1.5
MONITOR_BACKSTOP_QUEUED_INTERVAL_SECONDS = 2.0
MONITOR_BACKSTOP_QUEUED_MISS_THRESHOLD = 2
# Backstop-only monitors (adopted in-editor generations) have no websocket to
# race, so their first reconcile need not wait out the websocket grace window.
MONITOR_BACKSTOP_ONLY_INITIAL_DELAY_SECONDS = 2.0

#: A settled delivery. No later event may move a manifest out of one of these.
TERMINAL_DELIVERY_STATUSES = frozenset(
    {"completed_pending_ack", "error", "cancelled"}
)
#: Paired with the frontend's GENERATION_CANCELLED_BY_USER_MESSAGE and
#: GENERATION_INTERRUPTED_MESSAGE constants: the panel recognises these exact
#: strings as "stopped on purpose" and keeps them out of its failure history.
GENERATION_CANCELLED_MESSAGE = "Generation cancelled by user"
GENERATION_INTERRUPTED_MESSAGE = "Generation interrupted"
#: How long a recorded cancellation stays consultable. It only has to outlive
#: the reconcile pass that notices the prompt is gone (a few polls), and a
#: prompt ComfyUI never drops would otherwise pin its note forever.
CANCELLED_PROMPT_TTL_SECONDS = 900.0
CANCELLED_PROMPT_MAX_ENTRIES = 512

BINARY_PREVIEW_IMAGE = 1
BINARY_PREVIEW_IMAGE_WITH_METADATA = 4
_PREVIEW_EVENT_TYPES = {BINARY_PREVIEW_IMAGE, BINARY_PREVIEW_IMAGE_WITH_METADATA}
PREVIEW_METADATA_FEATURE_FLAGS = json.dumps(
    {
        "type": "feature_flags",
        "data": {"supports_preview_metadata": True},
    },
    separators=(",", ":"),
)
PNG_SIGNATURE = bytes((0x89, 0x50, 0x4E, 0x47))
JPEG_SIGNATURE = bytes((0xFF, 0xD8, 0xFF))
GIF87_SIGNATURE = b"GIF87a"
GIF89_SIGNATURE = b"GIF89a"
WEBP_RIFF_SIGNATURE = b"RIFF"
WEBP_FORMAT_SIGNATURE = b"WEBP"
BMP_SIGNATURE = b"BM"
VHS_LATENT_PREVIEW_IMAGE_OFFSET = 32
MAX_PREVIEW_SIGNATURE_OFFSET = 256


def _is_preview_binary_frame(message: bytes) -> bool:
    if len(message) < 4:
        return False
    event_type = int.from_bytes(message[:4], byteorder="big", signed=False)
    return event_type in _PREVIEW_EVENT_TYPES


def _detect_image_mime_at_offset(message: bytes, offset: int) -> str | None:
    if offset < 0 or offset >= len(message):
        return None
    if message.startswith(PNG_SIGNATURE, offset):
        return "image/png"
    if message.startswith(JPEG_SIGNATURE, offset):
        return "image/jpeg"
    if message.startswith(GIF87_SIGNATURE, offset) or message.startswith(
        GIF89_SIGNATURE,
        offset,
    ):
        return "image/gif"
    if message.startswith(BMP_SIGNATURE, offset):
        return "image/bmp"
    if (
        offset + 12 <= len(message)
        and message.startswith(WEBP_RIFF_SIGNATURE, offset)
        and message[offset + 8 : offset + 12] == WEBP_FORMAT_SIGNATURE
    ):
        return "image/webp"
    return None


def _find_image_payload(message: bytes, start_offset: int) -> tuple[int, str] | None:
    max_offset = min(
        len(message),
        max(start_offset, MAX_PREVIEW_SIGNATURE_OFFSET),
    )
    for offset in range(start_offset, max_offset):
        mime_type = _detect_image_mime_at_offset(message, offset)
        if mime_type:
            return offset, mime_type
    return None


def _normalize_preview_image_type(value: Any) -> str | None:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"jpg", "jpeg"}:
            return "image/jpeg"
        if normalized in {"png", "webp", "bmp", "gif"}:
            return f"image/{normalized}"
        if normalized in {
            "image/jpeg",
            "image/jpg",
            "image/png",
            "image/webp",
            "image/bmp",
            "image/gif",
        }:
            return "image/jpeg" if normalized == "image/jpg" else normalized
    if isinstance(value, int):
        if value == 1:
            return "image/jpeg"
        if value == 2:
            return "image/png"
        if value == 3:
            return "image/webp"
    return None


def _extract_image_bytes(message: bytes) -> tuple[bytes, str] | None:
    if len(message) < 4:
        return None
    event_type = int.from_bytes(message[:4], byteorder="big", signed=False)
    if event_type == BINARY_PREVIEW_IMAGE_WITH_METADATA:
        if len(message) < 8:
            return None
        metadata_length = int.from_bytes(message[4:8], byteorder="big", signed=False)
        payload_offset = 8 + metadata_length
        if payload_offset > len(message):
            return None
        metadata: dict[str, Any] | None = None
        if metadata_length > 0:
            try:
                decoded = json.loads(message[8:payload_offset].decode("utf-8"))
                metadata = decoded if isinstance(decoded, dict) else None
            except (UnicodeDecodeError, json.JSONDecodeError):
                metadata = None

        mime_type = _detect_image_mime_at_offset(message, payload_offset)
        if mime_type:
            return message[payload_offset:], mime_type

        discovered = _find_image_payload(message, payload_offset)
        if discovered:
            discovered_offset, discovered_mime = discovered
            return message[discovered_offset:], discovered_mime

        metadata_mime = _normalize_preview_image_type(
            metadata.get("image_type") if metadata else None
        )
        if metadata_mime:
            return message[payload_offset:], metadata_mime
        return None
    elif event_type == BINARY_PREVIEW_IMAGE:
        if len(message) < 8:
            return None
        for payload_offset in (8, 4, VHS_LATENT_PREVIEW_IMAGE_OFFSET):
            mime_type = _detect_image_mime_at_offset(message, payload_offset)
            if mime_type:
                return message[payload_offset:], mime_type

        discovered = _find_image_payload(message, 4)
        if discovered:
            discovered_offset, discovered_mime = discovered
            return message[discovered_offset:], discovered_mime

        image_type = int.from_bytes(message[4:8], byteorder="big", signed=False)
        mime_type = _normalize_preview_image_type(image_type)
        if mime_type:
            return message[8:], mime_type
        return None
    else:
        return None


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


def _parse_queue_section_prompt_ids(entries: Any) -> set[str]:
    prompt_ids: set[str] = set()
    if not isinstance(entries, list):
        return prompt_ids
    for entry in entries:
        if (
            isinstance(entry, (list, tuple))
            and len(entry) > 1
            and isinstance(entry[1], str)
        ):
            prompt_ids.add(entry[1])
        elif isinstance(entry, dict) and isinstance(entry.get("prompt_id"), str):
            prompt_ids.add(entry["prompt_id"])
    return prompt_ids


def _parse_queue_sections(queue: Any) -> _QueueSections:
    """Split ComfyUI's /queue payload into what is executing and what waits.

    The two are not interchangeable. A ``clear`` drops pending work and spares
    the running prompt, and a prompt that is merely pending can be deleted
    outright — so anything reasoning about cancellation has to know which half
    an id is in.
    """

    if not isinstance(queue, dict):
        return _QueueSections(running=set(), pending=set())
    return _QueueSections(
        running=_parse_queue_section_prompt_ids(queue.get("queue_running")),
        pending=_parse_queue_section_prompt_ids(queue.get("queue_pending")),
    )


def _parse_queue_prompt_ids(queue: Any) -> set[str]:
    """Every prompt id ComfyUI holds, running or pending."""
    sections = _parse_queue_sections(queue)
    return sections.running | sections.pending


def _extract_history_prompt_metadata(
    history: Any,
    prompt_id: str,
) -> dict[str, Any]:
    """Lift the deterministic workflow record ComfyUI keeps for a completed
    prompt: the API prompt and the authored graph the frontend attached via
    ``extra_data.extra_pnginfo.workflow`` (ComfyUI strips only auth tokens
    before queueing). History prompt tuple shape:
    ``[number, prompt_id, prompt, extra_data, outputs_to_execute]``.

    Keys are camelCase to match the frontend's GeneratedCreationMetadata.
    """
    if not isinstance(history, dict):
        return {}
    prompt_history = history.get(prompt_id)
    if not isinstance(prompt_history, dict):
        return {}
    prompt_tuple = prompt_history.get("prompt")
    if not isinstance(prompt_tuple, (list, tuple)) or len(prompt_tuple) < 4:
        return {}

    extracted: dict[str, Any] = {}
    api_prompt = prompt_tuple[2]
    if isinstance(api_prompt, dict) and api_prompt:
        extracted["comfyuiPrompt"] = api_prompt

    extra_data = prompt_tuple[3]
    if isinstance(extra_data, dict):
        extra_pnginfo = extra_data.get("extra_pnginfo")
        if isinstance(extra_pnginfo, dict):
            workflow = extra_pnginfo.get("workflow")
            if isinstance(workflow, dict) and workflow:
                extracted["comfyuiWorkflow"] = workflow

    return extracted


def _extract_history_error(prompt_history: Any) -> str | None:
    """Return an error message if the history entry records a failed run."""
    if not isinstance(prompt_history, dict):
        return None
    status = prompt_history.get("status")
    if not isinstance(status, dict) or status.get("status_str") != "error":
        return None
    messages = status.get("messages")
    if isinstance(messages, list):
        for message in messages:
            if not isinstance(message, (list, tuple)) or len(message) < 2:
                continue
            event_name, event_data = message[0], message[1]
            if event_name == "execution_interrupted":
                return "Generation interrupted"
            if event_name == "execution_error" and isinstance(event_data, dict):
                exception_message = event_data.get("exception_message")
                if isinstance(exception_message, str) and exception_message:
                    return exception_message
    return "Generation failed"


class GenerationCancelError(RuntimeError):
    """ComfyUI refused a cancellation outright; nothing was mutated."""


@dataclass(frozen=True)
class _QueueSections:
    running: set[str]
    pending: set[str]


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
        self._adoption_lock = asyncio.Lock()
        self._loaded = False
        # True only between reading manifests and finishing monitor attachment.
        # `_loaded` deliberately stays false for that window: a partially
        # restored ledger must not be mistaken for a restored one.
        self._restoring = False
        self._deliveries: dict[str, dict[str, Any]] = {}
        self._project_index: dict[str, set[str]] = {}
        self._project_consumers: dict[str, list[_ProjectConsumer]] = {}
        self._active_consumer_id_by_project: dict[str, str] = {}
        self._monitor_tasks: dict[str, asyncio.Task[None]] = {}
        self._iframe_client_projects: dict[str, tuple[int, str]] = {}
        # (taken_at, prompt_ids | None) — None means ComfyUI was unreachable,
        # which is cached too so a batch of backstops cannot stampede a
        # ComfyUI that is down.
        self._queue_snapshot: tuple[float, _QueueSections | None] | None = None
        self._queue_snapshot_lock = asyncio.Lock()
        # prompt_id -> monotonic time the cancellation was recorded. See
        # `note_prompts_cancelled` for why intent has to be remembered.
        self._cancelled_prompt_ids: dict[str, float] = {}

    async def _ensure_loaded(self) -> None:
        reattach_manifests: list[dict[str, Any]] = []
        async with self._lock:
            if self._loaded:
                return
            if self._restoring:
                # Re-entrant call from `start_monitor` during the attach phase
                # below. The manifests are already in memory; recursing would
                # re-read them and re-attach every monitor.
                return

            await self._sync_persisted_deliveries_locked(
                inflight_out=reattach_manifests,
            )
            self._restoring = True

        try:
            # 1. Rebuild GPU occupancy *before* any monitor runs. ComfyUI kept
            #    executing while the backend was down, so admitting local
            #    inference now would put two tenants on one card.
            self._restore_model_work_occupancy(reattach_manifests)

            # 2. Re-attach monitors for deliveries that were in flight when the
            #    backend went down. ComfyUI keeps executing (and its history
            #    keeps the outputs), so the reconcile backstop can settle
            #    anything that completed or vanished during the downtime.
            for manifest in reattach_manifests:
                await self.start_monitor(
                    project_id=manifest["project_id"],
                    delivery_id=manifest["delivery_id"],
                    prompt_id=manifest["prompt_id"],
                    client_id=manifest["client_id"],
                    monitor_mode=manifest.get("monitor_mode", "full"),
                )
        except BaseException:
            # Leave `_loaded` false so the next attempt genuinely retries. A
            # half-restored state that reports itself loaded is what would let
            # local inference start alongside a prompt ComfyUI never stopped.
            raise
        else:
            async with self._lock:
                self._loaded = True
        finally:
            self._restoring = False

    def _restore_model_work_occupancy(self, manifests: list[dict[str, Any]]) -> None:
        """Recreate one ComfyUI occupancy per in-flight prompt, keyed by prompt id.

        Monitor release is idempotent and prompt-scoped, so a restore/live-event
        race cannot release another prompt's occupancy.
        """

        if comfy_resource_key() is None:
            return  # Remote ComfyUI: observe-only, nothing to exclude.

        from services.model_work import PersistedOccupancy, get_model_work_coordinator

        coordinator = get_model_work_coordinator()
        for manifest in manifests:
            prompt_id = manifest.get("prompt_id")
            if not isinstance(prompt_id, str) or not prompt_id:
                continue
            adopted = manifest.get("monitor_mode") == "backstop"
            coordinator.restore_prompt_token(
                PersistedOccupancy(
                    prompt_id=prompt_id,
                    source="comfyui-iframe" if adopted else "comfyui-vlo",
                    owner=COMFY_OWNER,
                    label=manifest.get("workflow_name") or "ComfyUI generation",
                    job_status="queued" if manifest.get("status") == "queued" else "running",
                    submitted_at=(manifest.get("submitted_at") or 0) / 1000 or None,
                )
            )

    async def restore_in_flight_work(self) -> None:
        """Startup entry point: load manifests and rebuild occupancy.

        Called from the application lifespan before routers can serve, so the
        coordinator is only marked ready once every persisted manifest has been
        attached or reconciled.
        """

        await self._ensure_loaded()

    def _has_live_monitor(self, delivery_id: str) -> bool:
        task = self._monitor_tasks.get(delivery_id)
        return task is not None and not task.done()

    def _load_manifest_from_disk(
        self,
        manifest_path: Path,
        *,
        inflight_out: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any] | None:
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning(
                "Failed to load generation manifest %s: %s",
                manifest_path,
                exc,
            )
            return None

        delivery_id = manifest.get("delivery_id")
        project_id = manifest.get("project_id")
        if not isinstance(delivery_id, str) or not isinstance(project_id, str):
            return None

        if inflight_out is not None and manifest.get("status") in {"queued", "running"}:
            prompt_id = manifest.get("prompt_id")
            client_id = manifest.get("client_id")
            if (
                isinstance(prompt_id, str)
                and prompt_id
                and isinstance(client_id, str)
                and client_id
            ):
                inflight_out.append(manifest)
            else:
                # Without the ids there is nothing to re-attach to.
                manifest["status"] = "error"
                manifest["error"] = "Backend restarted before delivery completed"
                manifest["updated_at"] = _now_ms()
                try:
                    manifest_path.write_text(
                        json.dumps(manifest, indent=2, sort_keys=True),
                        encoding="utf-8",
                    )
                except OSError:
                    logger.warning(
                        "Failed to rewrite stale manifest %s", manifest_path
                    )

        return manifest

    async def _sync_persisted_deliveries_locked(
        self,
        *,
        inflight_out: list[dict[str, Any]] | None = None,
    ) -> None:
        seen_delivery_ids: set[str] = set()

        for project_dir in self._root.iterdir():
            if not project_dir.is_dir():
                continue
            for delivery_dir in project_dir.iterdir():
                manifest_path = delivery_dir / "manifest.json"
                if not manifest_path.is_file():
                    continue
                manifest = self._load_manifest_from_disk(
                    manifest_path,
                    inflight_out=inflight_out,
                )
                if not manifest:
                    continue

                delivery_id = manifest["delivery_id"]
                seen_delivery_ids.add(delivery_id)
                if self._has_live_monitor(delivery_id):
                    continue
                self._deliveries[delivery_id] = manifest

        stale_delivery_ids = [
            delivery_id
            for delivery_id in list(self._deliveries)
            if delivery_id not in seen_delivery_ids and not self._has_live_monitor(delivery_id)
        ]
        for delivery_id in stale_delivery_ids:
            self._deliveries.pop(delivery_id, None)

        self._project_index = {}
        for delivery_id, manifest in self._deliveries.items():
            project_id = manifest.get("project_id")
            if isinstance(project_id, str):
                self._project_index.setdefault(project_id, set()).add(delivery_id)

    async def _sync_persisted_deliveries(self) -> None:
        await self._ensure_loaded()
        async with self._lock:
            # Re-read manifests on reconnect/list paths so the holding area
            # works across backend instances and late reconnects. No monitor
            # re-attach here — that only happens on the initial load.
            await self._sync_persisted_deliveries_locked()

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
                "viewUrl": self._file_url(
                    project_id,
                    delivery_id,
                    entry.get("category", "outputs"),
                    entry["storage_name"],
                ),
                **(
                    {"mime_type": entry["mime_type"]}
                    if isinstance(entry.get("mime_type"), str)
                    else {}
                ),
            }
            for entry in manifest.get("outputs", [])
            if isinstance(entry, dict) and isinstance(entry.get("storage_name"), str)
        ]
        preview_frames = [
            self._serialize_file_ref(project_id, delivery_id, "preview_frames", entry)
            for entry in manifest.get("preview_frames", [])
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
            "preview_frames": preview_frames,
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
        monitor_mode: str = "full",
    ) -> dict[str, Any]:
        await self._ensure_loaded()

        now = _now_ms()
        manifest = {
            "delivery_id": delivery_id,
            "project_id": project_id,
            "prompt_id": prompt_id,
            "client_id": client_id,
            # "full": vlo-submitted, monitored over its own websocket.
            # "backstop": adopted in-editor generation, settled by history/queue
            # polling only (the iframe owns the websocket for this client_id).
            "monitor_mode": monitor_mode,
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
            "save_image_websocket_node_ids": list(
                delivery_context.get("save_image_websocket_node_ids") or []
            ),
            "delivery_context": delivery_context,
            "workflow_warnings": [],
            "applied_widget_values": {},
            "aspect_ratio_processing": None,
            "outputs": [],
            "preview_frames": [],
            "prepared_mask": None,
            "last_delivery_error": None,
            # Set when a cancellation is requested for this prompt, so an
            # in-flight cancel survives a backend restart.
            "cancel_requested": False,
        }

        async with self._lock:
            self._deliveries[delivery_id] = manifest
            self._project_index.setdefault(project_id, set()).add(delivery_id)
            await self._persist_manifest(manifest)

        await self._broadcast_delivery_update(project_id, manifest)
        return manifest

    def _find_delivery_id_for_prompt_locked(
        self,
        prompt_id: str,
    ) -> str | None:
        for delivery_id, manifest in self._deliveries.items():
            if manifest.get("prompt_id") == prompt_id:
                return delivery_id
        return None

    async def register_iframe_client_project(
        self,
        *,
        client_id: str,
        project_id: str,
        binding_version: int,
    ) -> str:
        """Bind a ComfyUI browser client to its active vlo project.

        Binding versions prevent a slow request from the previous project from
        overwriting a newer project switch for the same persistent client id.
        """
        async with self._lock:
            existing = self._iframe_client_projects.get(client_id)
            if existing is None or binding_version >= existing[0]:
                self._iframe_client_projects[client_id] = (
                    binding_version,
                    project_id,
                )
                return project_id
            return existing[1]

    async def get_iframe_client_project(self, client_id: str) -> str | None:
        async with self._lock:
            binding = self._iframe_client_projects.get(client_id)
            return binding[1] if binding is not None else None

    def _merge_adopted_metadata_locked(
        self,
        manifest: dict[str, Any],
        generation_metadata: dict[str, Any] | None,
    ) -> bool:
        if not isinstance(generation_metadata, dict):
            return False
        metadata = manifest.get("generation_metadata")
        if not isinstance(metadata, dict):
            return False

        changed = False
        if isinstance(generation_metadata.get("inputs"), list):
            inputs = [
                dict(generation_input)
                for generation_input in generation_metadata["inputs"]
                if isinstance(generation_input, dict)
            ]
            if metadata.get("inputs") != inputs:
                metadata["inputs"] = inputs
                changed = True

        for key in ("maskCropMetadata", "comfyuiPrompt", "comfyuiWorkflow"):
            value = generation_metadata.get(key)
            if isinstance(value, dict) and value and metadata.get(key) != value:
                metadata[key] = dict(value)
                changed = True

        target_resolution = generation_metadata.get("targetResolution")
        if (
            isinstance(target_resolution, int)
            and target_resolution > 0
            and metadata.get("targetResolution") != target_resolution
        ):
            metadata["targetResolution"] = target_resolution
            changed = True

        if changed:
            manifest["updated_at"] = _now_ms()
        return changed

    async def adopt_delivery(
        self,
        *,
        project_id: str,
        prompt_id: str,
        client_id: str | None = None,
        workflow_name: str | None = None,
        generation_metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Adopt a generation submitted natively inside the ComfyUI iframe.

        Creates a delivery manifest and a backstop-only monitor so the run
        settles from ComfyUI's history/queue without opening a websocket on the
        iframe's client_id (which would steal the iframe's own job events).
        Idempotent globally per ComfyUI prompt id.
        """
        await self._ensure_loaded()
        # Proxy submission adoption and bridge fallback can race immediately
        # after ComfyUI accepts a prompt. Keep the lookup/create sequence
        # atomic so both paths converge on one persisted delivery and monitor.
        async with self._adoption_lock:
            return await self._adopt_delivery_once(
                project_id=project_id,
                prompt_id=prompt_id,
                client_id=client_id,
                workflow_name=workflow_name,
                generation_metadata=generation_metadata,
            )

    async def _adopt_delivery_once(
        self,
        *,
        project_id: str,
        prompt_id: str,
        client_id: str | None,
        workflow_name: str | None,
        generation_metadata: dict[str, Any] | None,
    ) -> dict[str, Any]:
        async with self._lock:
            existing_id = self._find_delivery_id_for_prompt_locked(prompt_id)
            if existing_id is not None:
                existing = self._deliveries[existing_id]
                if (
                    existing.get("project_id") == project_id
                    and self._merge_adopted_metadata_locked(
                        existing,
                        generation_metadata,
                    )
                ):
                    await self._persist_manifest(existing)
                return self._serialize_delivery(existing)

        label = workflow_name or "ComfyUI (in-editor)"
        delivery_id = str(uuid.uuid4())
        # A non-empty client_id keeps restart re-attach happy; it is otherwise
        # unused in backstop mode (no websocket is opened with it).
        supplied_inputs = (
            generation_metadata.get("inputs")
            if isinstance(generation_metadata, dict)
            else None
        )
        adopted_generation_metadata: dict[str, Any] = {
            "source": "generated",
            "workflowName": label,
            "inputs": [
                dict(generation_input)
                for generation_input in (supplied_inputs or [])
                if isinstance(generation_input, dict)
            ],
            # Lets the frontend route regeneration back into the
            # ComfyUI editor rather than the generation panel.
            "generatedInEditor": True,
        }
        if isinstance(generation_metadata, dict):
            mask_crop_metadata = generation_metadata.get("maskCropMetadata")
            if isinstance(mask_crop_metadata, dict):
                adopted_generation_metadata["maskCropMetadata"] = dict(
                    mask_crop_metadata
                )
            target_resolution = generation_metadata.get("targetResolution")
            if isinstance(target_resolution, int) and target_resolution > 0:
                adopted_generation_metadata["targetResolution"] = target_resolution
            for key in ("comfyuiPrompt", "comfyuiWorkflow"):
                value = generation_metadata.get(key)
                if isinstance(value, dict) and value:
                    adopted_generation_metadata[key] = dict(value)

        manifest = await self.create_delivery(
            project_id=project_id,
            delivery_id=delivery_id,
            prompt_id=prompt_id,
            client_id=client_id or f"iframe:{prompt_id}",
            delivery_context={
                "workflow_name": label,
                "generation_metadata": adopted_generation_metadata,
                "adopted_from_iframe": True,
            },
            monitor_mode="backstop",
        )
        await self.start_monitor(
            project_id=project_id,
            delivery_id=delivery_id,
            prompt_id=prompt_id,
            client_id=manifest["client_id"],
            monitor_mode="backstop",
        )
        return self._serialize_delivery(manifest)

    async def mark_running_for_prompt(
        self,
        project_id: str,
        prompt_id: str,
        *,
        progress: int | None = None,
        current_node: str | None = None,
    ) -> bool:
        """Progress update for an adopted delivery, keyed by prompt id.

        The bridge forwards the iframe's native progress events; a terminal
        state is still owned by the backstop, so this only ever marks running.
        """
        await self._ensure_loaded()
        async with self._lock:
            delivery_id = self._find_delivery_id_for_prompt_locked(prompt_id)
            manifest = self._deliveries.get(delivery_id) if delivery_id else None
            # Never resurrect an already-settled delivery with a late progress
            # ping (the backstop may have finalized it first).
            if (
                manifest is None
                or manifest.get("project_id") != project_id
                or manifest.get("status") in TERMINAL_DELIVERY_STATUSES
            ):
                return False
        await self.mark_running(
            delivery_id,
            progress=progress,
            current_node=current_node,
        )
        return True

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
                    prepared_mask_filename or "generation-mask.mp4",
                    prepared_mask_bytes,
                )
                manifest["prepared_mask"] = {
                    "filename": prepared_mask_filename or "generation-mask.mp4",
                    "mime_type": prepared_mask_content_type or "video/mp4",
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
            # Never resurrect a settled delivery. A late progress event (e.g. a
            # bridge-forwarded update racing the backstop's finalize on an
            # adopted generation) must not flip a terminal manifest back to
            # running.
            if manifest.get("status") in TERMINAL_DELIVERY_STATUSES:
                return
            manifest["status"] = "running"
            if progress is not None:
                manifest["progress"] = progress
            if current_node is not None:
                manifest["current_node"] = current_node
            manifest["updated_at"] = _now_ms()
            await self._persist_manifest(manifest)
            serialized = self._serialize_delivery(manifest)
        report_prompt_progress(
            manifest.get("prompt_id") or "",
            progress=None if progress is None else progress / 100,
            message=current_node,
            # ComfyUI has started this prompt. Admission left it queued in the
            # ledger precisely so the Queue panel could tell the executing
            # prompt apart from its submitted-ahead siblings.
            job_status="running",
        )
        await self._broadcast_payload(manifest["project_id"], {"type": "delivery_update", "data": {"delivery": serialized}})

    async def mark_error(self, delivery_id: str, error_message: str) -> None:
        await self._ensure_loaded()
        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if not manifest:
                return
            if manifest.get("status") == "cancelled":
                # Deliberately stopped, and already broadcast as such. A monitor
                # racing an external cancel must not restate it as a failure.
                return
            manifest["status"] = "error"
            manifest["error"] = error_message
            manifest["current_node"] = None
            manifest["completed_at"] = _now_ms()
            manifest["updated_at"] = manifest["completed_at"]
            await self._persist_manifest(manifest)
            serialized = self._serialize_delivery(manifest)
        settle_prompt(manifest.get("prompt_id") or "", "failed")
        await self._broadcast_payload(manifest["project_id"], {"type": "delivery_update", "data": {"delivery": serialized}})

    async def note_prompts_cancelled(self, prompt_ids: Iterable[str]) -> None:
        """Record that these prompts were removed from ComfyUI on purpose.

        Reconciliation cannot tell a deliberate cancel from any other reason a
        prompt might vanish — both read as "no longer known to ComfyUI" — so
        the intent has to be recorded at the moment it is expressed, by
        whichever path expresses it (vlo's own cancel, or a queue clear from
        the in-editor ComfyUI). Only the settle paths consult it, so a note for
        a prompt that goes on to complete normally is inert.

        Notes for prompts vlo has a delivery for are written to the manifest as
        well, because the in-memory half dies with the process and a backend
        restart would otherwise turn the cancel that was in flight back into a
        failure. A prompt without a delivery keeps the in-memory note only —
        there is nowhere durable to put it, and its watchdog runs in this
        process anyway.

        Only ever call this for a mutation that actually happened. A note for a
        request ComfyUI rejected outlives the request and would relabel a later,
        genuine failure as a cancellation; see :meth:`discard_cancel_notes`.
        """

        now = time.monotonic()
        noted: list[str] = []
        for prompt_id in prompt_ids:
            if prompt_id:
                self._cancelled_prompt_ids[prompt_id] = now
                noted.append(prompt_id)
        self._prune_cancelled_prompts()

        for prompt_id in noted:
            async with self._lock:
                delivery_id = self._find_delivery_id_for_prompt_locked(prompt_id)
                manifest = self._deliveries.get(delivery_id) if delivery_id else None
                if manifest is None or manifest.get("cancel_requested"):
                    continue
                manifest["cancel_requested"] = True
                manifest["updated_at"] = _now_ms()
                await self._persist_manifest(manifest)

    async def discard_cancel_notes(self, prompt_ids: Iterable[str]) -> None:
        """Undo notes for a mutation ComfyUI refused outright.

        The request never reached the queue, so nothing about these prompts has
        changed and the recorded intent is a lie that would outlive its own
        request.
        """

        for prompt_id in prompt_ids:
            self._cancelled_prompt_ids.pop(prompt_id, None)
            async with self._lock:
                delivery_id = self._find_delivery_id_for_prompt_locked(prompt_id)
                manifest = self._deliveries.get(delivery_id) if delivery_id else None
                if manifest is None or not manifest.get("cancel_requested"):
                    continue
                manifest["cancel_requested"] = False
                manifest["updated_at"] = _now_ms()
                await self._persist_manifest(manifest)

    def _prune_cancelled_prompts(self) -> None:
        now = time.monotonic()
        for prompt_id in [
            prompt_id
            for prompt_id, noted_at in self._cancelled_prompt_ids.items()
            if now - noted_at > CANCELLED_PROMPT_TTL_SECONDS
        ]:
            self._cancelled_prompt_ids.pop(prompt_id, None)
        overflow = len(self._cancelled_prompt_ids) - CANCELLED_PROMPT_MAX_ENTRIES
        if overflow > 0:
            oldest = sorted(
                self._cancelled_prompt_ids,
                key=self._cancelled_prompt_ids.__getitem__,
            )[:overflow]
            for prompt_id in oldest:
                self._cancelled_prompt_ids.pop(prompt_id, None)

    def was_cancelled(self, prompt_id: str) -> bool:
        """Whether this prompt's disappearance is already explained.

        Expiry is decided per id rather than left to the prune pass: pruning
        only runs when another note is added, so a stale note on a quiet system
        would otherwise be consulted forever.
        """

        if not prompt_id:
            return False
        noted_at = self._cancelled_prompt_ids.get(prompt_id)
        if noted_at is not None:
            if time.monotonic() - noted_at <= CANCELLED_PROMPT_TTL_SECONDS:
                return True
            self._cancelled_prompt_ids.pop(prompt_id, None)
        delivery_id = self._find_delivery_id_for_prompt_locked(prompt_id)
        manifest = self._deliveries.get(delivery_id) if delivery_id else None
        return bool(manifest and manifest.get("cancel_requested"))

    async def resolve_queue_mutation(self, payload: object) -> list[str]:
        """Which prompts a proxied ComfyUI queue delete/clear would cancel.

        This is the path vlo does not originate: the Clear button inside the
        in-editor ComfyUI, whose request only ever reaches ComfyUI through the
        proxy. A `clear` names nothing — the ids have to be read from the queue,
        and only *before* ComfyUI empties it, which is why resolving and
        recording are two steps. The proxy resolves here, forwards, and records
        the result only if ComfyUI accepted the mutation.

        Pending only: ComfyUI's clear wipes the waiting queue and leaves the
        running prompt alone, so naming that one would relabel its eventual,
        genuine failure as a cancellation.
        """

        if not isinstance(payload, dict):
            return []
        deleted = payload.get("delete")
        if isinstance(deleted, list):
            return [
                prompt_id
                for prompt_id in deleted
                if isinstance(prompt_id, str) and prompt_id
            ]
        if payload.get("clear"):
            prompt_ids = await self._pending_prompt_ids(force_refresh=True)
            return sorted(prompt_ids or ())
        return []

    async def mark_cancelled(
        self,
        delivery_id: str,
        message: str = GENERATION_CANCELLED_MESSAGE,
    ) -> bool:
        """Settle a delivery as deliberately stopped rather than failed.

        Distinct from :meth:`mark_error` in both directions it reports: the
        ledger records ``cancelled``, so the Queue panel says "Cancelled"
        instead of "Failed", and the manifest's terminal status tells the
        generation panel this was not a generation that went wrong.
        """

        await self._ensure_loaded()
        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if not manifest:
                return False
            if manifest.get("status") in TERMINAL_DELIVERY_STATUSES:
                return False
            manifest["status"] = "cancelled"
            manifest["error"] = message
            manifest["current_node"] = None
            manifest["completed_at"] = _now_ms()
            manifest["updated_at"] = manifest["completed_at"]
            await self._persist_manifest(manifest)
            serialized = self._serialize_delivery(manifest)
        settle_prompt(manifest.get("prompt_id") or "", "cancelled")
        await self._broadcast_payload(
            manifest["project_id"],
            {"type": "delivery_update", "data": {"delivery": serialized}},
        )
        return True

    async def cancel_prompts(self, prompt_ids: Sequence[str]) -> dict[str, list[str]]:
        """Cancel prompts in ComfyUI and settle the ones it confirmably dropped.

        The ordering is the whole point, and each step earns its place:

        1. Read the *pending* half of ComfyUI's queue. Only a prompt that had
           not started can be dropped outright, so this is the candidate set;
           anything running is excluded before it can be mislabelled.
        2. Record the intent, so a reconcile racing the delete cannot reach
           "no longer known to ComfyUI" first and call this a failure.
        3. Delete by id, then interrupt by id. Neither is sufficient alone:
           `delete` only touches pending entries, so a prompt that started in
           between would survive it, and `interrupt` reaches only the prompt
           ComfyUI is executing. Both are id-scoped because the queue is one
           global FIFO — a bodyless clear or interrupt would hit work vlo does
           not own.
        4. Re-read the queue and history. A candidate now absent from both was
           deleted while pending: it never ran, so settling it — which releases
           its GPU occupancy — is a fact rather than a guess.

        Everything else is left to its monitor, which reads the same note and
        settles it as cancelled the moment ComfyUI says what happened. That is
        deliberately conservative: an interrupt is a request, not a stop, and
        releasing occupancy while the sampler is still unwinding is what puts
        two tenants on one card.

        Raises :class:`GenerationCancelError` if ComfyUI refuses the delete, in
        which case nothing was mutated and the notes are withdrawn.
        """

        await self._ensure_loaded()
        prompt_ids = list(prompt_ids)
        client = await get_http_client()

        pending_before = await self._pending_prompt_ids(force_refresh=True)
        candidates = (
            [prompt_id for prompt_id in prompt_ids if prompt_id in pending_before]
            if pending_before is not None
            else []
        )

        await self.note_prompts_cancelled(prompt_ids)
        try:
            response = await client.post("/queue", json={"delete": prompt_ids})
            response.raise_for_status()
        except Exception as exc:
            await self.discard_cancel_notes(prompt_ids)
            raise GenerationCancelError(str(exc)) from exc

        interrupt_failures: list[str] = []
        for prompt_id in prompt_ids:
            try:
                response = await client.post(
                    "/interrupt", json={"prompt_id": prompt_id}
                )
                response.raise_for_status()
            except Exception as exc:
                logger.warning("Interrupting prompt %s failed: %s", prompt_id, exc)
                interrupt_failures.append(prompt_id)

        # One forced read, shared by every candidate's reconcile below.
        await self._queue_sections(force_refresh=True)
        cancelled: list[str] = []
        for prompt_id in candidates:
            verdict, _ = await self._reconcile_prompt_state(prompt_id)
            if verdict != "missing":
                # Started, finished, or ComfyUI is unreachable. Not ours to
                # settle: the prompt may still own the GPU.
                continue
            async with self._lock:
                delivery_id = self._find_delivery_id_for_prompt_locked(prompt_id)
            if delivery_id and await self.mark_cancelled(delivery_id):
                cancelled.append(prompt_id)

        # An interrupt is the only thing that can stop a prompt ComfyUI has
        # started — `delete` is a no-op on it — so a failed interrupt on a
        # prompt that was not confirmably deleted means it was not cancelled at
        # all. It keeps running, and it will deliver: say so, rather than
        # letting the caller record a cancellation that never happened and
        # throw the outputs away when they arrive. Its note goes too, or the
        # generation's own later failure would be reported as this cancel.
        uncancelled = [
            prompt_id
            for prompt_id in interrupt_failures
            if prompt_id not in cancelled
        ]
        if uncancelled:
            await self.discard_cancel_notes(uncancelled)

        return {
            "requested": prompt_ids,
            "cancelled": cancelled,
            "uncancelled": uncancelled,
        }

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
            if manifest.get("status") == "cancelled":
                # A cancellation is only written once ComfyUI has confirmed the
                # prompt never ran (or that it was interrupted), so a completion
                # arriving afterwards is a stale race, not a late success.
                logger.warning(
                    "Ignoring completion for cancelled delivery %s", delivery_id
                )
                return
            manifest["status"] = "completed_pending_ack"
            manifest["progress"] = 100
            manifest["current_node"] = None
            manifest["outputs"] = outputs
            manifest["completed_at"] = _now_ms()
            manifest["updated_at"] = manifest["completed_at"]
            await self._persist_manifest(manifest)
            serialized = self._serialize_delivery(manifest)
        settle_prompt(manifest.get("prompt_id") or "", "succeeded")
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
        await self._sync_persisted_deliveries()
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
        await self._sync_persisted_deliveries()
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
        await self._sync_persisted_deliveries()
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
        await self._sync_persisted_deliveries()
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
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            logger.warning(
                "Generation delivery consumer for project %s failed: %s",
                project_id,
                exc,
            )
        finally:
            await self._unregister_consumer(consumer)

    async def start_monitor(
        self,
        *,
        project_id: str,
        delivery_id: str,
        prompt_id: str,
        client_id: str,
        wait_for_connection: bool = False,
        monitor_mode: str = "full",
    ) -> None:
        await self._ensure_loaded()
        existing = self._monitor_tasks.get(delivery_id)
        if existing and not existing.done():
            return
        connected = asyncio.Event()
        task = asyncio.create_task(
            self._monitor_delivery(
                project_id=project_id,
                delivery_id=delivery_id,
                prompt_id=prompt_id,
                client_id=client_id,
                connected_event=connected,
                monitor_mode=monitor_mode,
            )
        )
        self._monitor_tasks[delivery_id] = task
        if wait_for_connection:
            # Ensure the monitor's socket is registered with ComfyUI before
            # the prompt is dispatched, so fast/cached prompts can't complete
            # before anyone is listening. On timeout we proceed anyway — the
            # reconcile backstop covers missed events.
            try:
                await asyncio.wait_for(
                    connected.wait(),
                    timeout=MONITOR_CONNECT_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "Generation monitor for %s did not connect within %.1fs; "
                    "relying on reconcile backstop",
                    delivery_id,
                    MONITOR_CONNECT_TIMEOUT_SECONDS,
                )

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

    async def _broadcast_binary(self, project_id: str, payload: bytes) -> None:
        async with self._lock:
            consumers = list(self._project_consumers.get(project_id, []))
            active_id = self._active_consumer_id_by_project.get(project_id)
            active_consumer = next(
                (consumer for consumer in consumers if consumer.id == active_id),
                None,
            )
        if active_consumer is None:
            return
        try:
            await active_consumer.websocket.send_bytes(payload)
        except Exception:
            await self._unregister_consumer(active_consumer)

    async def _broadcast_text(self, project_id: str, payload: str) -> None:
        async with self._lock:
            consumers = list(self._project_consumers.get(project_id, []))
            active_id = self._active_consumer_id_by_project.get(project_id)
            active_consumer = next(
                (consumer for consumer in consumers if consumer.id == active_id),
                None,
            )
        if active_consumer is None:
            return
        try:
            await active_consumer.websocket.send_text(payload)
        except Exception:
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
                await asyncio.sleep(HISTORY_FETCH_RETRY_SECONDS)
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

    async def _capture_websocket_output(
        self,
        project_id: str,
        delivery_id: str,
        frame: bytes,
        frame_index: int,
    ) -> dict[str, Any] | None:
        extracted = _extract_image_bytes(frame)
        if not extracted:
            return None
        image_bytes, mime_type = extracted
        extension = _guess_extension(mime_type, "ws-output.png")
        filename = f"ws-{frame_index:06d}{extension}"
        storage_name = await self._write_file(
            project_id,
            delivery_id,
            "preview_frames",
            filename,
            image_bytes,
        )
        return {
            "filename": filename,
            "subfolder": "",
            "type": "output",
            "mime_type": mime_type,
            "storage_name": storage_name,
            "frame_index": frame_index,
        }

    def _build_output_from_preview_frame(
        self,
        preview_frame: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            "filename": preview_frame.get("filename", "ws-output.png"),
            "subfolder": "",
            "type": "output",
            "mime_type": preview_frame.get("mime_type", "application/octet-stream"),
            "storage_name": preview_frame["storage_name"],
            "category": "preview_frames",
        }

    async def _enrich_generation_metadata_from_history(
        self,
        delivery_id: str,
        prompt_id: str,
    ) -> None:
        """Backfill comfyuiPrompt/comfyuiWorkflow from ComfyUI history.

        Adopted in-editor deliveries are created with a stub
        ``generation_metadata`` (the bridge only knows the prompt id), which
        leaves the imported asset without the workflow record that
        regeneration replays. The history entry fetched at settle time carries
        both the API prompt and the authored graph, so lift them into the
        manifest before completion is broadcast. Panel submissions already
        stamp these fields at submission time and are skipped. Best-effort:
        enrichment must never block settlement.
        """
        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if manifest is None:
                return
            metadata = manifest.get("generation_metadata")
            if not isinstance(metadata, dict):
                return
            if metadata.get("comfyuiPrompt") and metadata.get("comfyuiWorkflow"):
                return

        try:
            client = await get_http_client()
            response = await client.get(f"/history/{prompt_id}")
            response.raise_for_status()
            history = response.json()
        except Exception:
            return

        extracted = _extract_history_prompt_metadata(history, prompt_id)
        if not extracted:
            return

        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if manifest is None:
                return
            metadata = manifest.get("generation_metadata")
            if not isinstance(metadata, dict):
                return
            changed = False
            for key, value in extracted.items():
                if not metadata.get(key):
                    metadata[key] = value
                    changed = True
            if changed:
                manifest["updated_at"] = _now_ms()
                await self._persist_manifest(manifest)

    async def _finalize_delivery(
        self,
        project_id: str,
        delivery_id: str,
        prompt_id: str,
        websocket_outputs: list[dict[str, Any]] | None = None,
    ) -> None:
        uses_ws_outputs = False
        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if manifest is not None:
                uses_ws_outputs = bool(
                    manifest.get("uses_save_image_websocket_outputs")
                )

        captured = websocket_outputs or []
        if uses_ws_outputs:
            preview_frames = captured
            outputs = (
                [self._build_output_from_preview_frame(preview_frames[-1])]
                if preview_frames
                else []
            )
        else:
            preview_frames = []
            outputs = await self._capture_history_outputs(
                project_id, delivery_id, prompt_id
            )

        if not outputs:
            await self.mark_error(
                delivery_id,
                "Generation completed without persisted final outputs for delivery",
            )
            return
        # Before completion is broadcast, so the frontend imports the asset
        # with the workflow record already attached.
        await self._enrich_generation_metadata_from_history(delivery_id, prompt_id)
        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if manifest is not None:
                manifest["preview_frames"] = preview_frames
                await self._persist_manifest(manifest)
        await self.mark_completed(delivery_id, outputs)

    async def _queue_sections(
        self,
        *,
        force_refresh: bool = False,
    ) -> _QueueSections | None:
        """What ComfyUI is running and what it has waiting, or ``None``.

        Shared across every delivery backstop with a short TTL — see
        :data:`QUEUE_SNAPSHOT_TTL_SECONDS`. ``force_refresh`` is for the caller
        that cannot act on a cached answer: confirming a cancellation needs the
        queue as it is *now*, not as it was up to a poll ago.
        """

        loop = asyncio.get_running_loop()

        def _fresh() -> tuple[bool, _QueueSections | None]:
            snapshot = self._queue_snapshot
            if (
                snapshot is not None
                and loop.time() - snapshot[0] < QUEUE_SNAPSHOT_TTL_SECONDS
            ):
                return True, snapshot[1]
            return False, None

        if not force_refresh:
            hit, cached = _fresh()
            if hit:
                return cached

        async with self._queue_snapshot_lock:
            # Re-checked: pollers that queued behind the lock are served by the
            # fetch they were waiting on rather than issuing their own. A forced
            # refresh still re-checks, because a fetch that started *after* this
            # caller asked is exactly the fresh answer it wanted.
            snapshot_before = self._queue_snapshot
            hit, cached = _fresh()
            if hit and (
                not force_refresh or snapshot_before is not self._queue_snapshot
            ):
                return cached
            try:
                client = await get_http_client()
                response = await client.get("/queue")
                response.raise_for_status()
                sections: _QueueSections | None = _parse_queue_sections(
                    response.json()
                )
            except Exception:
                sections = None
            self._queue_snapshot = (loop.time(), sections)
            return sections

    async def _queued_prompt_ids(
        self,
        *,
        force_refresh: bool = False,
    ) -> set[str] | None:
        sections = await self._queue_sections(force_refresh=force_refresh)
        return None if sections is None else sections.running | sections.pending

    async def _pending_prompt_ids(
        self,
        *,
        force_refresh: bool = False,
    ) -> set[str] | None:
        """Only the prompts ComfyUI has *not* started."""

        sections = await self._queue_sections(force_refresh=force_refresh)
        return None if sections is None else set(sections.pending)

    async def probe_comfyui_activity(self) -> str:
        """Whether ComfyUI has anything running or pending.

        Returns ``"busy"``, ``"idle"``, or ``"unknown"`` when ComfyUI could not
        be queried. Used to reconcile a submission whose prompt id is unknown:
        an empty queue is authoritative that nothing of ours is executing,
        whoever's prompt it was.
        """

        prompt_ids = await self._queued_prompt_ids()
        if prompt_ids is None:
            return "unknown"
        return "busy" if prompt_ids else "idle"

    async def watch_ambiguous_submission(self, lease: Any) -> None:
        """Own the GPU reservation of a submission whose fate is unknown.

        A transport failure on the proxy path means ComfyUI may or may not have
        queued the prompt, and the iframe's prompt id is only known from a
        response that never arrived. Releasing on that guess is what would put
        two tenants on one card, so the reservation is held until ComfyUI
        reports an *empty* queue — which is authoritative that nothing is
        executing — or an operator releases it explicitly.
        """

        idle_polls = 0
        unreachable = 0
        try:
            await asyncio.sleep(MONITOR_BACKSTOP_ONLY_INITIAL_DELAY_SECONDS)
            while lease.active:
                activity = await self.probe_comfyui_activity()
                if activity == "idle":
                    idle_polls += 1
                    unreachable = 0
                    if idle_polls >= AMBIGUOUS_SUBMISSION_IDLE_THRESHOLD:
                        lease.release("failed")
                        return
                elif activity == "busy":
                    idle_polls = 0
                    unreachable = 0
                else:
                    unreachable += 1
                    if unreachable >= MONITOR_UNREACHABLE_STALE_THRESHOLD:
                        get_model_work_coordinator().mark_entry_suspected_stale(
                            lease.entry_id,
                            "vlo lost contact with ComfyUI while submitting this "
                            "generation and cannot confirm whether it is running",
                        )
                await asyncio.sleep(MONITOR_BACKSTOP_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            # Shutdown. The process is going away, so the GPU goes with it.
            raise

    async def watch_unadopted_prompt(self, prompt_id: str) -> None:
        """Reconcile a prompt that holds GPU occupancy but has no delivery.

        The iframe proxy reserves before forwarding, so a prompt from a tab
        whose client id was never registered still holds a lease that nothing
        else would ever release. This is that prompt's watchdog: it settles only
        on an authoritative terminal/missing verdict from ComfyUI, and retains
        the occupancy as suspected-stale while ComfyUI is unreachable.
        """

        from services.model_work import get_model_work_coordinator

        coordinator = get_model_work_coordinator()
        misses = 0
        unreachable = 0
        await asyncio.sleep(MONITOR_BACKSTOP_ONLY_INITIAL_DELAY_SECONDS)
        while coordinator.token_for_prompt(prompt_id) is not None:
            verdict, error_message = await self._reconcile_prompt_state(prompt_id)
            if verdict == "completed":
                if error_message is None:
                    settle_prompt(prompt_id, "succeeded")
                elif (
                    error_message == GENERATION_INTERRUPTED_MESSAGE
                    or self.was_cancelled(prompt_id)
                ):
                    settle_prompt(prompt_id, "cancelled")
                else:
                    settle_prompt(prompt_id, "failed")
                return
            if verdict == "pending":
                misses = 0
                unreachable = 0
            elif verdict == "missing":
                unreachable = 0
                misses += 1
                if misses >= MONITOR_BACKSTOP_MISS_THRESHOLD:
                    settle_prompt(
                        prompt_id,
                        "cancelled" if self.was_cancelled(prompt_id) else "failed",
                    )
                    return
            else:
                unreachable += 1
                if unreachable >= MONITOR_UNREACHABLE_STALE_THRESHOLD:
                    mark_prompt_suspected_stale(
                        prompt_id,
                        "ComfyUI is unreachable; this generation's GPU claim "
                        "cannot be confirmed",
                    )
            await asyncio.sleep(MONITOR_BACKSTOP_INTERVAL_SECONDS)

    async def _reconcile_prompt_state(
        self,
        prompt_id: str,
    ) -> tuple[str, str | None]:
        """Classify a prompt against ComfyUI's history and queue.

        Returns one of:
        - ("completed", error_message | None): history has an entry; error
          message is set when the history records a failed/interrupted run.
        - ("pending", None): still in queue_running / queue_pending.
        - ("missing", None): unknown to both history and queue.
        - ("unknown", None): ComfyUI could not be queried (network trouble);
          callers should neither settle nor count this as a miss.
        """
        try:
            client = await get_http_client()
            response = await client.get(f"/history/{prompt_id}")
            response.raise_for_status()
            history = response.json()
        except Exception:
            return "unknown", None

        prompt_history = (
            history.get(prompt_id) if isinstance(history, dict) else None
        )
        if isinstance(prompt_history, dict):
            return "completed", _extract_history_error(prompt_history)

        queued_prompt_ids = await self._queued_prompt_ids()
        if queued_prompt_ids is None:
            return "unknown", None
        if prompt_id in queued_prompt_ids:
            return "pending", None
        return "missing", None

    async def _monitor_delivery(
        self,
        *,
        project_id: str,
        delivery_id: str,
        prompt_id: str,
        client_id: str,
        connected_event: asyncio.Event | None = None,
        monitor_mode: str = "full",
    ) -> None:
        current_node: str | None = None
        save_node_ids: set[str] = set()
        uses_ws_outputs = False
        async with self._lock:
            manifest = self._deliveries.get(delivery_id)
            if manifest is not None:
                uses_ws_outputs = bool(
                    manifest.get("uses_save_image_websocket_outputs")
                )
                save_node_ids = {
                    node_id
                    for node_id in manifest.get("save_image_websocket_node_ids") or []
                    if isinstance(node_id, str)
                }
        websocket_outputs: list[dict[str, Any]] = []
        settled = False

        async def _try_finalize() -> bool:
            """Finalize the delivery (success or honest error); idempotent.

            Returns False only when finalization itself failed (e.g. ComfyUI
            unreachable while fetching outputs) so the backstop can retry.
            """
            nonlocal settled
            if settled:
                return True
            try:
                await self._finalize_delivery(
                    project_id,
                    delivery_id,
                    prompt_id,
                    websocket_outputs,
                )
                settled = True
                return True
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(
                    "Finalizing delivery %s failed (will retry via backstop): %s",
                    delivery_id,
                    exc,
                )
                return False

        async def _settle_error(message: str) -> None:
            nonlocal settled
            if settled:
                return
            settled = True
            await self.mark_error(delivery_id, message)

        async def _settle_cancelled(message: str) -> None:
            nonlocal settled
            if settled:
                return
            settled = True
            await self.mark_cancelled(delivery_id, message)

        async def _handle_text_message(message: str) -> bool:
            """Process one JSON event; returns True when terminal."""
            nonlocal current_node
            try:
                event = json.loads(message)
            except json.JSONDecodeError:
                return False
            if not isinstance(event, dict):
                return False
            event_type = event.get("type")
            data = event.get("data")
            if not isinstance(data, dict):
                return False
            if event_type == "VHS_latentpreview":
                await self._broadcast_text(project_id, message)
                return False
            if data.get("prompt_id") != prompt_id:
                return False

            if event_type == "progress":
                value = data.get("value")
                maximum = data.get("max")
                progress = 0
                if (
                    isinstance(value, (int, float))
                    and isinstance(maximum, (int, float))
                    and maximum
                ):
                    progress = max(
                        0, min(100, round((float(value) / float(maximum)) * 100))
                    )
                progress_node = data.get("node")
                if isinstance(progress_node, str):
                    current_node = progress_node
                await self.mark_running(
                    delivery_id,
                    progress=progress,
                    current_node=progress_node
                    if isinstance(progress_node, str)
                    else None,
                )
            elif event_type == "executing":
                node = data.get("node")
                if node is None:
                    current_node = None
                    await _try_finalize()
                    return True
                if isinstance(node, str):
                    current_node = node
                    await self.mark_running(delivery_id, current_node=node)
            elif event_type == "execution_success":
                await _try_finalize()
                return True
            elif event_type == "execution_error":
                await _settle_error(
                    data.get("exception_message")
                    if isinstance(data.get("exception_message"), str)
                    else "Generation failed",
                )
                return True
            elif event_type == "execution_interrupted":
                # Someone pressed stop — vlo's cancel, the in-editor ComfyUI's,
                # or another client's. Never a fault of the generation.
                await _settle_cancelled(GENERATION_INTERRUPTED_MESSAGE)
                return True
            return False

        async def _handle_binary_message(message: bytes | bytearray | memoryview) -> None:
            frame = bytes(message)
            if not _is_preview_binary_frame(frame):
                return
            if (
                uses_ws_outputs
                and current_node is not None
                and current_node in save_node_ids
            ):
                captured = await self._capture_websocket_output(
                    project_id,
                    delivery_id,
                    frame,
                    len(websocket_outputs),
                )
                if captured is not None:
                    websocket_outputs.append(captured)
            await self._broadcast_binary(project_id, frame)

        async def _consume_events() -> None:
            """Websocket loop with bounded reconnects.

            A connection that ends without a terminal event (drop or clean
            close) counts against the reconnect budget. Healthy traffic resets
            that budget, so isolated drops during a long generation do not
            accumulate; once exhausted, the reconcile backstop owns resolution.
            """
            reconnects = 0
            while not settled:
                try:
                    async with websockets.connect(
                        _build_ws_url(client_id),
                        # SaveImageWebsocket can emit large full-size images;
                        # the client's default max_size (1 MiB) is too low.
                        max_size=None,
                        max_queue=None,
                    ) as comfy_ws:
                        if connected_event is not None:
                            connected_event.set()
                        await comfy_ws.send(PREVIEW_METADATA_FEATURE_FLAGS)
                        async for message in comfy_ws:
                            reconnects = 0
                            if isinstance(message, str):
                                if await _handle_text_message(message):
                                    return
                            else:
                                await _handle_binary_message(message)
                            if settled:
                                return
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning(
                        "Generation monitor websocket for %s dropped: %s",
                        delivery_id,
                        exc,
                    )
                if settled:
                    return
                reconnects += 1
                if reconnects > MONITOR_RECONNECT_ATTEMPTS:
                    logger.warning(
                        "Generation monitor websocket for %s gave up after %d "
                        "attempts; reconcile backstop owns resolution",
                        delivery_id,
                        reconnects - 1,
                    )
                    return
                await asyncio.sleep(
                    min(
                        MONITOR_RECONNECT_BASE_DELAY_SECONDS
                        * (2 ** (reconnects - 1)),
                        MONITOR_RECONNECT_MAX_DELAY_SECONDS,
                    )
                )

        async def _run_backstop() -> None:
            """Settle the delivery from /history + /queue if events are lost.

            Cadence and the "missing" threshold tighten while the delivery is
            still queued (never observed running): that is the window a queue
            clear/delete lands in, and the websocket offers no progress there
            anyway. Once running, the slower safety cadence resumes — the
            websocket is primary and only the brief queue→history transition
            could misread as missing.
            """
            await asyncio.sleep(
                MONITOR_BACKSTOP_ONLY_INITIAL_DELAY_SECONDS
                if monitor_mode == "backstop"
                else MONITOR_BACKSTOP_INITIAL_DELAY_SECONDS
            )
            misses = 0
            unreachable = 0
            while not settled:
                verdict, error_message = await self._reconcile_prompt_state(
                    prompt_id
                )
                if settled:
                    return
                # A synchronous dict read — no await, so no lock needed.
                manifest = self._deliveries.get(delivery_id)
                pre_running = (
                    manifest is not None and manifest.get("status") == "queued"
                )
                if verdict == "completed":
                    if error_message is not None:
                        # ComfyUI's own history says whether the run was
                        # interrupted, so a stopped generation reads as stopped
                        # even when the event was missed and no note survives —
                        # a dropped websocket, or a backend restart.
                        if error_message == GENERATION_INTERRUPTED_MESSAGE:
                            await _settle_cancelled(GENERATION_INTERRUPTED_MESSAGE)
                        elif self.was_cancelled(prompt_id):
                            await _settle_cancelled(GENERATION_CANCELLED_MESSAGE)
                        else:
                            await _settle_error(error_message)
                        return
                    if await _try_finalize():
                        return
                elif verdict == "pending":
                    misses = 0
                    unreachable = 0
                elif verdict == "missing":
                    misses += 1
                    unreachable = 0
                    threshold = (
                        MONITOR_BACKSTOP_QUEUED_MISS_THRESHOLD
                        if pre_running
                        else MONITOR_BACKSTOP_MISS_THRESHOLD
                    )
                    if misses >= threshold:
                        if self.was_cancelled(prompt_id):
                            await _settle_cancelled(GENERATION_CANCELLED_MESSAGE)
                        else:
                            await _settle_error(
                                "Prompt is no longer known to ComfyUI"
                            )
                        return
                else:
                    # "unknown": ComfyUI unreachable — neither settle nor count.
                    # The GPU occupancy is *retained* and flagged instead, so a
                    # network blip can never silently break exclusion; releasing
                    # it needs the Queue panel's explicit unsafe-release action.
                    unreachable += 1
                    if unreachable >= MONITOR_UNREACHABLE_STALE_THRESHOLD:
                        mark_prompt_suspected_stale(
                            prompt_id,
                            "ComfyUI is unreachable; this generation's GPU claim "
                            "cannot be confirmed",
                        )
                await asyncio.sleep(
                    MONITOR_BACKSTOP_QUEUED_INTERVAL_SECONDS
                    if pre_running
                    else MONITOR_BACKSTOP_INTERVAL_SECONDS
                )

        try:
            # Adopted in-editor generations run backstop-only: the iframe owns
            # the ComfyUI websocket for its own client_id, so a second monitor
            # socket would steal its job events. History/queue polling settles
            # the delivery; progress arrives via the bridge instead.
            pending: set[asyncio.Task[None]] = {asyncio.create_task(_run_backstop())}
            if monitor_mode != "backstop":
                pending.add(asyncio.create_task(_consume_events()))
            elif connected_event is not None:
                connected_event.set()
            try:
                while pending and not settled:
                    done, pending = await asyncio.wait(
                        pending, return_when=asyncio.FIRST_COMPLETED
                    )
                    for task in done:
                        exc = task.exception()
                        if exc is not None:
                            logger.warning(
                                "Generation monitor task for %s failed: %s",
                                delivery_id,
                                exc,
                            )
                if not settled and not pending:
                    await _settle_error(
                        "Generation monitor lost track of the prompt"
                    )
            finally:
                for task in pending:
                    task.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
        except asyncio.CancelledError:
            raise
        finally:
            if connected_event is not None:
                connected_event.set()
            self._monitor_tasks.pop(delivery_id, None)


generation_holding_service = GenerationHoldingService()


__all__ = ["GenerationHoldingService", "generation_holding_service"]
