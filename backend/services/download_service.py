"""Generic model download service.

Provides a reusable download engine that streams files from URLs to local paths
with progress tracking via callbacks. Downloads write to .tmp files and rename
on completion to prevent partial files from being discovered.

Jobs are processed by a single server-side worker (one at a time), so any
caller — individual download, "download all" batch, or a different workflow tab
— enqueues onto the same FIFO queue. This makes the queue robust against
client navigation, tab throttling, or page reload: jobs continue running
server-side and reappear via /downloads/models?activeJobId when the client
returns.
"""

from __future__ import annotations

import asyncio
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import httpx

CHUNK_SIZE = 256 * 1024  # 256 KB

JobStatus = Literal["queued", "downloading", "complete", "failed", "cancelled"]


@dataclass
class DownloadFileSpec:
    url: str
    dest_path: str  # absolute path
    filename: str


@dataclass
class DownloadProgress:
    current_file_index: int = 0
    total_files: int = 0
    current_file_bytes: int = 0
    current_file_total: int | None = None
    overall_bytes: int = 0
    overall_bytes_total: int | None = None

    def to_dict(self) -> dict:
        return {
            "currentFileIndex": self.current_file_index,
            "totalFiles": self.total_files,
            "currentFileBytes": self.current_file_bytes,
            "currentFileTotal": self.current_file_total,
            "overallBytes": self.overall_bytes,
            "overallBytesTotal": self.overall_bytes_total,
        }


@dataclass
class DownloadJob:
    job_id: str
    label: str
    files: list[DownloadFileSpec]
    status: JobStatus = "queued"
    progress: DownloadProgress = field(default_factory=DownloadProgress)
    error: str | None = None
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    progress_event: asyncio.Event | None = None
    auth_token: str | None = None
    queue_position: int = 0

    def to_dict(self) -> dict:
        return {
            "jobId": self.job_id,
            "label": self.label,
            "status": self.status,
            "progress": self.progress.to_dict(),
            "error": self.error,
            "queuePosition": self.queue_position,
        }


_active_jobs: dict[str, DownloadJob] = {}
_active_destinations: dict[str, str] = {}
_job_destinations: dict[str, set[str]] = {}
_registry_lock = threading.Lock()

# At-most-one in-flight download. Created lazily on the first job inside the
# running event loop (Semaphore is loop-affine in older Python builds).
_download_semaphore: asyncio.Semaphore | None = None
_pending_job_ids: list[str] = []  # FIFO ordering, mirrors semaphore queue


def _normalize_destinations(files: list[DownloadFileSpec]) -> set[str]:
    return {str(Path(file.dest_path).resolve()) for file in files}


def _release_job_destinations(job_id: str) -> None:
    with _registry_lock:
        reserved_destinations = _job_destinations.pop(job_id, set())
        for dest_path in reserved_destinations:
            if _active_destinations.get(dest_path) == job_id:
                del _active_destinations[dest_path]


def _recompute_queue_positions() -> None:
    """Update each queued job's position so the SSE stream tells clients
    how many jobs are ahead of theirs."""
    with _registry_lock:
        for position, job_id in enumerate(_pending_job_ids):
            job = _active_jobs.get(job_id)
            if job is None:
                continue
            new_position = position
            if job.queue_position != new_position:
                job.queue_position = new_position
                event = job.progress_event
                if event is not None:
                    event.set()


def _remove_from_pending(job_id: str) -> None:
    with _registry_lock:
        try:
            _pending_job_ids.remove(job_id)
        except ValueError:
            pass
    _recompute_queue_positions()


def _notify_progress(job: DownloadJob) -> None:
    event = job.progress_event
    if event is not None:
        event.set()


