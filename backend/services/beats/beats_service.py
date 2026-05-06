from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

import av

from config import (
    BEATTHIS_CACHE_DIR,
    BEATTHIS_DEFAULT_MODEL,
    BEATTHIS_DEVICE,
)


class BeatThisConfigError(RuntimeError):
    """Raised when Beat This! runtime configuration is invalid (e.g. missing optional dep)."""


class BeatThisRuntimeError(RuntimeError):
    """Raised when beat detection inference fails."""


class BeatThisSourceNotFoundError(FileNotFoundError):
    """Raised when an audio source ID is missing from cache."""


@dataclass(frozen=True)
class BeatPrediction:
    time_seconds: float
    is_downbeat: bool


@dataclass(frozen=True)
class BeatThisSourceMetadata:
    source_id: str
    path: Path

    def to_response(self) -> dict[str, Any]:
        return {"sourceId": self.source_id}

    def to_json(self) -> dict[str, Any]:
        return {"sourceId": self.source_id, "path": str(self.path)}

    @classmethod
    def from_json(cls, payload: dict[str, Any]) -> "BeatThisSourceMetadata":
        return cls(
            source_id=str(payload["sourceId"]),
            path=Path(str(payload["path"])),
        )


SOURCES_DIR = BEATTHIS_CACHE_DIR / "sources"
METADATA_DIR = BEATTHIS_CACHE_DIR / "metadata"
SOURCES_DIR.mkdir(parents=True, exist_ok=True)
METADATA_DIR.mkdir(parents=True, exist_ok=True)


def _sanitize_source_hash(source_hash: str) -> str:
    sanitized = "".join(ch for ch in source_hash.strip() if ch.isalnum() or ch in "-_")
    if not sanitized:
        raise ValueError("source_hash must contain at least one valid character")
    return sanitized


def _metadata_path(source_id: str) -> Path:
    return METADATA_DIR / f"{source_id}.json"


def _load_source_metadata(source_id: str) -> BeatThisSourceMetadata | None:
    path = _metadata_path(source_id)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        metadata = BeatThisSourceMetadata.from_json(payload)
        if not metadata.path.exists():
            return None
        return metadata
    except Exception:
        return None


def _save_source_metadata(metadata: BeatThisSourceMetadata) -> None:
    _metadata_path(metadata.source_id).write_text(
        json.dumps(metadata.to_json(), indent=2),
        encoding="utf-8",
    )


_TARGET_SAMPLE_RATE = 22_050


