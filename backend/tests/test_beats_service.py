import math
import os
import sys
from pathlib import Path

import av
import numpy as np
import pytest

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.beats import beats_service  # noqa: E402
from services.beats.beats_service import (  # noqa: E402
    BeatThisRuntimeError,
    BeatThisSourceNotFoundError,
)


def _configure_tmp_cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    sources_dir = tmp_path / "sources"
    metadata_dir = tmp_path / "metadata"
    sources_dir.mkdir(parents=True, exist_ok=True)
    metadata_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(beats_service, "SOURCES_DIR", sources_dir)
    monkeypatch.setattr(beats_service, "METADATA_DIR", metadata_dir)


def _write_sine_wav(path: Path, *, duration_sec: float = 0.5, sample_rate: int = 44_100) -> None:
    """Write a short mono PCM WAV using PyAV (round-trippable through our transcoder)."""
    container = av.open(str(path), mode="w", format="wav")
    try:
        stream = container.add_stream("pcm_s16le", rate=sample_rate)
        stream.layout = "mono"

        total_samples = int(sample_rate * duration_sec)
        chunk = 1024
        position = 0
        while position < total_samples:
            n = min(chunk, total_samples - position)
            t = (np.arange(position, position + n, dtype=np.float32) / sample_rate)
            samples = (np.sin(2 * math.pi * 440.0 * t) * 0.25 * 32_767).astype(np.int16)
            frame = av.AudioFrame.from_ndarray(
                samples.reshape(1, -1), format="s16", layout="mono"
            )
            frame.sample_rate = sample_rate
            for packet in stream.encode(frame):
                container.mux(packet)
            position += n

        for packet in stream.encode(None):
            container.mux(packet)
    finally:
        container.close()


def _read_audio_bytes(path: Path) -> bytes:
    return path.read_bytes()


def test_register_source_bytes_transcodes_to_wav(monkeypatch, tmp_path):
    _configure_tmp_cache(monkeypatch, tmp_path)

    src = tmp_path / "input.wav"
    _write_sine_wav(src, duration_sec=0.25, sample_rate=44_100)

    metadata = beats_service.register_source_bytes(
        "abc123",
        "input.wav",
        _read_audio_bytes(src),
    )

    assert metadata.source_id == "abc123"
    assert metadata.path.suffix == ".wav"
    assert metadata.path.exists()

    with av.open(str(metadata.path)) as container:
        audio_stream = container.streams.audio[0]
        # Service normalizes everything to mono 22.05 kHz.
        assert audio_stream.rate == 22_050
        codec_context = audio_stream.codec_context
        channel_count = (
            getattr(codec_context, "channels", None)
            or getattr(audio_stream, "channels", None)
        )
        assert channel_count == 1


def test_register_source_bytes_dedupes_existing_wav(monkeypatch, tmp_path):
    _configure_tmp_cache(monkeypatch, tmp_path)

    src = tmp_path / "input.wav"
    _write_sine_wav(src, duration_sec=0.25)
    data = _read_audio_bytes(src)

    first = beats_service.register_source_bytes("abc123", "input.wav", data)
    first_mtime = first.path.stat().st_mtime_ns

    second = beats_service.register_source_bytes("abc123", "input.wav", data)
    assert second.path == first.path
    # File should not have been rewritten since the cached entry is already WAV.
    assert second.path.stat().st_mtime_ns == first_mtime


def test_register_source_bytes_replaces_legacy_non_wav(monkeypatch, tmp_path):
    _configure_tmp_cache(monkeypatch, tmp_path)

    sources_dir = tmp_path / "sources"
    legacy_path = sources_dir / "legacy.mp3"
    legacy_path.write_bytes(b"not really an mp3")
    metadata_path = (tmp_path / "metadata") / "legacy.json"
    metadata_path.write_text(
        f'{{"sourceId": "legacy", "path": "{legacy_path.as_posix()}"}}',
        encoding="utf-8",
    )

    src = tmp_path / "fresh.wav"
    _write_sine_wav(src, duration_sec=0.25)
    fresh_metadata = beats_service.register_source_bytes(
        "legacy",
        "fresh.wav",
        _read_audio_bytes(src),
    )

    # The legacy non-WAV cache entry must be replaced with the transcoded WAV.
    assert fresh_metadata.path.suffix == ".wav"
    assert fresh_metadata.path.exists()
    assert not legacy_path.exists()


def test_register_source_bytes_rejects_empty_hash(monkeypatch, tmp_path):
    _configure_tmp_cache(monkeypatch, tmp_path)

    with pytest.raises(ValueError):
        beats_service.register_source_bytes("   ", "input.wav", b"\x00")


def test_get_source_metadata_raises_when_missing(monkeypatch, tmp_path):
    _configure_tmp_cache(monkeypatch, tmp_path)

    with pytest.raises(BeatThisSourceNotFoundError):
        beats_service.get_source_metadata("nope")


def test_detect_beats_validates_ticks_per_second(monkeypatch, tmp_path):
    _configure_tmp_cache(monkeypatch, tmp_path)

    with pytest.raises(ValueError):
        beats_service.detect_beats("anything", ticks_per_second=0)


def test_detect_beats_converts_seconds_to_ticks_and_marks_downbeats(
    monkeypatch, tmp_path
):
    _configure_tmp_cache(monkeypatch, tmp_path)

    src = tmp_path / "input.wav"
    _write_sine_wav(src, duration_sec=0.5)
    beats_service.register_source_bytes("track1", "input.wav", _read_audio_bytes(src))

    fake_beats_sec = [0.25, 0.5, 0.75, 1.0]
    fake_downbeats_sec = [0.25, 1.0]

    class _FakePredictor:
        def __call__(self, audio_path):  # noqa: D401 - mimic File2Beats API
            return fake_beats_sec, fake_downbeats_sec

    def _fake_get_predictor(checkpoint, dbn):
        assert checkpoint == "test-model"
        assert dbn is False
        return _FakePredictor()

    monkeypatch.setattr(beats_service._runtime, "get_predictor", _fake_get_predictor)

    response = beats_service.detect_beats(
        "track1",
        ticks_per_second=96_000,
        dbn=False,
        model="test-model",
    )

    assert response["sourceId"] == "track1"
    assert response["modelName"] == "test-model"
    assert response["dbn"] is False
    assert response["beatCount"] == 4
    assert response["downbeatCount"] == 2

    # Tick conversion is `time_seconds * ticks_per_second`.
    assert [b["timeTicks"] for b in response["beats"]] == [
        0.25 * 96_000,
        0.5 * 96_000,
        0.75 * 96_000,
        1.0 * 96_000,
    ]

    # Downbeats are flagged where the seconds value matches.
    flags = [b["isDownbeat"] for b in response["beats"]]
    assert flags == [True, False, False, True]


def test_detect_beats_propagates_runtime_errors(monkeypatch, tmp_path):
    _configure_tmp_cache(monkeypatch, tmp_path)

    src = tmp_path / "input.wav"
    _write_sine_wav(src, duration_sec=0.25)
    beats_service.register_source_bytes("track1", "input.wav", _read_audio_bytes(src))

    class _BrokenPredictor:
        def __call__(self, _audio_path):
            raise RuntimeError("boom")

    monkeypatch.setattr(
        beats_service._runtime,
        "get_predictor",
        lambda checkpoint, dbn: _BrokenPredictor(),
    )

    with pytest.raises(BeatThisRuntimeError):
        beats_service.detect_beats("track1", ticks_per_second=96_000)
