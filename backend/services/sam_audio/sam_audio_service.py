from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from importlib.machinery import ModuleSpec
from types import ModuleType
from pathlib import Path
from typing import Any, Literal, TypedDict

import av
import numpy as np

from config import (
    SAM_AUDIO_CACHE_DIR,
    SAM_AUDIO_DEFAULT_MODEL,
    SAM_AUDIO_DEVICE,
    SAM_AUDIO_LOAD_OPTIONAL_MODELS,
    SAM_AUDIO_SEARCH_PATHS,
)
from services.sam_audio.sam_audio_discovery import (
    discover_sam_audio_models,
    get_local_sam_audio_model_path,
)
from services.sam_audio.sam_audio_encoding import SamAudioEncodingError, encode_wav_bytes
from services.sam2 import sam2_service
from services.sam2.sam2_service import Sam2RuntimeError, Sam2SourceNotFoundError


TICKS_PER_SECOND = 96_000
SAM_AUDIO_SAMPLE_RATE = 48_000
TICKS_PER_SAMPLE = TICKS_PER_SECOND // SAM_AUDIO_SAMPLE_RATE
FINISHED_JOB_TTL_SECONDS = 15 * 60
MAX_JOBS = 64

SOURCES_DIR = SAM_AUDIO_CACHE_DIR / "sources"
METADATA_DIR = SAM_AUDIO_CACHE_DIR / "metadata"
STEMS_DIR = SAM_AUDIO_CACHE_DIR / "stems"
HF_CACHE_DIR = SAM_AUDIO_CACHE_DIR / "hf"
for _dir in (SOURCES_DIR, METADATA_DIR, STEMS_DIR, HF_CACHE_DIR):
    _dir.mkdir(parents=True, exist_ok=True)

JobStatus = Literal["queued", "running", "done", "error"]
StemKind = Literal["target", "residual"]
Anchor = tuple[str, float, float]
logger = logging.getLogger(__name__)


class SamAudioConfigError(RuntimeError):
    """Raised when SAM-Audio runtime configuration is invalid."""


class SamAudioRuntimeError(RuntimeError):
    """Raised when SAM-Audio processing fails."""


class SamAudioSourceNotFoundError(FileNotFoundError):
    """Raised when a registered audio source is missing."""


class SamAudioJobNotFoundError(KeyError):
    """Raised when an async SAM-Audio job ID is unknown."""


class SamAudioJobNotReadyError(RuntimeError):
    """Raised when a stem is requested before a job has completed."""


class SamAudioPrompt(TypedDict, total=False):
    text: str
    anchors: list[list[Anchor]]
    sam2SourceId: str
    sam2MaskId: str
    predictSpans: bool
    rerankingCandidates: int


@dataclass(frozen=True)
class SamAudioSourceMetadata:
    source_id: str
    source_hash: str
    path: Path
    sample_rate: int
    channels: int
    duration_sec: float
    duration_ticks: int

    def to_response(self) -> dict[str, Any]:
        return {
            "sourceId": self.source_id,
            "sampleRate": self.sample_rate,
            "channels": self.channels,
            "durationSec": self.duration_sec,
            "durationTicks": self.duration_ticks,
        }

    def to_json(self) -> dict[str, Any]:
        payload = self.to_response()
        payload["sourceHash"] = self.source_hash
        payload["path"] = str(self.path)
        return payload

    @classmethod
    def from_json(cls, payload: dict[str, Any]) -> "SamAudioSourceMetadata":
        return cls(
            source_id=str(payload["sourceId"]),
            source_hash=str(payload.get("sourceHash", payload["sourceId"])),
            path=Path(str(payload["path"])),
            sample_rate=int(payload["sampleRate"]),
            channels=int(payload["channels"]),
            duration_sec=float(payload["durationSec"]),
            duration_ticks=int(payload["durationTicks"]),
        )


@dataclass(frozen=True)
class SamAudioSeparationResult:
    target_wav_bytes: bytes
    residual_wav_bytes: bytes
    sample_rate: int
    duration_ticks: int
    predicted_spans: list[list[Anchor]] | None = None


@dataclass
class SamAudioJob:
    job_id: str
    source_id: str
    start_ticks: int
    duration_ticks: int
    prompt: SamAudioPrompt
    status: JobStatus = "queued"
    progress: float = 0.0
    message: str | None = "Waiting for SAM-Audio worker"
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    result: SamAudioSeparationResult | None = None
    fetched_stems: set[StemKind] = field(default_factory=set)

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "jobId": self.job_id,
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "error": self.error,
            "sourceId": self.source_id,
            "startTicks": self.start_ticks,
            "durationTicks": self.duration_ticks,
        }
        if self.result is not None:
            payload["sampleRate"] = self.result.sample_rate
            payload["resultDurationTicks"] = self.result.duration_ticks
            if self.result.predicted_spans is not None:
                payload["predictedSpans"] = self.result.predicted_spans
        return payload


