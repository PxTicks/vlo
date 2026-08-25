from __future__ import annotations

import json
import logging
import math
import os
import sys
import threading
import time
from contextlib import suppress
from dataclasses import dataclass
from importlib.machinery import ModuleSpec
from types import ModuleType
from pathlib import Path
from typing import Any, Callable, Literal, TypedDict, cast

import av
import numpy as np

from config import (
    SAM_AUDIO_CACHE_DIR,
    SAM_AUDIO_DEFAULT_MODEL,
    SAM_AUDIO_DEVICE,
    SAM_AUDIO_LOAD_OPTIONAL_MODELS,
    SAM_AUDIO_SEARCH_PATHS,
)
from services.ai_models.capabilities import (
    SAM_AUDIO_CAPABILITY_ID,
    ClassifiedFailure,
    classify_exception,
    note_capability_success,
    record_load_failures,
    sanitize_message,
)
from services.ai_models.health import capability_runtime_health
from services.ai_models.source_cache import JsonSourceCache, sanitize_source_hash
from services.jobs import (
    BackendJobCancelledError,
    BackendJobContext,
    BackendJobDefinition,
    BackendJobManager,
    BackendJobNotFoundError,
    BackendJobSnapshot,
    BackendJobValidationError,
    JobArtifactStore,
)
from services.model_work.leases import Lease
from services.model_work.local_inference import local_gpu_lease
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
# CPU fallback and first-use model loading can legitimately exceed the shared
# extension default; keep a finite operational guard without restoring 15 min.
SAM_AUDIO_JOB_TIMEOUT_SECONDS = 6 * 60 * 60

SOURCES_DIR = SAM_AUDIO_CACHE_DIR / "sources"
METADATA_DIR = SAM_AUDIO_CACHE_DIR / "metadata"
STEMS_DIR = SAM_AUDIO_CACHE_DIR / "stems"
HF_CACHE_DIR = SAM_AUDIO_CACHE_DIR / "hf"
for _dir in (SOURCES_DIR, METADATA_DIR, STEMS_DIR, HF_CACHE_DIR):
    _dir.mkdir(parents=True, exist_ok=True)

JobStatus = Literal["queued", "running", "done", "error", "cancelled"]
StemKind = Literal["target", "residual"]
Anchor = tuple[str, float, float]
logger = logging.getLogger(__name__)
ProgressCallback = Callable[[float, str], None]
SKIPPABLE_SAM_AUDIO_MISSING_PREFIXES = (
    "text_encoder",
    "visual_ranker",
    "text_ranker",
    "span_predictor",
)


class SamAudioConfigError(RuntimeError):
    """Raised when SAM-Audio runtime configuration is invalid."""


class SamAudioRuntimeLoadError(SamAudioConfigError):
    """A classified failure confined to the model-load boundary."""

    def __init__(self, failure: ClassifiedFailure) -> None:
        super().__init__(failure.summary)
        self.failure = failure


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


_SOURCE_METADATA_CACHE = JsonSourceCache[SamAudioSourceMetadata](
    metadata_dir=lambda: METADATA_DIR,
    from_json=lambda payload: SamAudioSourceMetadata.from_json(payload),
    to_json=lambda metadata: metadata.to_json(),
    source_id=lambda metadata: metadata.source_id,
    path=lambda metadata: metadata.path,
)


@dataclass(frozen=True)
class SamAudioSeparationResult:
    target_wav_bytes: bytes
    residual_wav_bytes: bytes
    sample_rate: int
    duration_ticks: int
    predicted_spans: list[list[Anchor]] | None = None


@dataclass(frozen=True)
class SamAudioJobResult:
    target_artifact_id: str
    residual_artifact_id: str
    sample_rate: int
    duration_ticks: int
    predicted_spans: list[list[Anchor]] | None = None


