import asyncio
import threading
from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from services.sam_audio import sam_audio_service
from services.sam_audio.sam_audio_encoding import encode_wav_bytes
from services.sam_audio.sam_audio_service import (
    SAM_AUDIO_SAMPLE_RATE,
    SamAudioSeparationResult,
    SamAudioSourceMetadata,
)


def _configure_tmp_cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    sources_dir = tmp_path / "sources"
    metadata_dir = tmp_path / "metadata"
    sources_dir.mkdir(parents=True, exist_ok=True)
    metadata_dir.mkdir(parents=True, exist_ok=True)
    stems_dir = tmp_path / "stems"
    stems_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(sam_audio_service, "SOURCES_DIR", sources_dir)
    monkeypatch.setattr(sam_audio_service, "METADATA_DIR", metadata_dir)
    monkeypatch.setattr(sam_audio_service, "STEMS_DIR", stems_dir)


@pytest.mark.requires_torch
def test_extract_source_window_is_sample_exact(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_tmp_cache(monkeypatch, tmp_path)
    source_path = tmp_path / "source.wav"
    samples = np.arange(SAM_AUDIO_SAMPLE_RATE, dtype=np.float32) / SAM_AUDIO_SAMPLE_RATE
    sf.write(source_path, samples, SAM_AUDIO_SAMPLE_RATE)

    metadata = SamAudioSourceMetadata(
        source_id="source",
        source_hash="source",
        path=source_path,
        sample_rate=SAM_AUDIO_SAMPLE_RATE,
        channels=1,
        duration_sec=1.0,
        duration_ticks=96_000,
    )
    sam_audio_service._save_source_metadata(metadata)

    window = sam_audio_service._extract_source_window(
        "source",
        start_ticks=30_000,
        duration_ticks=10_000,
    )

    assert tuple(window.shape) == (1, 5_000)
    np.testing.assert_allclose(
        window.squeeze(0).numpy(),
        samples[15_000:20_000],
        atol=1e-4,
    )


def test_encode_wav_bytes_round_trips() -> None:
    audio = np.stack(
        [
            np.linspace(-0.25, 0.25, 1_000, dtype=np.float32),
            np.linspace(0.25, -0.25, 1_000, dtype=np.float32),
        ],
        axis=0,
    )

    wav_bytes = encode_wav_bytes(audio, SAM_AUDIO_SAMPLE_RATE)
    decoded, sample_rate = sf.read(
        BytesIO(wav_bytes),
        dtype="float32",
        always_2d=True,
    )

    assert sample_rate == SAM_AUDIO_SAMPLE_RATE
    assert decoded.shape == (1_000, 2)
    np.testing.assert_allclose(decoded[:, 0], audio[0], atol=1e-4)


@pytest.mark.anyio
async def test_job_lifecycle_completes_and_fetches_stems(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_tmp_cache(monkeypatch, tmp_path)
    await sam_audio_service._reset_jobs_for_tests()
    metadata = SamAudioSourceMetadata(
        source_id="source",
        source_hash="source",
        path=Path("/tmp/source.wav"),
        sample_rate=SAM_AUDIO_SAMPLE_RATE,
        channels=1,
        duration_sec=1.0,
        duration_ticks=96_000,
    )
    monkeypatch.setattr(
        sam_audio_service,
        "get_source_metadata",
        lambda source_id: metadata,
    )
    monkeypatch.setattr(
        sam_audio_service,
        "_extract_source_window",
        lambda source_id, start_ticks, duration_ticks: np.zeros(
            (1, 10), dtype=np.float32
        ),
    )

    stem_bytes = encode_wav_bytes(np.zeros(10, dtype=np.float32), SAM_AUDIO_SAMPLE_RATE)

    def fake_run_separation(
        window_audio,
        prompt,
        start_ticks,
        duration_ticks,
        *,
        timings=None,
        on_progress=None,
    ):
        del window_audio, prompt, start_ticks, on_progress
        if timings is not None:
            timings["modelSeparateSec"] = 0.001
        return SamAudioSeparationResult(
            target_wav_bytes=stem_bytes,
            residual_wav_bytes=stem_bytes,
            sample_rate=SAM_AUDIO_SAMPLE_RATE,
            duration_ticks=duration_ticks,
            predicted_spans=[[('+', float("nan"), 1.0)]],
        )

    monkeypatch.setattr(sam_audio_service, "run_separation", fake_run_separation)

    job = await sam_audio_service.submit_separation_job(
        source=metadata,
        start_ticks=0,
        duration_ticks=20,
        prompt={"text": "tone"},
    )
    try:
        for _ in range(200):
            current = sam_audio_service.get_job_or_raise(job.job_id)
            if current.status == "done":
                break
            await asyncio.sleep(0.01)

        current = sam_audio_service.get_job_or_raise(job.job_id)
        assert current.status == "done", current.to_dict()
        assert current.progress == 1.0
        assert current.to_dict()["timings"]["modelSeparateSec"] == 0.001

        target_bytes, result = sam_audio_service.get_job_stem(job.job_id, "target")
        assert target_bytes == stem_bytes
        assert result.duration_ticks == 20
        assert result.predicted_spans is None

        residual_bytes, _ = sam_audio_service.get_job_stem(job.job_id, "residual")
        assert residual_bytes == stem_bytes

        target_bytes_again, _ = sam_audio_service.get_job_stem(job.job_id, "target")
        assert target_bytes_again == stem_bytes
    finally:
        await asyncio.wait_for(sam_audio_service.shutdown_jobs(), timeout=2)


@pytest.mark.anyio
async def test_failed_job_retains_live_timings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_tmp_cache(monkeypatch, tmp_path)
    await sam_audio_service._reset_jobs_for_tests()
    metadata = SamAudioSourceMetadata(
        source_id="source",
        source_hash="source",
        path=tmp_path / "source.wav",
        sample_rate=SAM_AUDIO_SAMPLE_RATE,
        channels=1,
        duration_sec=1.0,
        duration_ticks=96_000,
    )
    monkeypatch.setattr(
        sam_audio_service,
        "_extract_source_window",
        lambda source_id, start_ticks, duration_ticks: np.zeros((1, 10)),
    )
    timing_reported = threading.Event()
    release = threading.Event()

    def fail_separation(*args, timings=None, **kwargs):
        del args, kwargs
        assert timings is not None
        timings["modelLoadSec"] = 0.5
        timing_reported.set()
        assert release.wait(timeout=2)
        raise RuntimeError("inference failed")

    monkeypatch.setattr(sam_audio_service, "run_separation", fail_separation)
    job = await sam_audio_service.submit_separation_job(
        metadata,
        0,
        20,
        {"text": "tone"},
    )
    try:
        for _ in range(200):
            if timing_reported.is_set():
                break
            await asyncio.sleep(0.01)
        running = sam_audio_service.get_job_or_raise(job.job_id)
        assert running.status == "running"
        assert running.timings == {"modelLoadSec": 0.5}
        release.set()

        for _ in range(200):
            current = sam_audio_service.get_job_or_raise(job.job_id)
            if current.status == "error":
                break
            await asyncio.sleep(0.01)
        assert current.status == "error"
        assert current.timings == {"modelLoadSec": 0.5}
    finally:
        release.set()
        await sam_audio_service.shutdown_jobs()


@pytest.mark.anyio
async def test_sam_capacity_soft_evicts_terminal_jobs_and_declares_long_timeout(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_tmp_cache(monkeypatch, tmp_path)
    monkeypatch.setattr(sam_audio_service, "MAX_JOBS", 3)
    await sam_audio_service._reset_jobs_for_tests()
    metadata = SamAudioSourceMetadata(
        source_id="source",
        source_hash="source",
        path=tmp_path / "source.wav",
        sample_rate=SAM_AUDIO_SAMPLE_RATE,
        channels=1,
        duration_sec=1.0,
        duration_ticks=96_000,
    )
    try:
        manager = sam_audio_service._get_job_manager()
        job_types = await manager.list_job_types(
            sam_audio_service.SAM_AUDIO_JOB_OWNER
        )
        assert job_types[0]["timeoutSeconds"] == (
            sam_audio_service.SAM_AUDIO_JOB_TIMEOUT_SECONDS
        )

        for _ in range(4):
            submitted = await sam_audio_service.submit_separation_job(
                metadata,
                0,
                20,
                {"text": "tone"},
            )
            await sam_audio_service.cancel_job(submitted.job_id)
    finally:
        await sam_audio_service.shutdown_jobs()


@pytest.mark.anyio
async def test_cancel_queued_job_preserves_serial_execution(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_tmp_cache(monkeypatch, tmp_path)
    await sam_audio_service._reset_jobs_for_tests()
    metadata = SamAudioSourceMetadata(
        source_id="source",
        source_hash="source",
        path=tmp_path / "source.wav",
        sample_rate=SAM_AUDIO_SAMPLE_RATE,
        channels=1,
        duration_sec=1.0,
        duration_ticks=96_000,
    )
    monkeypatch.setattr(
        sam_audio_service,
        "get_source_metadata",
        lambda source_id: metadata,
    )
    monkeypatch.setattr(
        sam_audio_service,
        "_extract_source_window",
        lambda source_id, start_ticks, duration_ticks: np.zeros((1, 10)),
    )
    started = threading.Event()
    release = threading.Event()

    def blocking_separation(*args, **kwargs):
        del args, kwargs
        started.set()
        assert release.wait(timeout=2)
        stem = encode_wav_bytes(
            np.zeros(10, dtype=np.float32),
            SAM_AUDIO_SAMPLE_RATE,
        )
        return SamAudioSeparationResult(
            target_wav_bytes=stem,
            residual_wav_bytes=stem,
            sample_rate=SAM_AUDIO_SAMPLE_RATE,
            duration_ticks=20,
        )

    monkeypatch.setattr(sam_audio_service, "run_separation", blocking_separation)
    first = await sam_audio_service.submit_separation_job(
        metadata, 0, 20, {"text": "first"}
    )
    try:
        for _ in range(100):
            if started.is_set():
                break
            await asyncio.sleep(0.01)
        assert started.is_set(), sam_audio_service.get_job_or_raise(
            first.job_id
        ).to_dict()
        queued = await sam_audio_service.submit_separation_job(
            metadata, 0, 20, {"text": "queued"}
        )
        assert sam_audio_service.get_job_or_raise(queued.job_id).status == "queued"

        cancelled = await sam_audio_service.cancel_job(queued.job_id)

        assert cancelled.status == "cancelled"
        assert cancelled.cancel_requested is True
        assert cancelled.progress == 1.0
        assert cancelled.message == "Cancelled"
        assert sam_audio_service.get_job_or_raise(first.job_id).status == "running"
    finally:
        release.set()
        for _ in range(100):
            if sam_audio_service.get_job_or_raise(first.job_id).status == "done":
                break
            await asyncio.sleep(0.01)
        await asyncio.wait_for(sam_audio_service.shutdown_jobs(), timeout=2)