class _SamAudioRuntime:
    """Lazy singleton around SAM-Audio model + processor."""

    def __init__(self) -> None:
        self._model: Any | None = None
        self._processor: Any | None = None
        self._resolved_device: str | None = None
        self._selected_model_ref: str | None = None
        self._lock = threading.Lock()

    def _cuda_available(self) -> bool:
        try:
            import torch  # type: ignore

            return bool(torch.cuda.is_available())
        except Exception:  # pragma: no cover - environment dependent
            return False

    def _resolve_candidate_devices(self, requested_device: str) -> list[str]:
        raw = requested_device.strip()
        normalized = raw.lower()
        cuda_available = self._cuda_available()

        if not normalized or normalized == "auto":
            return ["cuda"] if cuda_available else ["cpu"]

        if normalized.startswith("cuda"):
            if not cuda_available:
                raise SamAudioConfigError(
                    "SAM_AUDIO_DEVICE was set to cuda, but torch.cuda.is_available() is false"
                )
            return [raw]

        return [raw]

    def _ensure_sam_audio_pythonpath(self, *, include_default_checkout: bool) -> None:
        candidates: list[str] = []
        explicit = os.environ.get("SAM_AUDIO_PYTHONPATH", "").strip()
        if explicit:
            candidates.append(explicit)
        if include_default_checkout:
            candidates.append(str(Path.home() / "sam-audio"))

        for candidate in candidates:
            path = Path(candidate).expanduser()
            if path.exists() and str(path) not in sys.path:
                sys.path.insert(0, str(path))

    def _ensure_xformers_ops_importable(self) -> None:
        try:
            from xformers.ops import AttentionBias, fmha  # type: ignore  # noqa: F401
            return
        except Exception:
            pass

        try:
            import xformers  # type: ignore
        except Exception:
            xformers = ModuleType("xformers")
            sys.modules["xformers"] = xformers

        ops_module = ModuleType("xformers.ops")
        fmha_module = ModuleType("xformers.ops.fmha")
        ops_module.__spec__ = ModuleSpec("xformers.ops", loader=None)
        fmha_module.__spec__ = ModuleSpec("xformers.ops.fmha", loader=None)

        class AttentionBias:  # pragma: no cover - exercised by SAM-Audio import
            pass

        def memory_efficient_attention(
            query: Any,
            key: Any,
            value: Any,
            attn_bias: Any = None,
            p: float = 0.0,
            scale: float | None = None,
            **_: Any,
        ) -> Any:
            import torch  # type: ignore
            from torch.nn import functional as torch_functional  # type: ignore

            if attn_bias is not None and not torch.is_tensor(attn_bias):
                raise SamAudioConfigError(
                    "SAM-Audio requested an xFormers attention bias that is not "
                    "available in this environment. Reinstall compatible xformers "
                    "and flash-attn packages for the backend Python/PyTorch build."
                )

            if query.ndim == 4:
                query = query.transpose(1, 2)
                key = key.transpose(1, 2)
                value = value.transpose(1, 2)
                kwargs = {
                    "attn_mask": attn_bias,
                    "dropout_p": p,
                }
                if scale is not None:
                    kwargs["scale"] = scale
                output = torch_functional.scaled_dot_product_attention(
                    query,
                    key,
                    value,
                    **kwargs,
                )
                return output.transpose(1, 2).contiguous()

            kwargs = {
                "attn_mask": attn_bias,
                "dropout_p": p,
            }
            if scale is not None:
                kwargs["scale"] = scale
            return torch_functional.scaled_dot_product_attention(
                query,
                key,
                value,
                **kwargs,
            )

        fmha_module.memory_efficient_attention = memory_efficient_attention  # type: ignore[attr-defined]
        ops_module.AttentionBias = AttentionBias  # type: ignore[attr-defined]
        ops_module.fmha = fmha_module  # type: ignore[attr-defined]
        setattr(xformers, "ops", ops_module)
        sys.modules["xformers.ops"] = ops_module
        sys.modules["xformers.ops.fmha"] = fmha_module

    def _ensure_torchcodec_decoders_importable(self) -> None:
        try:
            from torchcodec.decoders import AudioDecoder, VideoDecoder  # type: ignore  # noqa: F401
            return
        except Exception:
            pass

        torchcodec_module = ModuleType("torchcodec")
        decoders_module = ModuleType("torchcodec.decoders")
        torchcodec_module.__spec__ = ModuleSpec("torchcodec", loader=None, is_package=True)
        decoders_module.__spec__ = ModuleSpec("torchcodec.decoders", loader=None)

        class _TorchCodecDecoderUnavailable:  # pragma: no cover - import shim
            def __init__(self, *_: Any, **__: Any) -> None:
                raise SamAudioConfigError(
                    "SAM-Audio tried to decode media through torchcodec, but "
                    "torchcodec could not load in this backend environment. "
                    "Install a torchcodec build compatible with the backend "
                    "Python/PyTorch/FFmpeg stack, or pass decoded tensors."
                )

        decoders_module.AudioDecoder = _TorchCodecDecoderUnavailable  # type: ignore[attr-defined]
        decoders_module.VideoDecoder = _TorchCodecDecoderUnavailable  # type: ignore[attr-defined]
        torchcodec_module.decoders = decoders_module  # type: ignore[attr-defined]
        sys.modules["torchcodec"] = torchcodec_module
        sys.modules["torchcodec.decoders"] = decoders_module

    def _resolve_model_ref(self) -> str:
        model_key = SAM_AUDIO_DEFAULT_MODEL
        local_path = get_local_sam_audio_model_path(model_key)
        if local_path is not None:
            return str(local_path)
        if "/" in model_key:
            return model_key
        return f"facebook/{model_key}"

    def _import_sam_audio_classes(self) -> tuple[Any, Any]:
        try:
            from sam_audio import SAMAudio, SAMAudioProcessor  # type: ignore

            return SAMAudio, SAMAudioProcessor
        except ModuleNotFoundError as exc:
            if exc.name != "sam_audio":
                raise

        self._ensure_sam_audio_pythonpath(include_default_checkout=True)
        from sam_audio import SAMAudio, SAMAudioProcessor  # type: ignore

        return SAMAudio, SAMAudioProcessor

    def _load_for_device(self, device: str) -> tuple[Any, Any, str]:
        self._ensure_sam_audio_pythonpath(include_default_checkout=False)
        self._ensure_xformers_ops_importable()
        self._ensure_torchcodec_decoders_importable()
        try:
            SAMAudio, SAMAudioProcessor = self._import_sam_audio_classes()
        except Exception as exc:  # pragma: no cover - environment dependent
            raise SamAudioConfigError(
                "Failed to import SAM-Audio. The sam_audio package may be missing, "
                "SAM_AUDIO_PYTHONPATH may point to the wrong checkout, or one of "
                f"SAM-Audio's transitive dependencies failed to import: {exc}"
            ) from exc

        model_ref = self._resolve_model_ref()
        model_kwargs: dict[str, Any] = {}
        if not SAM_AUDIO_LOAD_OPTIONAL_MODELS:
            # SAM-Audio's full config eagerly constructs rankers/span predictors that
            # are only needed for reranking and automatic span prediction. Those
            # dependencies are large and can make normal isolate jobs look hung.
            model_kwargs = {
                "visual_ranker": None,
                "text_ranker": None,
                "span_predictor": None,
            }

        logger.info(
            "Loading SAM-Audio model %s on %s (optional models: %s)",
            model_ref,
            device,
            "enabled" if SAM_AUDIO_LOAD_OPTIONAL_MODELS else "disabled",
        )
        try:
            if hasattr(SAMAudio, "_from_pretrained"):
                model = SAMAudio._from_pretrained(
                    model_id=model_ref,
                    cache_dir=str(HF_CACHE_DIR),
                    force_download=False,
                    proxies=None,
                    resume_download=False,
                    local_files_only=False,
                    token=None,
                    map_location="cpu",
                    revision=None,
                    **model_kwargs,
                )
            else:
                model = SAMAudio.from_pretrained(
                    model_ref,
                    cache_dir=str(HF_CACHE_DIR),
                    map_location="cpu",
                    **model_kwargs,
                )
            processor = SAMAudioProcessor.from_pretrained(model_ref)
        except Exception as exc:  # pragma: no cover - environment/model dependent
            raise SamAudioConfigError(
                "Failed to load SAM-Audio model or one of its first-load "
                "dependencies. If the underlying error mentions 401/403 or a "
                "gated repository, accept the Hugging Face license and authenticate "
                "the backend environment with `hf auth login` or an access token. "
                "SAM-Audio also initializes dependent PE-AV and T5 assets during "
                "normal startup. High-quality reranking/span dependencies are only "
                "loaded when SAM_AUDIO_LOAD_OPTIONAL_MODELS=1. "
                f"Underlying error: {exc}"
            ) from exc

        try:
            model = model.eval().to(device)
        except Exception as exc:  # pragma: no cover - environment/device dependent
            raise SamAudioConfigError(f"Failed to move SAM-Audio model to {device}") from exc

        return model, processor, model_ref

    def get(self) -> tuple[Any, Any, str]:
        if self._model is not None and self._processor is not None:
            return self._model, self._processor, self._resolved_device or "cpu"

        with self._lock:
            if self._model is not None and self._processor is not None:
                return self._model, self._processor, self._resolved_device or "cpu"

            requested_device = SAM_AUDIO_DEVICE.strip() or "auto"
            candidate_devices = self._resolve_candidate_devices(requested_device)
            errors: list[str] = []
            for device in candidate_devices:
                try:
                    model, processor, model_ref = self._load_for_device(device)
                    self._model = model
                    self._processor = processor
                    self._resolved_device = device
                    self._selected_model_ref = model_ref
                    return model, processor, device
                except Exception as exc:  # pragma: no cover - environment dependent
                    errors.append(f"{device}: {exc}")

        raise SamAudioConfigError(
            f"Failed to initialize SAM-Audio runtime ({'; '.join(errors) or 'unknown error'})"
        )

    def health(self) -> dict[str, Any]:
        discovered_models = discover_sam_audio_models()
        return {
            "ready": len(discovered_models) > 0,
            "device": SAM_AUDIO_DEVICE,
            "resolvedDevice": self._resolved_device,
            "selectedModel": SAM_AUDIO_DEFAULT_MODEL,
            "selectedModelRef": self._selected_model_ref,
            "discoveredModels": discovered_models,
            "modelLoaded": self._model is not None,
        }


