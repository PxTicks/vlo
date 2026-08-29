"""Short-lived retention of a submission's prepared media bytes.

A queued batch is one submission repeated: every copy needs byte-identical
media and differs only in randomized widget values. Making each copy re-upload
those bytes from the browser is what kept a batch trickling into ComfyUI one
slow request at a time — and a frontend that went away mid-trickle took the
undispatched copies with it.

So the first request of a group hands its buffered media here, and its siblings
submit a group id instead of file parts. Restoring rebuilds exactly the
``buffered_media`` mapping the router would have parsed from the form, so
everything downstream — validation, mask crop, upload/registration, and the
stale-reference recovery in ``upload_media`` — runs unchanged and cannot tell
the difference.

Retention is deliberately short and best-effort. This is a submission-time
accelerator, never a source of truth: a miss simply means the caller has to
send the bytes again.
"""

from __future__ import annotations

import json
import logging
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from config import RUNTIME_ROOT

logger = logging.getLogger(__name__)

PREPARED_MEDIA_ROOT = RUNTIME_ROOT / "prepared_media"

# Long enough to cover a queued batch whose ComfyUI runs are slow, short enough
# that abandoned groups do not accumulate.
PREPARED_MEDIA_TTL_SECONDS = 60 * 60

# A ceiling on retained groups, oldest evicted first. Bytes here are a copy of
# what ComfyUI already holds, so losing one only costs a re-upload.
PREPARED_MEDIA_MAX_GROUPS = 8

_MANIFEST_NAME = "manifest.json"
# Keys carried verbatim from the router's buffered-media dict. `bytes` is
# excluded: it lives in a sidecar file, not the manifest.
_METADATA_KEYS = (
    "node_id",
    "param",
    "input_type",
    "class_type",
    "content_type",
    "filename",
    "batch_index",
    "item_options",
)


def is_valid_group_id(group_id: Any) -> bool:
    """Whether ``group_id`` is safe to use as a directory name.

    The id comes from the client, so it is constrained to the hex-and-dashes
    shape the frontend generates rather than trusted as a path component.
    """

    if not isinstance(group_id, str) or not (8 <= len(group_id) <= 64):
        return False
    return all(char.isalnum() or char == "-" for char in group_id)


def _group_root(group_id: str) -> Path:
    return PREPARED_MEDIA_ROOT / group_id


def _sweep(now: float) -> None:
    """Drop expired groups, then trim the oldest down to the group cap.

    Callers sweep *after* inserting, never before: trimming to the cap and then
    adding leaves one more group on disk than the cap allows.
    """

    if not PREPARED_MEDIA_ROOT.is_dir():
        return

    surviving: list[tuple[float, Path]] = []
    for group_dir in PREPARED_MEDIA_ROOT.iterdir():
        if not group_dir.is_dir():
            continue
        manifest_path = group_dir / _MANIFEST_NAME
        try:
            stored_at = json.loads(manifest_path.read_text(encoding="utf-8"))[
                "stored_at"
            ]
        except (OSError, json.JSONDecodeError, KeyError, TypeError):
            # Unreadable or half-written: it can never be restored, so it is
            # only taking up space.
            shutil.rmtree(group_dir, ignore_errors=True)
            continue
        if now - stored_at > PREPARED_MEDIA_TTL_SECONDS:
            shutil.rmtree(group_dir, ignore_errors=True)
            continue
        surviving.append((stored_at, group_dir))

    surviving.sort(key=lambda item: item[0])
    for _, group_dir in surviving[: max(0, len(surviving) - PREPARED_MEDIA_MAX_GROUPS)]:
        shutil.rmtree(group_dir, ignore_errors=True)


def store_prepared_media(
    group_id: str,
    buffered_media: dict[str, dict[str, Any]],
) -> bool:
    """Retain ``buffered_media`` under ``group_id``. Returns whether it stuck.

    The caller reports the outcome back to the frontend, which only switches a
    group to reference-only submission once it has been told the bytes are
    actually held.
    """

    if not is_valid_group_id(group_id) or not buffered_media:
        return False

    now = time.time()
    group_root = _group_root(group_id)
    # Written to a scratch directory and moved into place, so a crash midway
    # cannot leave a manifest that promises files which were never written.
    staging_root = PREPARED_MEDIA_ROOT / f".staging-{uuid.uuid4().hex}"
    try:
        staging_root.mkdir(parents=True, exist_ok=True)

        entries: dict[str, dict[str, Any]] = {}
        for index, (buffer_key, media_info) in enumerate(buffered_media.items()):
            media_bytes = media_info.get("bytes")
            if not isinstance(media_bytes, (bytes, bytearray)):
                continue
            payload_name = f"{index}.bin"
            (staging_root / payload_name).write_bytes(media_bytes)
            entries[buffer_key] = {
                "payload": payload_name,
                **{
                    key: media_info[key]
                    for key in _METADATA_KEYS
                    if key in media_info
                },
            }

        if not entries:
            shutil.rmtree(staging_root, ignore_errors=True)
            return False

        (staging_root / _MANIFEST_NAME).write_text(
            json.dumps({"stored_at": now, "entries": entries}, indent=2),
            encoding="utf-8",
        )
        shutil.rmtree(group_root, ignore_errors=True)
        staging_root.replace(group_root)
        # Swept with the new group already in place, so the cap counts it.
        _sweep(now)
        return True
    except OSError as exc:
        logger.warning("Failed to retain prepared media for group %s: %s", group_id, exc)
        shutil.rmtree(staging_root, ignore_errors=True)
        return False


def load_prepared_media(group_id: str) -> dict[str, dict[str, Any]] | None:
    """Rebuild the router's ``buffered_media`` mapping, or None on any miss.

    A miss is ordinary — expired, evicted, or a backend that restarted — and
    the caller's answer is always the same: ask the client to resend the bytes.
    """

    if not is_valid_group_id(group_id):
        return None

    # Sweeping here as well as on store is what actually retires an abandoned
    # group: a batch that is queued and then never repeated does no further
    # store, so without this its bytes would outlive the TTL indefinitely.
    _sweep(time.time())

    group_root = _group_root(group_id)
    manifest_path = group_root / _MANIFEST_NAME
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    stored_at = manifest.get("stored_at")
    entries = manifest.get("entries")
    if not isinstance(stored_at, (int, float)) or not isinstance(entries, dict):
        return None
    if time.time() - stored_at > PREPARED_MEDIA_TTL_SECONDS:
        shutil.rmtree(group_root, ignore_errors=True)
        return None

    buffered_media: dict[str, dict[str, Any]] = {}
    for buffer_key, entry in entries.items():
        if not isinstance(buffer_key, str) or not isinstance(entry, dict):
            return None
        payload_name = entry.get("payload")
        if not isinstance(payload_name, str):
            return None
        try:
            media_bytes = (group_root / payload_name).read_bytes()
        except OSError:
            return None
        buffered_media[buffer_key] = {
            **{key: entry[key] for key in _METADATA_KEYS if key in entry},
            "bytes": media_bytes,
        }

    # All-or-nothing: a partially restored group would silently generate from
    # the wrong inputs, which is worse than re-uploading.
    return buffered_media or None


def sweep_prepared_media() -> None:
    """Retire expired and over-cap groups.

    Called at startup so bytes left behind by a backend that stopped mid-batch
    are not stranded until the next submission happens to sweep them.
    """

    _sweep(time.time())


__all__ = [
    "PREPARED_MEDIA_TTL_SECONDS",
    "is_valid_group_id",
    "load_prepared_media",
    "store_prepared_media",
    "sweep_prepared_media",
]