@dataclass(frozen=True)
class SamAudioJob:
    job_id: str
    source_id: str
    start_ticks: int
    duration_ticks: int
    prompt: SamAudioPrompt
    status: JobStatus
    progress: float
    message: str | None
    error: str | None
    error_code: str | None
    created_at: float
    updated_at: float
    result: SamAudioJobResult | None
    cancel_requested: bool
    timings: dict[str, float]

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "jobId": self.job_id,
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "error": self.error,
            # The classified cause, so the queue toast can say what went wrong
            # instead of echoing the last progress message.
            "errorCode": self.error_code,
            "cancelRequested": self.cancel_requested,
            "sourceId": self.source_id,
            "startTicks": self.start_ticks,
            "durationTicks": self.duration_ticks,
        }
        if self.timings:
            payload["timings"] = self.timings
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

    def is_loaded(self) -> bool:
        return self._model is not None and self._processor is not None

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

    def _ensure_wandb_importable(self) -> None:
        """Let SAM-Audio import when ``wandb`` cannot.

        perception-models' ``core`` package imports wandb at module scope
        (``core/metrics.py``, ``core/profiling.py``) but only ever *uses* it
        inside training and profiling entry points — ``wandb.init``,
        ``wandb.log``, ``wandb.finish``, ``wandb.Html``. Separation calls none
        of them, so a telemetry library that cannot import has been able to
        take the whole feature down.

        ``Exception`` rather than ``ImportError`` is deliberate. wandb picks
        its generated protobuf modules by the installed protobuf's major
        version, and all but two of those dispatchers fall through silently on
        a major they do not ship. The failure then surfaces from *inside* the
        import as ``AttributeError: module 'wandb.proto.wandb_internal_pb2'
        has no attribute 'Result'`` — not as an ImportError.

        Attribute access raises rather than returning a dummy: nothing on this
        path should reach wandb, so if something does, it must say so instead
        of silently discarding whatever it meant to log.
        """

        try:
            import wandb  # type: ignore  # noqa: F401

            return
        except Exception:
            pass

        wandb_module = ModuleType("wandb")
        wandb_module.__spec__ = ModuleSpec("wandb", loader=None, is_package=True)
        # Submodule imports fail as ModuleNotFoundError rather than something
        # stranger; nothing on the load path does one today.
        wandb_module.__path__ = []  # type: ignore[attr-defined]

        def __getattr__(attr: str) -> Any:  # noqa: N807 - module protocol
            # Dunders must stay absent. Answering ``__file__`` with an object
            # breaks anything that introspects sys.modules, which the probe
            # worker's own stub learned the hard way.
            if attr.startswith("__") and attr.endswith("__"):
                raise AttributeError(attr)
            raise SamAudioConfigError(
                "SAM-Audio tried to use wandb, but wandb could not be imported "
                "in this backend environment. Reinstall wandb and a protobuf "
                "release its generated modules support."
            )

        wandb_module.__getattr__ = __getattr__  # type: ignore[attr-defined]
        sys.modules["wandb"] = wandb_module

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

    def _load_model_from_pretrained(
        self,
        SAMAudio: Any,
        model_ref: str,
        model_kwargs: dict[str, Any],
        timings: dict[str, float] | None,
        on_progress: ProgressCallback | None,
    ) -> Any:
        try:
            import torch  # type: ignore
            from huggingface_hub import snapshot_download  # type: ignore
        except Exception as exc:  # pragma: no cover - environment dependent
            raise SamAudioConfigError(
                "torch and huggingface_hub are required to load SAM-Audio"
            ) from exc

        if not hasattr(SAMAudio, "config_cls"):
            load_started_at = time.perf_counter()
            model = SAMAudio.from_pretrained(
                model_ref,
                cache_dir=str(HF_CACHE_DIR),
                map_location="cpu",
                **model_kwargs,
            )
            _record_timing(timings, "modelFromPretrainedSec", load_started_at)
            return model

        if on_progress is not None:
            on_progress(0.26, "Resolving SAM-Audio checkpoint")
        snapshot_started_at = time.perf_counter()
        if Path(model_ref).is_dir():
            cached_model_dir = Path(model_ref)
        else:
            cached_model_dir = Path(
                snapshot_download(
                    repo_id=model_ref,
                    revision=getattr(SAMAudio, "revision", None),
                    cache_dir=str(HF_CACHE_DIR),
                    force_download=False,
                    proxies=None,
                    resume_download=False,
                    token=None,
                    local_files_only=False,
                )
            )
        _record_timing(timings, "modelSnapshotResolveSec", snapshot_started_at)

        if on_progress is not None:
            on_progress(0.27, "Reading SAM-Audio config")
        config_started_at = time.perf_counter()
        with open(cached_model_dir / "config.json") as config_file:
            config_payload = json.load(config_file)
        for key, value in model_kwargs.items():
            if key in config_payload:
                config_payload[key] = value
        config = SAMAudio.config_cls(**config_payload)
        _record_timing(timings, "configReadSec", config_started_at)

        if on_progress is not None:
            on_progress(0.29, "Constructing SAM-Audio modules")
        construct_started_at = time.perf_counter()
        model = SAMAudio(config)
        _record_timing(timings, "modelConstructSec", construct_started_at)

        if on_progress is not None:
            on_progress(0.32, "Loading SAM-Audio checkpoint tensors")
        state_dict = _load_torch_checkpoint(
            torch,
            cached_model_dir / "checkpoint.pt",
            timings,
        )

        if on_progress is not None:
            on_progress(0.36, "Applying SAM-Audio checkpoint tensors")
        _apply_sam_audio_state_dict(
            torch,
            model,
            state_dict,
            timings,
        )
        del state_dict
        return model

    def _load_for_device(
        self,
        device: str,
        timings: dict[str, float] | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> tuple[Any, Any, str]:
        dependency_started_at = time.perf_counter()
        self._ensure_sam_audio_pythonpath(include_default_checkout=False)
        self._ensure_xformers_ops_importable()
        self._ensure_torchcodec_decoders_importable()
        self._ensure_wandb_importable()
        try:
            SAMAudio, SAMAudioProcessor = self._import_sam_audio_classes()
            _record_timing(timings, "dependencyImportSec", dependency_started_at)
        except Exception as exc:  # pragma: no cover - environment dependent
            # The command comes from the profile table rather than being spelled
            # out here: the venv `uv sync` builds has no pip, so the old
            # `python -m pip` hint was an instruction that could not work.
            from services.ai_models.capabilities.profiles import (
                SAM_AUDIO_PROFILE_ID,
                install_remediation,
            )

            remediation = install_remediation(SAM_AUDIO_PROFILE_ID)
            command = (
                f"`{remediation.command}`"
                if remediation is not None and remediation.command
                else "the optional SAM-Audio requirements"
            )
            raise SamAudioConfigError(
                "Failed to import SAM-Audio. Install the optional SAM-Audio "
                "requirements into the backend virtual environment with "
                f"{command}, set SAM_AUDIO_PYTHONPATH to a checkout with its "
                "dependencies installed, or fix the failing transitive "
                f"dependency. Underlying error: {exc}"
            ) from exc

        model_ref_started_at = time.perf_counter()
        model_ref = self._resolve_model_ref()
        _record_timing(timings, "modelRefResolveSec", model_ref_started_at)
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
            model = self._load_model_from_pretrained(
                SAMAudio,
                model_ref,
                model_kwargs,
                timings,
                on_progress,
            )
            if on_progress is not None:
                on_progress(0.38, "Loading SAM-Audio processor")
            processor_started_at = time.perf_counter()
            processor = SAMAudioProcessor.from_pretrained(model_ref)
            _record_timing(timings, "processorLoadSec", processor_started_at)
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
            if on_progress is not None:
                on_progress(0.39, f"Moving SAM-Audio model to {device}")
            move_started_at = time.perf_counter()
            model = model.eval().to(device)
            _record_timing(timings, "moveToDeviceSec", move_started_at)
        except Exception as exc:  # pragma: no cover - environment/device dependent
            raise SamAudioConfigError(f"Failed to move SAM-Audio model to {device}") from exc

        return model, processor, model_ref

    def get(
        self,
        timings: dict[str, float] | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> tuple[Any, Any, str]:
        if self._model is not None and self._processor is not None:
            return self._model, self._processor, self._resolved_device or "cpu"

        try:
            return self._load(timings=timings, on_progress=on_progress)
        except BackendJobCancelledError:
            raise
        except Exception as exc:
            # This marker lets the job adapter distinguish a model-load failure
            # from source extraction, inference, or artifact-write failures.
            raise SamAudioRuntimeLoadError(classify_exception(exc)) from exc

    def _load(
        self,
        timings: dict[str, float] | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> tuple[Any, Any, str]:
        with self._lock:
            if self._model is not None and self._processor is not None:
                return self._model, self._processor, self._resolved_device or "cpu"

            with record_load_failures(
                SAM_AUDIO_CAPABILITY_ID,
                ignore=(BackendJobCancelledError,),
            ):
                requested_device = SAM_AUDIO_DEVICE.strip() or "auto"
                candidate_devices = self._resolve_candidate_devices(requested_device)
                errors: list[tuple[str, Exception]] = []
                for device in candidate_devices:
                    try:
                        model, processor, model_ref = self._load_for_device(
                            device,
                            timings=timings,
                            on_progress=on_progress,
                        )
                        self._model = model
                        self._processor = processor
                        self._resolved_device = device
                        self._selected_model_ref = model_ref
                        note_capability_success(SAM_AUDIO_CAPABILITY_ID)
                        return model, processor, device
                    except BackendJobCancelledError:
                        raise
                    except Exception as exc:  # pragma: no cover - environment dependent
                        errors.append((device, exc))

                summary = (
                    "; ".join(f"{device}: {exc}" for device, exc in errors)
                    if errors
                    else "unknown error"
                )
                error = SamAudioConfigError(
                    f"Failed to initialize SAM-Audio runtime ({summary})"
                )
                if errors:
                    # Keep the exception chain intact so package/import/model
                    # failures survive fallback-device aggregation.
                    raise error from errors[-1][1]
                raise error

    def health(self) -> dict[str, Any]:
        # A checkpoint on disk says nothing about whether sam_audio imports;
        # the capability registry checks both and explains which one failed.
        return {
            **capability_runtime_health(SAM_AUDIO_CAPABILITY_ID),
            "device": SAM_AUDIO_DEVICE,
            "resolvedDevice": self._resolved_device,
            "selectedModel": SAM_AUDIO_DEFAULT_MODEL,
            "selectedModelRef": self._selected_model_ref,
            "discoveredModels": discover_sam_audio_models(),
            "modelLoaded": self._model is not None,
        }


_runtime = _SamAudioRuntime()


def probe_runtime_load(
    on_progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    """Load the same model and processor real separation jobs use."""

    _model, _processor, resolved_device = _runtime.get(on_progress=on_progress)
    return {"resolvedDevice": resolved_device}

SAM_AUDIO_JOB_OWNER = "vlo.sam-audio"
SAM_AUDIO_JOB_OWNER_VERSION = "1"
SAM_AUDIO_SEPARATION_JOB_TYPE = "separate"
_job_manager: BackendJobManager | None = None
_job_manager_lock = threading.RLock()


def _sanitize_source_hash(source_hash: str) -> str:
    return sanitize_source_hash(source_hash)


def _metadata_path(source_id: str) -> Path:
    return _SOURCE_METADATA_CACHE.metadata_path(source_id)


def _load_source_metadata(source_id: str) -> SamAudioSourceMetadata | None:
    return _SOURCE_METADATA_CACHE.load(source_id)


def _save_source_metadata(metadata: SamAudioSourceMetadata) -> None:
    _SOURCE_METADATA_CACHE.save(metadata)


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


def _record_timing(timings: dict[str, float] | None, key: str, started_at: float) -> None:
    if timings is not None:
        timings[key] = round(time.perf_counter() - started_at, 3)


def _sync_torch_device(torch_module: Any, device: str) -> None:
    if str(device).startswith("cuda") and hasattr(torch_module, "cuda"):
        try:
            torch_module.cuda.synchronize(device)
        except Exception:
            pass


def _load_torch_checkpoint(
    torch_module: Any,
    checkpoint_path: Path,
    timings: dict[str, float] | None,
) -> Any:
    checkpoint_started_at = time.perf_counter()
    try:
        state_dict = torch_module.load(
            checkpoint_path,
            weights_only=True,
            map_location="cpu",
            mmap=True,
        )
        if timings is not None:
            timings["checkpointMmap"] = 1.0
    except (TypeError, ValueError, RuntimeError) as exc:
        logger.warning(
            "Failed to mmap SAM-Audio checkpoint %s; falling back to regular torch.load: %s",
            checkpoint_path,
            exc,
        )
        state_dict = torch_module.load(
            checkpoint_path,
            weights_only=True,
            map_location="cpu",
        )
        if timings is not None:
            timings["checkpointMmap"] = 0.0
    _record_timing(timings, "checkpointLoadSec", checkpoint_started_at)
    return state_dict


def _apply_sam_audio_state_dict(
    torch_module: Any,
    model: Any,
    state_dict: Any,
    timings: dict[str, float] | None,
) -> None:
    state_dict_started_at = time.perf_counter()
    try:
        incompatible = torch_module.nn.Module.load_state_dict(
            model,
            state_dict,
            strict=False,
            assign=True,
        )
        if timings is not None:
            timings["stateDictAssign"] = 1.0
    except TypeError:
        incompatible = torch_module.nn.Module.load_state_dict(
            model,
            state_dict,
            strict=False,
        )
        if timings is not None:
            timings["stateDictAssign"] = 0.0

    missing_keys = [
        key
        for key in incompatible.missing_keys
        if not key.startswith(SKIPPABLE_SAM_AUDIO_MISSING_PREFIXES)
    ]
    unexpected_keys = list(incompatible.unexpected_keys)
    if missing_keys or unexpected_keys:
        raise RuntimeError(
            f"Missing keys: {missing_keys}, unexpected_keys: {unexpected_keys}"
        )
    _record_timing(timings, "stateDictApplySec", state_dict_started_at)


def run_separation(
    window_audio: Any,
    prompt: SamAudioPrompt,
    start_ticks: int,
    duration_ticks: int,
    *,
    timings: dict[str, float] | None = None,
    on_progress: ProgressCallback | None = None,
) -> SamAudioSeparationResult:
    total_started_at = time.perf_counter()
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

    runtime_loaded = _runtime.is_loaded()
    if on_progress is not None:
        on_progress(
            0.25,
            "Using loaded SAM-Audio runtime"
            if runtime_loaded
            else "Loading SAM-Audio model for first use",
        )
    runtime_started_at = time.perf_counter()
    model, processor, device = _runtime.get(
        timings=timings,
        on_progress=on_progress,
    )
    _record_timing(timings, "runtimeLoadSec", runtime_started_at)

    if str(device).startswith("cpu"):
        reranking_candidates = 1

    masked_videos = None
    sam2_source_id = (prompt.get("sam2SourceId") or "").strip()
    sam2_mask_id = (prompt.get("sam2MaskId") or "").strip()
    if sam2_source_id and sam2_mask_id:
        # TODO: Replace this legacy SAM2 editor-cache prompt path with
        # mask-asset visual prompts so committed SAM2/generation/brush masks
        # can drive SAM-Audio without a live SAM2 session.
        if on_progress is not None:
            on_progress(0.35, "Preparing visual prompt")
        visual_started_at = time.perf_counter()
        masked_videos = _extract_visual_prompt_masked_video(
            processor=processor,
            sam2_source_id=sam2_source_id,
            sam2_mask_id=sam2_mask_id,
            start_ticks=start_ticks,
            duration_ticks=duration_ticks,
        )
        _record_timing(timings, "visualPromptSec", visual_started_at)

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

        if on_progress is not None:
            on_progress(0.40, "Preparing SAM-Audio batch")
        batch_started_at = time.perf_counter()
        batch = processor(**batch_kwargs).to(device)
        _sync_torch_device(torch, device)
        _record_timing(timings, "batchPrepSec", batch_started_at)

        if on_progress is not None:
            on_progress(0.48, "Running SAM-Audio separation")
        separate_started_at = time.perf_counter()
        with torch.inference_mode():
            result = model.separate(
                batch,
                predict_spans=predict_spans,
                reranking_candidates=reranking_candidates,
            )
        _sync_torch_device(torch, device)
        _record_timing(timings, "modelSeparateSec", separate_started_at)
    except Exception as exc:  # pragma: no cover - model/runtime dependent
        raise SamAudioRuntimeError(f"SAM-Audio separation failed: {exc}") from exc

    try:
        if on_progress is not None:
            on_progress(0.88, "Encoding separated stems")
        encoding_started_at = time.perf_counter()
        target_audio = _coerce_output_tensor(result.target)
        residual_audio = _coerce_output_tensor(result.residual)
        target_wav = encode_wav_bytes(target_audio, SAM_AUDIO_SAMPLE_RATE)
        residual_wav = encode_wav_bytes(residual_audio, SAM_AUDIO_SAMPLE_RATE)
        _record_timing(timings, "encodeSec", encoding_started_at)
    except SamAudioEncodingError as exc:
        raise SamAudioRuntimeError(str(exc)) from exc

    _record_timing(timings, "totalSeparationSec", total_started_at)
    return SamAudioSeparationResult(
        target_wav_bytes=target_wav,
        residual_wav_bytes=residual_wav,
        sample_rate=SAM_AUDIO_SAMPLE_RATE,
        duration_ticks=duration_ticks,
        predicted_spans=_prediction_spans_from_batch(batch) if predict_spans else None,
    )


def _validate_separation_job_input(value: object) -> object:
    if not isinstance(value, dict):
        raise BackendJobValidationError("SAM-Audio job input must be an object")

    source_id = value.get("sourceId")
    start_ticks = value.get("startTicks")
    duration_ticks = value.get("durationTicks")
    prompt = value.get("prompt", {})
    if not isinstance(source_id, str) or not source_id.strip():
        raise BackendJobValidationError("sourceId must be non-empty")
    if isinstance(start_ticks, bool) or not isinstance(start_ticks, int):
        raise BackendJobValidationError("startTicks must be an integer")
    if isinstance(duration_ticks, bool) or not isinstance(duration_ticks, int):
        raise BackendJobValidationError("durationTicks must be an integer")
    if start_ticks < 0:
        raise BackendJobValidationError("startTicks must be >= 0")
    if duration_ticks <= 0:
        raise BackendJobValidationError("durationTicks must be > 0")
    if not isinstance(prompt, dict):
        raise BackendJobValidationError("prompt must be an object")

    return {
        "sourceId": source_id,
        "startTicks": start_ticks,
        "durationTicks": duration_ticks,
        "prompt": prompt,
    }


class _LiveTimings(dict[str, float]):
    def __init__(self, context: BackendJobContext) -> None:
        super().__init__()
        self._context = context
        self._mirror: dict[str, float] | None = None

    def mirror_into(self, target: dict[str, float]) -> None:
        self._mirror = target

    def __setitem__(self, key: str, value: float) -> None:
        super().__setitem__(key, value)
        if self._mirror is not None:
            self._mirror[key] = value
        self._context.report_runtime_metadata({"timings": dict(self)})


def _finite_predicted_spans(
    spans: list[list[Anchor]] | None,
) -> list[list[Anchor]] | None:
    if spans is None:
        return None
    normalized: list[list[Anchor]] = []
    try:
        for group in spans:
            normalized_group: list[Anchor] = []
            for token, start, end in group:
                if (
                    token not in ("+", "-")
                    or isinstance(start, bool)
                    or not isinstance(start, (int, float))
                    or isinstance(end, bool)
                    or not isinstance(end, (int, float))
                    or not (math.isfinite(start) and math.isfinite(end))
                ):
                    return None
                normalized_group.append((token, float(start), float(end)))
            normalized.append(normalized_group)
    except (TypeError, ValueError):
        return None
    return normalized


def _run_separation_job(context: BackendJobContext, value: object) -> object:
    # The lease is taken by the physical worker callable, not by the job record:
    # a timeout marks the job terminal while this thread is still inside torch,
    # and the GPU must stay excluded for that whole window.
    with local_gpu_lease(
        source="sam-audio",
        label="Audio separation",
        owner=SAM_AUDIO_JOB_OWNER,
    ) as lease:
        return _run_separation_job_under_lease(context, value, lease)


def _run_separation_job_under_lease(
    context: BackendJobContext,
    value: object,
    lease: Lease | None,
) -> object:
    timings_for_failure: dict[str, float] = {}
    try:
        return _separate_under_lease(context, value, lease, timings_for_failure)
    except BackendJobCancelledError:
        raise
    except SamAudioRuntimeLoadError as exc:
        # Only a failure emitted at the model-load boundary is a capability
        # failure. Request validation, source decoding, inference, and artifact
        # writes keep their own errors and must not poison runtime readiness.
        classified = exc.failure
        if lease is not None:
            # The shared model-work queue turns this entry's final message into
            # its failure toast. Replace the last progress line before release
            # marks it terminal, so the toast cites the classified cause too.
            with suppress(Exception):
                lease.report(message=classified.summary)
        with suppress(Exception):
            context.report_runtime_metadata(
                {
                    "timings": dict(timings_for_failure),
                    "failure": {
                        "code": classified.code.value,
                        "summary": classified.summary,
                    },
                }
            )
        raise


def _separate_under_lease(
    context: BackendJobContext,
    value: object,
    lease: Lease | None,
    timings_out: dict[str, float],
) -> object:
    payload = cast(dict[str, object], value)
    source_id = cast(str, payload["sourceId"])
    start_ticks = cast(int, payload["startTicks"])
    duration_ticks = cast(int, payload["durationTicks"])
    prompt = cast(SamAudioPrompt, payload["prompt"])
    timings = _LiveTimings(context)
    # Shared with the failure handler so a failed job keeps the timings it had
    # already reported rather than replacing them with an empty set.
    timings_out.clear()
    timings.mirror_into(timings_out)

    logger.info("SAM-Audio job %s started", context.identity.job_id)

    def report_progress(progress: float, message: str) -> None:
        if lease is not None:
            if context.cancelled:
                # Publicly cancelled, physically still resident: the ledger says
                # `stopping` until this callable actually returns.
                lease.request_stop(message=message)
            else:
                lease.report(progress=progress, message=message)
        context.report_progress(progress, message)

    report_progress(0.05, "Preparing source audio window")
    window_audio = _extract_source_window(
        source_id,
        start_ticks,
        duration_ticks,
    )
    report_progress(0.20, "Starting SAM-Audio separation")

    result = run_separation(
        window_audio=window_audio,
        prompt=prompt,
        start_ticks=start_ticks,
        duration_ticks=duration_ticks,
        timings=timings,
        on_progress=report_progress,
    )
    context.raise_if_cancelled()
    target = context.artifacts.create(
        result.target_wav_bytes,
        filename="target.wav",
        content_type="audio/wav",
    )
    residual = context.artifacts.create(
        result.residual_wav_bytes,
        filename="residual.wav",
        content_type="audio/wav",
    )
    logger.info(
        "SAM-Audio job %s completed; timings=%s",
        context.identity.job_id,
        timings,
    )
    return {
        "targetArtifactId": target.artifact_id,
        "residualArtifactId": residual.artifact_id,
        "sampleRate": result.sample_rate,
        "resultDurationTicks": result.duration_ticks,
        "predictedSpans": _finite_predicted_spans(result.predicted_spans),
    }


def _get_job_manager() -> BackendJobManager:
    global _job_manager
    with _job_manager_lock:
        if _job_manager is not None:
            return _job_manager
        manager = BackendJobManager(
            JobArtifactStore(STEMS_DIR / "job-artifacts"),
            finished_ttl_seconds=FINISHED_JOB_TTL_SECONDS,
            max_jobs_per_owner=MAX_JOBS,
            executor_max_workers=1,
            max_concurrent_jobs_per_owner=1,
            evict_finished_jobs_at_capacity=True,
            thread_name_prefix="sam-audio-job",
        )
        manager.register_owner(
            SAM_AUDIO_JOB_OWNER,
            SAM_AUDIO_JOB_OWNER_VERSION,
            (
                BackendJobDefinition(
                    id=SAM_AUDIO_SEPARATION_JOB_TYPE,
                    label="Separate audio",
                    run=_run_separation_job,
                    validate_input=_validate_separation_job_input,
                    timeout_seconds=SAM_AUDIO_JOB_TIMEOUT_SECONDS,
                ),
            ),
        )
        _job_manager = manager
        return manager


def _job_result(value: object | None) -> SamAudioJobResult | None:
    if not isinstance(value, dict):
        return None
    target_artifact_id = value.get("targetArtifactId")
    residual_artifact_id = value.get("residualArtifactId")
    sample_rate = value.get("sampleRate")
    duration_ticks = value.get("resultDurationTicks")
    predicted_spans = value.get("predictedSpans")
    if (
        not isinstance(target_artifact_id, str)
        or not isinstance(residual_artifact_id, str)
        or not isinstance(sample_rate, int)
        or not isinstance(duration_ticks, int)
    ):
        return None
    return SamAudioJobResult(
        target_artifact_id=target_artifact_id,
        residual_artifact_id=residual_artifact_id,
        sample_rate=sample_rate,
        duration_ticks=duration_ticks,
        predicted_spans=cast(list[list[Anchor]] | None, predicted_spans),
    )


def _to_sam_audio_job(snapshot: BackendJobSnapshot) -> SamAudioJob:
    input_value = _get_job_manager().get_input(
        SAM_AUDIO_JOB_OWNER,
        snapshot.identity.job_id,
    )
    payload = cast(dict[str, object], input_value)
    status_map: dict[str, JobStatus] = {
        "queued": "queued",
        "running": "running",
        "succeeded": "done",
        "failed": "error",
        "cancelled": "cancelled",
    }
    status = status_map[snapshot.status]
    message = snapshot.message
    if status == "queued":
        message = "Waiting for SAM-Audio worker"
    elif status == "done":
        message = "Separation complete"
    elif status == "error":
        message = "Separation failed"
    result = _job_result(snapshot.result)
    metadata = (
        snapshot.runtime_metadata
        if isinstance(snapshot.runtime_metadata, dict)
        else {}
    )
    timings = metadata.get("timings", {})
    failure = metadata.get("failure")
    failure_payload = failure if isinstance(failure, dict) else {}
    error_code = failure_payload.get("code")
    # Prefer the classified summary: the raw exception text is a chain of
    # device attempts, and the client has one line to show.
    error_summary = failure_payload.get("summary")
    return SamAudioJob(
        job_id=snapshot.identity.job_id,
        source_id=cast(str, payload["sourceId"]),
        start_ticks=cast(int, payload["startTicks"]),
        duration_ticks=cast(int, payload["durationTicks"]),
        prompt=cast(SamAudioPrompt, payload["prompt"]),
        status=status,
        progress=snapshot.progress,
        message=message,
        error=(
            cast(str, error_summary)
            if isinstance(error_summary, str) and error_summary
            else sanitize_message(snapshot.error) or None
        ),
        error_code=cast(str, error_code) if isinstance(error_code, str) else None,
        created_at=snapshot.created_at,
        updated_at=snapshot.updated_at,
        result=result,
        cancel_requested=snapshot.cancel_requested,
        timings=cast(dict[str, float], timings),
    )


async def submit_separation_job(
    source: SamAudioSourceMetadata,
    start_ticks: int,
    duration_ticks: int,
    prompt: SamAudioPrompt,
) -> SamAudioJob:
    try:
        snapshot = await _get_job_manager().submit(
            SAM_AUDIO_JOB_OWNER,
            SAM_AUDIO_SEPARATION_JOB_TYPE,
            {
                "sourceId": source.source_id,
                "startTicks": start_ticks,
                "durationTicks": duration_ticks,
                "prompt": prompt,
            },
        )
    except BackendJobValidationError as exc:
        raise ValueError(str(exc)) from exc
    return _to_sam_audio_job(snapshot)


async def cancel_job(job_id: str) -> SamAudioJob:
    try:
        snapshot = await _get_job_manager().cancel(
            SAM_AUDIO_JOB_OWNER,
            job_id,
        )
    except BackendJobNotFoundError as exc:
        raise SamAudioJobNotFoundError(
            f"SAM-Audio job '{job_id}' was not found"
        ) from exc
    return _to_sam_audio_job(snapshot)


def get_job(job_id: str) -> SamAudioJob | None:
    try:
        snapshot = _get_job_manager().get(SAM_AUDIO_JOB_OWNER, job_id)
    except BackendJobNotFoundError:
        return None
    return _to_sam_audio_job(snapshot)


def get_job_or_raise(job_id: str) -> SamAudioJob:
    job = get_job(job_id)
    if job is None:
        raise SamAudioJobNotFoundError(f"SAM-Audio job '{job_id}' was not found")
    return job


def get_job_stem(job_id: str, stem: StemKind) -> tuple[bytes, SamAudioJobResult]:
    job = get_job_or_raise(job_id)
    if job.status != "done" or job.result is None:
        raise SamAudioJobNotReadyError(f"SAM-Audio job '{job_id}' is not done")

    if stem == "target":
        artifact_id = job.result.target_artifact_id
    elif stem == "residual":
        artifact_id = job.result.residual_artifact_id
    else:
        raise ValueError(f"Unknown SAM-Audio stem: {stem}")

    _, data = _get_job_manager().get_artifact(
        SAM_AUDIO_JOB_OWNER,
        artifact_id,
    )
    return data, job.result


def get_health() -> dict[str, Any]:
    jobs = _get_job_manager().list_jobs(SAM_AUDIO_JOB_OWNER)
    queued = sum(1 for job in jobs if job.status == "queued")
    running = sum(1 for job in jobs if job.status == "running")
    return {
        "status": "ok",
        "runtime": _runtime.health(),
        "cacheDir": str(SAM_AUDIO_CACHE_DIR),
        "modelDirs": [str(path) for path in SAM_AUDIO_SEARCH_PATHS],
        "optionalModels": SAM_AUDIO_LOAD_OPTIONAL_MODELS,
        "queuedJobs": queued,
        "runningJobs": running,
    }


async def shutdown_jobs() -> None:
    global _job_manager
    with _job_manager_lock:
        manager = _job_manager
        _job_manager = None
    if manager is not None:
        await manager.shutdown_all()


async def _reset_jobs_for_tests() -> None:
    await shutdown_jobs()