_runtime = _SamAudioRuntime()

_jobs: dict[str, SamAudioJob] = {}
_queue: deque[str] = deque()
_registry_lock = threading.RLock()
_queue_condition = threading.Condition(_registry_lock)
_worker_thread: threading.Thread | None = None


def _sanitize_source_hash(source_hash: str) -> str:
    sanitized = "".join(ch for ch in source_hash.strip() if ch.isalnum() or ch in "-_")
    if not sanitized:
        raise ValueError("source_hash must contain at least one valid character")
    return sanitized


def _metadata_path(source_id: str) -> Path:
    return METADATA_DIR / f"{source_id}.json"


def _load_source_metadata(source_id: str) -> SamAudioSourceMetadata | None:
    metadata_path = _metadata_path(source_id)
    if not metadata_path.exists():
        return None
    try:
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata = SamAudioSourceMetadata.from_json(payload)
        if not metadata.path.exists():
            return None
        return metadata
    except Exception:
        return None


def _save_source_metadata(metadata: SamAudioSourceMetadata) -> None:
    _metadata_path(metadata.source_id).write_text(
        json.dumps(metadata.to_json(), indent=2),
        encoding="utf-8",
    )


def _resolve_audio_duration_sec(container: av.container.InputContainer, stream: Any) -> float:
    if stream.duration is not None and stream.time_base is not None:
        try:
            duration = float(stream.duration * stream.time_base)
            if duration > 0:
                return duration
        except Exception:
            pass
    if container.duration is not None:
        duration = float(container.duration / av.time_base)
        if duration > 0:
            return duration
    return 0.0


