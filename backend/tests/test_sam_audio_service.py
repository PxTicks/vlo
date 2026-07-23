import time
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
    monkeypatch.setattr(sam_audio_service, "SOURCES_DIR", sources_dir)
    monkeypatch.setattr(sam_audio_service, "METADATA_DIR", metadata_dir)


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


def test_job_lifecycle_completes_and_fetches_stems(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sam_audio_service._reset_jobs_for_tests()
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
        lambda source_id, start_ticks, duration_ticks: np.zeros((1, 10), dtype=np.float32),
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
        )

    monkeypatch.setattr(sam_audio_service, "run_separation", fake_run_separation)

    job = sam_audio_service.enqueue_separation_job(
        source_id="source",
        start_ticks=0,
        duration_ticks=20,
        prompt={"text": "tone"},
    )

    deadline = time.time() + 2
    while time.time() < deadline:
        current = sam_audio_service.get_job_or_raise(job.job_id)
        if current.status == "done":
            break
        time.sleep(0.01)

    current = sam_audio_service.get_job_or_raise(job.job_id)
    assert current.status == "done"
    assert current.progress == 1.0
    assert current.to_dict()["timings"]["modelSeparateSec"] == 0.001

    target_bytes, result = sam_audio_service.get_job_stem(job.job_id, "target")
    assert target_bytes == stem_bytes
    assert result.duration_ticks == 20

    residual_bytes, _ = sam_audio_service.get_job_stem(job.job_id, "residual")
    assert residual_bytes == stem_bytes

    target_bytes_again, _ = sam_audio_service.get_job_stem(job.job_id, "target")
    assert target_bytes_again == stem_bytes


def test_cancel_queued_job_removes_it_from_queue() -> None:
    sam_audio_service._reset_jobs_for_tests()
    job = sam_audio_service.SamAudioJob(
        job_id="queued-job",
        source_id="source",
        start_ticks=0,
        duration_ticks=20,
        prompt={"text": "tone"},
    )

    with sam_audio_service._queue_condition:
        sam_audio_service._jobs[job.job_id] = job
        sam_audio_service._queue.append(job.job_id)

    cancelled = sam_audio_service.cancel_job(job.job_id)

    assert cancelled.status == "cancelled"
    assert cancelled.cancel_requested is True
    assert cancelled.progress == 1.0
    assert cancelled.message == "Cancelled"
    with sam_audio_service._queue_condition:
        assert job.job_id not in sam_audio_service._queue