def _transcode_audio_to_wav(input_bytes: bytes, output_path: Path) -> None:
    """Decodes any container/codec PyAV understands and writes a mono 22.05 kHz WAV.

    Beat This! loads audio through torchaudio, which only handles non-WAV
    containers when an extra backend (ffmpeg) is installed. Decoding here with
    PyAV keeps the inference path independent of torchaudio backends.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with NamedTemporaryFile(delete=False) as tmp:
        tmp.write(input_bytes)
        tmp.flush()
        tmp_path = Path(tmp.name)

    try:
        try:
            input_container = av.open(str(tmp_path))
        except Exception as exc:
            raise BeatThisRuntimeError(f"Could not open audio for decoding: {exc}") from exc

        try:
            if not input_container.streams.audio:
                raise BeatThisRuntimeError("Uploaded file has no audio stream")

            in_audio = input_container.streams.audio[0]
            output_container = av.open(str(output_path), mode="w", format="wav")
            try:
                out_audio = output_container.add_stream(
                    "pcm_s16le",
                    rate=_TARGET_SAMPLE_RATE,
                )
                out_audio.layout = "mono"
                resampler = av.audio.resampler.AudioResampler(
                    format="s16",
                    layout="mono",
                    rate=_TARGET_SAMPLE_RATE,
                )

                for frame in input_container.decode(in_audio):
                    frame.pts = None
                    for resampled in resampler.resample(frame):
                        for packet in out_audio.encode(resampled):
                            output_container.mux(packet)

                for resampled in resampler.resample(None) or []:
                    for packet in out_audio.encode(resampled):
                        output_container.mux(packet)

                for packet in out_audio.encode(None):
                    output_container.mux(packet)
            finally:
                output_container.close()
        finally:
            input_container.close()
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def register_source_bytes(
    source_hash: str,
    filename: str,
    data: bytes,
) -> BeatThisSourceMetadata:
    source_id = _sanitize_source_hash(source_hash)

    existing = _load_source_metadata(source_id)
    if existing is not None and existing.path.suffix.lower() == ".wav":
        return existing

    if existing is not None:
        try:
            existing.path.unlink()
        except FileNotFoundError:
            pass

    source_path = SOURCES_DIR / f"{source_id}.wav"
    _transcode_audio_to_wav(data, source_path)

    metadata = BeatThisSourceMetadata(source_id=source_id, path=source_path)
    _save_source_metadata(metadata)
    return metadata


def get_source_metadata(source_id: str) -> BeatThisSourceMetadata:
    normalized_id = _sanitize_source_hash(source_id)
    metadata = _load_source_metadata(normalized_id)
    if metadata is None:
        raise BeatThisSourceNotFoundError(
            f"Beat This! source '{normalized_id}' was not found"
        )
    return metadata


class _BeatThisRuntime:
    """Lazy-loaded singleton wrapper around the File2Beats predictor."""

    def __init__(self) -> None:
        self._predictor: Any | None = None
        self._predictor_key: tuple[str, str, bool] | None = None
        self._resolved_device: str | None = None
        self._lock = threading.Lock()

    def _cuda_available(self) -> bool:
        try:
            import torch  # type: ignore

            return bool(torch.cuda.is_available())
        except Exception:
            return False

    def _resolve_device(self, requested_device: str) -> str:
        normalized = requested_device.strip().lower()
        if not normalized or normalized == "auto":
            return "cuda" if self._cuda_available() else "cpu"
        if normalized.startswith("cuda") and not self._cuda_available():
            raise BeatThisConfigError(
                "BEATTHIS_DEVICE was set to cuda, but torch.cuda.is_available() is false"
            )
        return requested_device.strip()

    def _build_predictor(
        self,
        checkpoint: str,
        device: str,
        dbn: bool,
    ) -> Any:
        try:
            from beat_this.inference import File2Beats  # type: ignore
        except Exception as exc:
            raise BeatThisConfigError(
                "Failed to import beat_this. Install it with: "
                "pip install beat-this einops soxr rotary-embedding-torch"
            ) from exc

        if dbn:
            try:
                import madmom  # type: ignore  # noqa: F401
            except Exception as exc:
                raise BeatThisConfigError(
                    "DBN postprocessing requires the madmom package. Install it with: "
                    "pip install git+https://github.com/CPJKU/madmom.git"
                ) from exc

        try:
            return File2Beats(checkpoint_path=checkpoint, device=device, dbn=dbn)
        except Exception as exc:
            raise BeatThisConfigError(
                f"Failed to initialize Beat This! predictor ({exc})"
            ) from exc

    def get_predictor(self, checkpoint: str, dbn: bool) -> Any:
        device = self._resolve_device(BEATTHIS_DEVICE)
        key = (checkpoint, device, dbn)
        if self._predictor is not None and self._predictor_key == key:
            return self._predictor
        with self._lock:
            if self._predictor is None or self._predictor_key != key:
                self._predictor = self._build_predictor(checkpoint, device, dbn)
                self._predictor_key = key
                self._resolved_device = device
        return self._predictor

    def health(self) -> dict[str, Any]:
        try:
            import beat_this  # type: ignore  # noqa: F401

            ready = True
            error: str | None = None
        except Exception as exc:
            ready = False
            error = str(exc)
        return {
            "ready": ready,
            "device": BEATTHIS_DEVICE,
            "resolvedDevice": self._resolved_device,
            "predictorLoaded": self._predictor is not None,
            "defaultModel": BEATTHIS_DEFAULT_MODEL,
            "error": error,
        }


_runtime = _BeatThisRuntime()


def _detect_beats_with_predictor(
    predictor: Any,
    audio_path: Path,
) -> tuple[list[float], list[float]]:
    try:
        beats, downbeats = predictor(str(audio_path))
    except Exception as exc:
        raise BeatThisRuntimeError(f"Beat detection failed: {exc}") from exc

    def _to_float_list(values: Any) -> list[float]:
        if values is None:
            return []
        try:
            return [float(v) for v in values]
        except Exception as exc:
            raise BeatThisRuntimeError(
                f"Beat This! returned an unexpected output type: {type(values)!r}"
            ) from exc

    return _to_float_list(beats), _to_float_list(downbeats)


def detect_beats(
    source_id: str,
    ticks_per_second: float,
    dbn: bool = False,
    model: str | None = None,
) -> dict[str, Any]:
    if ticks_per_second <= 0:
        raise ValueError(f"ticks_per_second must be > 0, got {ticks_per_second}")

    source = get_source_metadata(source_id)
    checkpoint = (model or BEATTHIS_DEFAULT_MODEL).strip() or BEATTHIS_DEFAULT_MODEL

    predictor = _runtime.get_predictor(checkpoint=checkpoint, dbn=dbn)
    beats_sec, downbeats_sec = _detect_beats_with_predictor(predictor, source.path)

    downbeat_set = {round(t, 6) for t in downbeats_sec}
    beats_payload: list[dict[str, Any]] = []
    for time_sec in beats_sec:
        time_ticks = max(0.0, float(time_sec) * float(ticks_per_second))
        beats_payload.append(
            {
                "timeSeconds": float(time_sec),
                "timeTicks": time_ticks,
                "isDownbeat": round(time_sec, 6) in downbeat_set,
            }
        )

    return {
        "sourceId": source.source_id,
        "modelName": checkpoint,
        "dbn": bool(dbn),
        "beats": beats_payload,
        "downbeatCount": len(downbeats_sec),
        "beatCount": len(beats_sec),
    }


def get_health() -> dict[str, Any]:
    return {
        "status": "ok",
        "runtime": _runtime.health(),
        "cacheDir": str(BEATTHIS_CACHE_DIR),
    }