def _inspect_audio(audio_path: Path) -> SamAudioSourceMetadata:
    try:
        container = av.open(str(audio_path))
    except Exception as exc:
        raise SamAudioRuntimeError(f"Unable to open source audio: {audio_path}") from exc

    try:
        if not container.streams.audio:
            raise SamAudioRuntimeError(f"Source contains no audio stream: {audio_path}")

        stream = container.streams.audio[0]
        codec_context = stream.codec_context
        sample_rate = int(getattr(stream, "rate", None) or codec_context.rate or 0)
        raw_channels = getattr(codec_context, "channels", None)
        if raw_channels is None:
            layout_channels = getattr(getattr(codec_context, "layout", None), "channels", None)
            try:
                raw_channels = len(layout_channels)
            except Exception:
                raw_channels = 1
        channels = int(raw_channels or 1)
        duration_sec = _resolve_audio_duration_sec(container, stream)
    finally:
        container.close()

    if sample_rate <= 0:
        sample_rate = SAM_AUDIO_SAMPLE_RATE
    if channels <= 0:
        channels = 1
    if duration_sec <= 0:
        duration_sec = 0.0

    source_id = audio_path.stem.split(".", 1)[0]
    return SamAudioSourceMetadata(
        source_id=source_id,
        source_hash=source_id,
        path=audio_path,
        sample_rate=sample_rate,
        channels=channels,
        duration_sec=duration_sec,
        duration_ticks=int(round(duration_sec * TICKS_PER_SECOND)),
    )