async def _execute_download_job(job: DownloadJob) -> None:
    job.status = "downloading"
    job.queue_position = 0
    _notify_progress(job)
    job.progress.total_files = len(job.files)

    overall_downloaded_prior_files: int = 0

    # httpx strips Authorization on cross-origin redirects by default, so
    # the Bearer token is only sent to the initial huggingface.co request
    # — the CDN URL it redirects to is already presigned and rejects
    # forwarded auth.
    request_headers: dict[str, str] = {}
    if job.auth_token:
        request_headers["Authorization"] = f"Bearer {job.auth_token}"

    async with httpx.AsyncClient(
        follow_redirects=True, timeout=httpx.Timeout(30.0, read=300.0)
    ) as client:
        for file_index, file_spec in enumerate(job.files):
            if job.cancel_event.is_set():
                job.status = "cancelled"
                _notify_progress(job)
                return

            job.progress.current_file_index = file_index
            job.progress.current_file_bytes = 0
            job.progress.current_file_total = None

            dest = Path(file_spec.dest_path)
            tmp_path = dest.with_suffix(dest.suffix + ".tmp")
            dest.parent.mkdir(parents=True, exist_ok=True)

            try:
                async with client.stream(
                    "GET", file_spec.url, headers=request_headers or None
                ) as response:
                    response.raise_for_status()

                    content_length = response.headers.get("content-length")
                    if content_length is not None:
                        job.progress.current_file_total = int(content_length)

                    with open(tmp_path, "wb") as f:
                        async for chunk in response.aiter_bytes(CHUNK_SIZE):
                            if job.cancel_event.is_set():
                                job.status = "cancelled"
                                tmp_path.unlink(missing_ok=True)
                                _notify_progress(job)
                                return

                            f.write(chunk)
                            job.progress.current_file_bytes += len(chunk)
                            job.progress.overall_bytes = (
                                overall_downloaded_prior_files
                                + job.progress.current_file_bytes
                            )
                            _notify_progress(job)

                tmp_path.rename(dest)
                overall_downloaded_prior_files += job.progress.current_file_bytes

            except Exception as exc:
                tmp_path.unlink(missing_ok=True)
                job.status = "failed"
                job.error = f"Failed to download {file_spec.filename}: {exc}"
                _notify_progress(job)
                return

    job.status = "complete"
    _notify_progress(job)


async def _process_job(job: DownloadJob) -> None:
    """Wait for the queue slot, then run the job. Always releases the
    destination reservation when the job leaves the queue, regardless of
    outcome — so a cancelled queued job frees its slot immediately."""
    global _download_semaphore
    try:
        if job.cancel_event.is_set():
            job.status = "cancelled"
            _notify_progress(job)
            return

        if _download_semaphore is None:
            _download_semaphore = asyncio.Semaphore(1)

        async with _download_semaphore:
            _remove_from_pending(job.job_id)
            if job.cancel_event.is_set():
                job.status = "cancelled"
                _notify_progress(job)
                return
            await _execute_download_job(job)
    except Exception as exc:  # noqa: BLE001 — last-resort failure surface
        job.status = "failed"
        job.error = f"Download worker crashed: {exc}"
        _notify_progress(job)
    finally:
        # If the job never entered the semaphore (cancel before slot), still
        # clean up its queue entry.
        _remove_from_pending(job.job_id)
        _release_job_destinations(job.job_id)


def start_download(
    label: str,
    files: list[DownloadFileSpec],
    auth_token: str | None = None,
) -> DownloadJob:
    """Enqueue a download. Returns immediately; the worker processes
    queued jobs one at a time. If another job already holds any of these
    destination paths, returns that job instead of creating a duplicate."""
    requested_destinations = _normalize_destinations(files)

    with _registry_lock:
        conflicting_job_ids = {
            _active_destinations[dest_path]
            for dest_path in requested_destinations
            if dest_path in _active_destinations
        }
        if conflicting_job_ids:
            if len(conflicting_job_ids) == 1:
                existing_job_id = next(iter(conflicting_job_ids))
                existing_job = _active_jobs.get(existing_job_id)
                existing_destinations = _job_destinations.get(existing_job_id, set())
                if (
                    existing_job is not None
                    and existing_job.status in ("queued", "downloading")
                    and existing_destinations == requested_destinations
                ):
                    return existing_job

            raise ValueError(
                "A download is already in progress for one or more destination files"
            )

        job = DownloadJob(
            job_id=str(uuid.uuid4()),
            label=label,
            files=files,
            auth_token=auth_token,
            status="queued",
        )
        _active_jobs[job.job_id] = job
        _job_destinations[job.job_id] = requested_destinations
        for dest_path in requested_destinations:
            _active_destinations[dest_path] = job.job_id
        _pending_job_ids.append(job.job_id)

    job.progress_event = asyncio.Event()

    loop = asyncio.get_running_loop()
    loop.create_task(_process_job(job))

    _recompute_queue_positions()
    return job


def get_job(job_id: str) -> DownloadJob | None:
    with _registry_lock:
        return _active_jobs.get(job_id)


def find_active_jobs_for_paths(paths: set[str]) -> dict[str, str]:
    """Return a mapping of {destination_path: job_id} for any of `paths`
    that are currently queued or downloading."""
    if not paths:
        return {}

    normalized = {str(Path(p).resolve()) for p in paths}
    result: dict[str, str] = {}
    with _registry_lock:
        for path in normalized:
            job_id = _active_destinations.get(path)
            if job_id is None:
                continue
            job = _active_jobs.get(job_id)
            if job is None or job.status not in ("queued", "downloading"):
                continue
            result[path] = job_id
    return result


def cancel_job(job_id: str) -> bool:
    with _registry_lock:
        job = _active_jobs.get(job_id)
    if job is None:
        return False
    job.cancel_event.set()
    _notify_progress(job)
    return True