def register_source_bytes(
    source_hash: str,
    filename: str,
    data: bytes,
) -> SamAudioSourceMetadata:
    source_id = _sanitize_source_hash(source_hash)
    existing = _load_source_metadata(source_id)
    if existing is not None:
        return existing

    suffix = Path(filename).suffix if filename else ""
    if not suffix:
        suffix = ".wav"
    source_path = SOURCES_DIR / f"{source_id}{suffix}"
    source_path.write_bytes(data)

    metadata = _inspect_audio(source_path)
    normalized = SamAudioSourceMetadata(
        source_id=source_id,
        source_hash=source_id,
        path=source_path,
        sample_rate=metadata.sample_rate,
        channels=metadata.channels,
        duration_sec=metadata.duration_sec,
        duration_ticks=metadata.duration_ticks,
    )
    _save_source_metadata(normalized)
    return normalized


def get_source_metadata(source_id: str) -> SamAudioSourceMetadata:
    normalized_id = _sanitize_source_hash(source_id)
    metadata = _load_source_metadata(normalized_id)
    if metadata is None:
        raise SamAudioSourceNotFoundError(
            f"SAM-Audio source '{normalized_id}' was not found"
        )
    return metadata


def _ticks_to_sample_index(ticks: int | float) -> int:
    return int(round(float(ticks) / TICKS_PER_SAMPLE))


def _audio_frame_to_channels_first(frame: av.AudioFrame) -> np.ndarray:
    array = frame.to_ndarray()
    try:
        channels = max(1, len(frame.layout.channels))
    except Exception:
        channels = 1

    if array.ndim == 1:
        return array.reshape(1, -1).astype(np.float32, copy=False)

    if array.shape[0] == channels:
        return array.astype(np.float32, copy=False)

    if array.ndim == 2 and array.shape[1] == channels:
        return array.T.astype(np.float32, copy=False)

    if array.ndim == 2 and array.shape[0] == 1 and array.shape[1] % channels == 0:
        return array.reshape(-1, channels).T.astype(np.float32, copy=False)

    return array.reshape(1, -1).astype(np.float32, copy=False)


def _load_source_audio_48khz(path: Path) -> np.ndarray:
    chunks: list[np.ndarray] = []
    try:
        with av.open(str(path)) as container:
            audio_streams = [stream for stream in container.streams if stream.type == "audio"]
            if not audio_streams:
                raise SamAudioRuntimeError(f"No audio stream found in '{path.name}'")

            stream = audio_streams[0]
            resampler = av.audio.resampler.AudioResampler(
                format="flt",
                rate=SAM_AUDIO_SAMPLE_RATE,
            )
            for frame in container.decode(stream):
                for resampled_frame in resampler.resample(frame):
                    chunks.append(_audio_frame_to_channels_first(resampled_frame))
            for resampled_frame in resampler.resample(None):
                chunks.append(_audio_frame_to_channels_first(resampled_frame))
    except SamAudioRuntimeError:
        raise
    except Exception as exc:
        raise SamAudioRuntimeError(f"Failed to decode audio from '{path.name}'") from exc

    if not chunks:
        raise SamAudioRuntimeError(f"No audio frames decoded from '{path.name}'")

    channel_count = max(chunk.shape[0] for chunk in chunks)
    normalized_chunks: list[np.ndarray] = []
    for chunk in chunks:
        if chunk.shape[0] == channel_count:
            normalized_chunks.append(chunk)
        elif chunk.shape[0] == 1:
            normalized_chunks.append(np.repeat(chunk, channel_count, axis=0))
        else:
            normalized_chunks.append(chunk[:channel_count])

    return np.ascontiguousarray(np.concatenate(normalized_chunks, axis=1))


def _extract_source_window(
    source_id: str,
    start_ticks: int,
    duration_ticks: int,
) -> Any:
    if duration_ticks <= 0:
        raise ValueError("duration_ticks must be > 0")
    if start_ticks < 0:
        raise ValueError("start_ticks must be >= 0")

    try:
        import torch  # type: ignore
    except Exception as exc:  # pragma: no cover - environment dependent
        raise SamAudioConfigError("torch is required for SAM-Audio") from exc

    source = get_source_metadata(source_id)
    wav = _load_source_audio_48khz(source.path)

    start_sample = max(0, _ticks_to_sample_index(start_ticks))
    requested_samples = max(1, _ticks_to_sample_index(duration_ticks))
    end_sample = start_sample + requested_samples

    sliced = wav[:, start_sample:min(end_sample, wav.shape[-1])]
    if sliced.shape[-1] < requested_samples:
        pad = requested_samples - sliced.shape[-1]
        sliced = np.pad(sliced, ((0, 0), (0, pad)), mode="constant")

    return torch.from_numpy(np.ascontiguousarray(sliced))


def _decode_video_frames(
    video_path: Path,
    start_frame: int,
    end_frame: int,
) -> np.ndarray:
    try:
        container = av.open(str(video_path))
    except Exception as exc:
        raise SamAudioRuntimeError(f"Unable to open visual prompt source: {video_path}") from exc

    frames: list[np.ndarray] = []
    source_frame_index = 0
    try:
        for frame in container.decode(video=0):
            if source_frame_index < start_frame:
                source_frame_index += 1
                continue
            if source_frame_index > end_frame:
                break
            frames.append(frame.to_ndarray(format="rgb24"))
            source_frame_index += 1
    finally:
        container.close()

    if not frames:
        raise SamAudioRuntimeError("Visual prompt source produced no frames for the window")
    return np.stack(frames, axis=0)


def _extract_visual_prompt_masked_video(
    processor: Any,
    sam2_source_id: str,
    sam2_mask_id: str,
    start_ticks: int,
    duration_ticks: int,
) -> list[Any]:
    try:
        import torch  # type: ignore
    except Exception as exc:  # pragma: no cover - environment dependent
        raise SamAudioConfigError("torch is required for SAM-Audio visual prompts") from exc

    sam2_source = sam2_service.get_source_metadata(sam2_source_id)
    frame_window = sam2_service._source_ticks_range_to_frame_window(
        source=sam2_source,
        ticks_per_second=TICKS_PER_SECOND,
        visible_source_start_ticks=start_ticks,
        visible_source_duration_ticks=duration_ticks,
    )
    start_frame, end_frame = frame_window
    video_frames = _decode_video_frames(sam2_source.path, start_frame, end_frame)
    mask_frames = sam2_service.get_cached_mask_frames(
        source_id=sam2_source_id,
        mask_id=sam2_mask_id,
        ticks_per_second=TICKS_PER_SECOND,
        visible_source_start_ticks=start_ticks,
        visible_source_duration_ticks=duration_ticks,
    )

    if mask_frames.frames.shape[0] != video_frames.shape[0]:
        count = min(mask_frames.frames.shape[0], video_frames.shape[0])
        video_frames = video_frames[:count]
        mask_array = mask_frames.frames[:count]
    else:
        mask_array = mask_frames.frames

    # SAM-Audio's processor.mask_videos expects N,C,H,W tensors. Repeat the
    # single-channel red mask across channels so its comparison broadcasts
    # against RGB frames.
    video_tensor = torch.from_numpy(video_frames).permute(0, 3, 1, 2)
    mask_tensor = torch.from_numpy(mask_array).unsqueeze(1).repeat(1, 3, 1, 1)
    return processor.mask_videos([video_tensor], [mask_tensor])


def _normalize_anchors(raw_anchors: list[list[Anchor]] | None) -> list[list[Anchor]] | None:
    if raw_anchors is None:
        return None

    normalized_groups: list[list[Anchor]] = []
    for group in raw_anchors:
        normalized_group: list[Anchor] = []
        for anchor in group:
            if len(anchor) != 3:
                raise ValueError("Each SAM-Audio anchor must have token, start, and end")
            token, start_time, end_time = anchor
            if token not in ("+", "-"):
                raise ValueError("SAM-Audio anchor token must be '+' or '-'")
            start = max(0.0, float(start_time))
            end = max(start, float(end_time))
            normalized_group.append((token, start, end))
        normalized_groups.append(normalized_group)
    return normalized_groups


def _coerce_output_tensor(result_value: Any, index: int = 0) -> Any:
    if isinstance(result_value, (list, tuple)):
        if not result_value:
            raise SamAudioRuntimeError("SAM-Audio returned an empty stem list")
        return result_value[index]
    if hasattr(result_value, "ndim") and getattr(result_value, "ndim", 0) >= 2:
        try:
            return result_value[index]
        except Exception:
            return result_value
    return result_value


def _prediction_spans_from_batch(batch: Any) -> list[list[Anchor]] | None:
    anchors = getattr(batch, "anchors", None)
    if anchors is None:
        return None
    try:
        return [
            [(str(token), float(start), float(end)) for token, start, end in group]
            for group in anchors
        ]
    except Exception:
        return None


def run_separation(
    window_audio: Any,
    prompt: SamAudioPrompt,
    start_ticks: int,
    duration_ticks: int,
) -> SamAudioSeparationResult:
    anchors = _normalize_anchors(prompt.get("anchors"))
    description = (prompt.get("text") or "").strip().lower()
    predict_spans = bool(prompt.get("predictSpans", False))
    requested_candidates = int(prompt.get("rerankingCandidates", 1) or 1)
    reranking_candidates = max(1, min(8, requested_candidates))
    wants_span_prediction = predict_spans and anchors is None
    wants_reranking = reranking_candidates > 1
    if (
        not SAM_AUDIO_LOAD_OPTIONAL_MODELS
        and (wants_reranking or wants_span_prediction)
    ):
        raise SamAudioConfigError(
            "This SAM-Audio request asks for high-quality reranking or automatic "
            "span prediction, but optional SAM-Audio models are disabled. Restart "
            "the backend with SAM_AUDIO_LOAD_OPTIONAL_MODELS=1 after the CLAP, "
            "ImageBind, judge, and PE span-predictor dependencies are cached, or "
            "send rerankingCandidates=1 and predictSpans=false for the lean isolate path."
        )

    model, processor, device = _runtime.get()

    if str(device).startswith("cpu"):
        reranking_candidates = 1

    masked_videos = None
    sam2_source_id = (prompt.get("sam2SourceId") or "").strip()
    sam2_mask_id = (prompt.get("sam2MaskId") or "").strip()
    if sam2_source_id and sam2_mask_id:
        masked_videos = _extract_visual_prompt_masked_video(
            processor=processor,
            sam2_source_id=sam2_source_id,
            sam2_mask_id=sam2_mask_id,
            start_ticks=start_ticks,
            duration_ticks=duration_ticks,
        )

    try:
        import torch  # type: ignore
    except Exception as exc:  # pragma: no cover - environment dependent
        raise SamAudioConfigError("torch is required for SAM-Audio inference") from exc

    try:
        batch_kwargs: dict[str, Any] = {
            "audios": [window_audio],
            "descriptions": [description],
        }
        if anchors is not None:
            batch_kwargs["anchors"] = anchors
        if masked_videos is not None:
            batch_kwargs["masked_videos"] = masked_videos

        batch = processor(**batch_kwargs).to(device)
        with torch.inference_mode():
            result = model.separate(
                batch,
                predict_spans=predict_spans,
                reranking_candidates=reranking_candidates,
            )
    except Exception as exc:  # pragma: no cover - model/runtime dependent
        raise SamAudioRuntimeError(f"SAM-Audio separation failed: {exc}") from exc

    try:
        target_audio = _coerce_output_tensor(result.target)
        residual_audio = _coerce_output_tensor(result.residual)
        target_wav = encode_wav_bytes(target_audio, SAM_AUDIO_SAMPLE_RATE)
        residual_wav = encode_wav_bytes(residual_audio, SAM_AUDIO_SAMPLE_RATE)
    except SamAudioEncodingError as exc:
        raise SamAudioRuntimeError(str(exc)) from exc

    return SamAudioSeparationResult(
        target_wav_bytes=target_wav,
        residual_wav_bytes=residual_wav,
        sample_rate=SAM_AUDIO_SAMPLE_RATE,
        duration_ticks=duration_ticks,
        predicted_spans=_prediction_spans_from_batch(batch) if predict_spans else None,
    )


def _set_job_state(
    job: SamAudioJob,
    *,
    status: JobStatus | None = None,
    progress: float | None = None,
    message: str | None = None,
    error: str | None = None,
    result: SamAudioSeparationResult | None = None,
) -> None:
    with _registry_lock:
        if status is not None:
            job.status = status
        if progress is not None:
            job.progress = max(0.0, min(1.0, float(progress)))
        if message is not None:
            job.message = message
        if error is not None:
            job.error = error
        if result is not None:
            job.result = result
        job.updated_at = time.time()


def _execute_job(job: SamAudioJob) -> None:
    try:
        logger.info("SAM-Audio job %s started", job.job_id)
        _set_job_state(
            job,
            status="running",
            progress=0.05,
            message="Preparing source audio window",
        )
        window_audio = _extract_source_window(
            job.source_id,
            job.start_ticks,
            job.duration_ticks,
        )
        _set_job_state(
            job,
            progress=0.20,
            message="Loading SAM-Audio runtime and running separation",
        )
        result = run_separation(
            window_audio=window_audio,
            prompt=job.prompt,
            start_ticks=job.start_ticks,
            duration_ticks=job.duration_ticks,
        )
        _set_job_state(
            job,
            status="done",
            progress=1.0,
            message="Separation complete",
            result=result,
        )
        logger.info("SAM-Audio job %s completed", job.job_id)
    except Exception as exc:  # noqa: BLE001 - worker must surface all errors
        logger.exception("SAM-Audio job %s failed", job.job_id)
        _set_job_state(
            job,
            status="error",
            progress=1.0,
            message="Separation failed",
            error=str(exc),
        )


def _evict_finished_jobs_locked() -> None:
    now = time.time()
    removable = [
        job_id
        for job_id, job in _jobs.items()
        if job.status in ("done", "error")
        and now - job.updated_at > FINISHED_JOB_TTL_SECONDS
    ]
    for job_id in removable:
        _jobs.pop(job_id, None)

    if len(_jobs) <= MAX_JOBS:
        return

    finished = sorted(
        (
            job
            for job in _jobs.values()
            if job.status in ("done", "error")
        ),
        key=lambda job: job.updated_at,
    )
    for job in finished[: max(0, len(_jobs) - MAX_JOBS)]:
        _jobs.pop(job.job_id, None)


def _worker_loop() -> None:
    while True:
        with _queue_condition:
            while not _queue:
                _queue_condition.wait()
            job_id = _queue.popleft()
            job = _jobs.get(job_id)
        if job is None:
            continue
        _execute_job(job)
        with _registry_lock:
            _evict_finished_jobs_locked()


def _ensure_worker_started() -> None:
    global _worker_thread
    with _queue_condition:
        if _worker_thread is not None and _worker_thread.is_alive():
            return
        _worker_thread = threading.Thread(
            target=_worker_loop,
            name="sam-audio-worker",
            daemon=True,
        )
        _worker_thread.start()


def enqueue_separation_job(
    source_id: str,
    start_ticks: int,
    duration_ticks: int,
    prompt: SamAudioPrompt,
) -> SamAudioJob:
    if duration_ticks <= 0:
        raise ValueError("durationTicks must be > 0")
    if start_ticks < 0:
        raise ValueError("startTicks must be >= 0")

    source = get_source_metadata(source_id)
    job = SamAudioJob(
        job_id=str(uuid.uuid4()),
        source_id=source.source_id,
        start_ticks=int(round(start_ticks)),
        duration_ticks=int(round(duration_ticks)),
        prompt=prompt,
    )

    _ensure_worker_started()
    with _queue_condition:
        _evict_finished_jobs_locked()
        _jobs[job.job_id] = job
        _queue.append(job.job_id)
        _queue_condition.notify()
    return job


def get_job(job_id: str) -> SamAudioJob | None:
    with _registry_lock:
        _evict_finished_jobs_locked()
        return _jobs.get(job_id)


def get_job_or_raise(job_id: str) -> SamAudioJob:
    job = get_job(job_id)
    if job is None:
        raise SamAudioJobNotFoundError(f"SAM-Audio job '{job_id}' was not found")
    return job


def get_job_stem(job_id: str, stem: StemKind) -> tuple[bytes, SamAudioSeparationResult]:
    job = get_job_or_raise(job_id)
    if job.status != "done" or job.result is None:
        raise SamAudioJobNotReadyError(f"SAM-Audio job '{job_id}' is not done")

    if stem == "target":
        data = job.result.target_wav_bytes
    elif stem == "residual":
        data = job.result.residual_wav_bytes
    else:
        raise ValueError(f"Unknown SAM-Audio stem: {stem}")

    with _registry_lock:
        job.fetched_stems.add(stem)
        job.updated_at = time.time()
    return data, job.result


def get_health() -> dict[str, Any]:
    with _registry_lock:
        queued = sum(1 for job in _jobs.values() if job.status == "queued")
        running = sum(1 for job in _jobs.values() if job.status == "running")
    return {
        "status": "ok",
        "runtime": _runtime.health(),
        "cacheDir": str(SAM_AUDIO_CACHE_DIR),
        "modelDirs": [str(path) for path in SAM_AUDIO_SEARCH_PATHS],
        "optionalModels": SAM_AUDIO_LOAD_OPTIONAL_MODELS,
        "queuedJobs": queued,
        "runningJobs": running,
    }


def _reset_jobs_for_tests() -> None:
    with _queue_condition:
        _jobs.clear()
        _queue.clear()
        _queue_condition.notify_all()
