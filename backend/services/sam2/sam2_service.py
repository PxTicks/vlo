from __future__ import annotations

import io
import json
import os
import av
import sys
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from contextlib import contextmanager
from fractions import Fraction
from pathlib import Path
from typing import Any, Iterable, TypedDict

import numpy as np
from PIL import Image

from config import (
    SAM2_CACHE_DIR,
    SAM2_DEVICE,
)
from services.sam2.sam2_encoding import Sam2EncodingError, encode_binary_masks_to_transparent_webm
from services.sam2.sam2_discovery import discover_sam2_models, Sam2ModelInfo


class Sam2ConfigError(RuntimeError):
    """Raised when SAM2 runtime configuration is invalid."""


class Sam2RuntimeError(RuntimeError):
    """Raised when SAM2 inference fails."""


class Sam2SourceNotFoundError(FileNotFoundError):
    """Raised when a source video ID is missing from cache."""


class Sam2Point(TypedDict):
    x: float
    y: float
    label: int
    timeTicks: float


@dataclass(frozen=True)
class Sam2SourceMetadata:
    source_id: str
    source_hash: str
    path: Path
    width: int
    height: int
    fps: float
    frame_count: int
    duration_sec: float

    def to_response(self) -> dict[str, Any]:
        return {
            "sourceId": self.source_id,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "frameCount": self.frame_count,
            "durationSec": self.duration_sec,
        }

    def to_json(self) -> dict[str, Any]:
        payload = self.to_response()
        payload["sourceHash"] = self.source_hash
        payload["path"] = str(self.path)
        return payload

    @classmethod
    def from_json(cls, payload: dict[str, Any]) -> "Sam2SourceMetadata":
        return cls(
            source_id=str(payload["sourceId"]),
            source_hash=str(payload.get("sourceHash", payload["sourceId"])),
            path=Path(str(payload["path"])),
            width=int(payload["width"]),
            height=int(payload["height"]),
            fps=float(payload["fps"]),
            frame_count=int(payload["frameCount"]),
            duration_sec=float(payload["durationSec"]),
        )


@dataclass(frozen=True)
class Sam2GeneratedMaskVideo:
    video_bytes: bytes
    width: int
    height: int
    fps: float
    frame_count: int


@dataclass(frozen=True)
class Sam2GeneratedMaskFrame:
    png_bytes: bytes
    width: int
    height: int
    frame_index: int
    time_ticks: float


class _Sam2PredictorRuntime:
    """Lazy-loaded singleton wrapper around the native SAM2 video predictor."""

    def __init__(self) -> None:
        self._predictor: Any | None = None
        self._resolved_device: str | None = None
        self._lock = threading.Lock()

    def _build_predictor_for_device(
        self,
        build_sam2_video_predictor: Any,
        model_config_path: Path,
        checkpoint_path: Path,
        device: str,
    ) -> Any:
        use_manual_checkpoint_load = checkpoint_path.suffix.lower() == ".safetensors"
        checkpoint_arg: str | None = None if use_manual_checkpoint_load else str(checkpoint_path)
        try:
            predictor = build_sam2_video_predictor(
                config_file=str(model_config_path),
                ckpt_path=checkpoint_arg,
                device=device,
            )
        except TypeError:
            # Compatibility fallback for alternate function signatures.
            predictor = build_sam2_video_predictor(
                str(model_config_path),
                checkpoint_arg,
                device=device,
            )

        if use_manual_checkpoint_load:
            self._load_checkpoint_intelligently(
                model=predictor,
                checkpoint_path=checkpoint_path,
            )
        return predictor

    def _select_state_dict_target(self, model: Any) -> Any:
        if hasattr(model, "load_state_dict"):
            return model

        candidate = getattr(model, "model", None)
        if hasattr(candidate, "load_state_dict"):
            return candidate

        raise Sam2ConfigError(
            "SAM2 checkpoint loading failed: predictor does not expose load_state_dict"
        )

    def _extract_state_dict(self, payload: Any) -> Any:
        if isinstance(payload, Mapping) and "model" in payload:
            return payload["model"]
        return payload

    def _load_checkpoint_intelligently(
        self,
        model: Any,
        checkpoint_path: Path,
    ) -> None:
        suffix = checkpoint_path.suffix.lower()
        if suffix == ".safetensors":
            try:
                from safetensors.torch import load_file as load_safetensors  # type: ignore
            except Exception as exc:  # pragma: no cover - environment dependent
                raise Sam2ConfigError(
                    "Failed to import safetensors loader for .safetensors SAM2 checkpoint"
                ) from exc
            state_dict_payload = load_safetensors(str(checkpoint_path))
        else:
            try:
                import torch  # type: ignore
            except Exception as exc:  # pragma: no cover - environment dependent
                raise Sam2ConfigError(
                    "Failed to import torch for SAM2 checkpoint loading"
                ) from exc
            state_dict_payload = torch.load(
                str(checkpoint_path),
                map_location="cpu",
                weights_only=False,
            )

        state_dict = self._extract_state_dict(state_dict_payload)
        stateful_target = self._select_state_dict_target(model)
        stateful_target.load_state_dict(state_dict)

    def _build_predictor_with_config_dir(
        self,
        build_sam2_video_predictor: Any,
        model_config_path: Path,
        checkpoint_path: Path,
        device: str,
    ) -> Any:
        """
        Builds a predictor using the config's parent folder as Hydra's main config root.
        This allows loading custom absolute config files (e.g. local SAM 2.1 YAMLs).
        """
        try:
            from hydra import initialize_config_dir
            from hydra.core.global_hydra import GlobalHydra
        except Exception as exc:  # pragma: no cover - environment dependent
            raise Sam2ConfigError(
                "Failed to import Hydra initialization utilities for custom SAM2 config paths"
            ) from exc

        hydra_state = GlobalHydra.instance()
        if hydra_state.is_initialized():
            hydra_state.clear()

        with initialize_config_dir(
            config_dir=str(model_config_path.parent),
            version_base="1.2",
        ):
            return self._build_predictor_for_device(
                build_sam2_video_predictor=build_sam2_video_predictor,
                model_config_path=Path(model_config_path.name),
                checkpoint_path=checkpoint_path,
                device=device,
            )

    @contextmanager
    def _torch_load_compat_context(self) -> Any:
        """
        Temporary compatibility shim for PyTorch 2.6+ where torch.load defaults to
        weights_only=True. Some SAM2 wrappers still rely on the legacy default.
        """
        try:
            import torch  # type: ignore
        except Exception:  # pragma: no cover - environment dependent
            yield
            return

        original_torch_load = getattr(torch, "load", None)
        if not callable(original_torch_load):
            yield
            return

        torch_serialization = getattr(torch, "serialization", None)
        original_serialization_load = (
            getattr(torch_serialization, "load", None)
            if torch_serialization is not None
            else None
        )

        def _compat_torch_load(*args: Any, **kwargs: Any) -> Any:
            kwargs = dict(kwargs)
            kwargs["weights_only"] = False
            return original_torch_load(*args, **kwargs)

        previous_force_flag = os.environ.get("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD")
        previous_force_true_flag = os.environ.get("TORCH_FORCE_WEIGHTS_ONLY_LOAD")
        os.environ["TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD"] = "1"
        os.environ.pop("TORCH_FORCE_WEIGHTS_ONLY_LOAD", None)
        patched_aliases: list[tuple[Any, str, Any]] = []

        for module_name, module in list(sys.modules.items()):
            if module is None or not module_name.startswith("sam2"):
                continue
            try:
                attrs = vars(module).items()
            except Exception:
                continue
            for attr_name, attr_value in attrs:
                if (
                    attr_value is original_torch_load
                    or (
                        callable(original_serialization_load)
                        and attr_value is original_serialization_load
                    )
                ):
                    try:
                        setattr(module, attr_name, _compat_torch_load)
                        patched_aliases.append((module, attr_name, attr_value))
                    except Exception:
                        continue

        setattr(torch, "load", _compat_torch_load)
        if torch_serialization is not None and callable(original_serialization_load):
            setattr(torch_serialization, "load", _compat_torch_load)
        try:
            yield
        finally:
            setattr(torch, "load", original_torch_load)
            if torch_serialization is not None and callable(original_serialization_load):
                setattr(torch_serialization, "load", original_serialization_load)
            for module, attr_name, attr_value in patched_aliases:
                try:
                    setattr(module, attr_name, attr_value)
                except Exception:
                    continue
            if previous_force_flag is None:
                os.environ.pop("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", None)
            else:
                os.environ["TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD"] = previous_force_flag
            if previous_force_true_flag is None:
                os.environ.pop("TORCH_FORCE_WEIGHTS_ONLY_LOAD", None)
            else:
                os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = previous_force_true_flag

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
            return [raw] if cuda_available else ["cpu"]

        return [raw]

    def _load_predictor(self) -> Any:
        discovered_models = discover_sam2_models()
        if not discovered_models:
            raise Sam2ConfigError(
                "No SAM2 models found in any of the search paths"
            )

        # For the alpha, we just pick the first discovered model automatically
        selected_model = discovered_models[0]
        checkpoint_path = Path(selected_model["checkpoint_path"])
        model_config_path = Path(selected_model["config_path"])

        if not checkpoint_path.exists():
            raise Sam2ConfigError(f"SAM2 checkpoint not found: {checkpoint_path}")

        # ComfyUI config mapping might use relative strings that expect standard locations 
        # inside the python environment, but if it is an absolute path we check it.
        if model_config_path.is_absolute() and not model_config_path.exists():
            raise Sam2ConfigError(f"SAM2 model config not found: {model_config_path}")

        optional_pythonpath = os.environ.get("SAM2_PYTHONPATH", "").strip()
        if optional_pythonpath and optional_pythonpath not in sys.path:
            sys.path.insert(0, optional_pythonpath)

        requested_device = SAM2_DEVICE.strip() or "auto"
        candidate_devices = self._resolve_candidate_devices(requested_device)

        errors_by_device: list[str] = []
        for device in candidate_devices:
            try:
                with self._torch_load_compat_context():
                    try:
                        from sam2.build_sam import build_sam2_video_predictor  # type: ignore
                    except Exception as exc:  # pragma: no cover - environment dependent
                        raise Sam2ConfigError(
                            "Failed to import native SAM2 runtime (sam2.build_sam.build_sam2_video_predictor)"
                        ) from exc

                    if model_config_path.is_absolute():
                        predictor = self._build_predictor_with_config_dir(
                            build_sam2_video_predictor=build_sam2_video_predictor,
                            model_config_path=model_config_path,
                            checkpoint_path=checkpoint_path,
                            device=device,
                        )
                    else:
                        predictor = self._build_predictor_for_device(
                            build_sam2_video_predictor=build_sam2_video_predictor,
                            model_config_path=model_config_path,
                            checkpoint_path=checkpoint_path,
                            device=device,
                        )
                self._resolved_device = device
                return predictor
            except Exception as exc:  # pragma: no cover - environment dependent
                errors_by_device.append(f"{device}: {exc}")

        errors_summary = "; ".join(errors_by_device) if errors_by_device else "unknown error"
        raise Sam2ConfigError(
            f"Failed to initialize SAM2 predictor ({errors_summary})"
        )

    def get_predictor(self) -> Any:
        if self._predictor is not None:
            return self._predictor
        with self._lock:
            if self._predictor is None:
                self._predictor = self._load_predictor()
        return self._predictor

    def health(self) -> dict[str, Any]:
        discovered_models = discover_sam2_models()
        ready = len(discovered_models) > 0
        return {
            "ready": ready,
            "device": SAM2_DEVICE,
            "resolvedDevice": self._resolved_device,
            "discoveredModels": discovered_models,
            "predictorLoaded": self._predictor is not None,
        }


_runtime = _Sam2PredictorRuntime()


SOURCES_DIR = SAM2_CACHE_DIR / "sources"
METADATA_DIR = SAM2_CACHE_DIR / "metadata"
PREPARED_SOURCES_DIR = SAM2_CACHE_DIR / "prepared_sources"
PREPARED_FRAMES_DIR = SAM2_CACHE_DIR / "prepared_frames"
SOURCES_DIR.mkdir(parents=True, exist_ok=True)
METADATA_DIR.mkdir(parents=True, exist_ok=True)
PREPARED_SOURCES_DIR.mkdir(parents=True, exist_ok=True)
PREPARED_FRAMES_DIR.mkdir(parents=True, exist_ok=True)

_PREPARE_VIDEO_LOCK = threading.Lock()
_EDITOR_SESSIONS_LOCK = threading.Lock()


@dataclass
class _Sam2EditorSession:
    source_id: str
    mask_id: str
    prepared_video_path: Path
    inference_state: Any
    frame_index_offset: int
    frame_count: int


_EDITOR_SESSIONS: dict[str, _Sam2EditorSession] = {}


def _sanitize_source_hash(source_hash: str) -> str:
    sanitized = "".join(ch for ch in source_hash.strip() if ch.isalnum() or ch in "-_")
    if not sanitized:
        raise ValueError("source_hash must contain at least one valid character")
    return sanitized


def _metadata_path(source_id: str) -> Path:
    return METADATA_DIR / f"{source_id}.json"


def _load_source_metadata(source_id: str) -> Sam2SourceMetadata | None:
    metadata_path = _metadata_path(source_id)
    if not metadata_path.exists():
        return None
    try:
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata = Sam2SourceMetadata.from_json(payload)
        if not metadata.path.exists():
            return None
        return metadata
    except Exception:
        return None


def _save_source_metadata(metadata: Sam2SourceMetadata) -> None:
    metadata_path = _metadata_path(metadata.source_id)
    metadata_path.write_text(
        json.dumps(metadata.to_json(), indent=2),
        encoding="utf-8",
    )


def _inspect_video(video_path: Path) -> Sam2SourceMetadata:
    try:
        container = av.open(str(video_path))
    except Exception as exc:
        raise Sam2RuntimeError(f"Unable to open source video: {video_path}") from exc
    try:
        if not container.streams.video:
            raise Sam2RuntimeError(f"Unable to open source video: {video_path}")

        stream = container.streams.video[0]
        width = int(stream.width or stream.codec_context.width or 0)
        height = int(stream.height or stream.codec_context.height or 0)
        fps = float(_resolve_av_stream_rate(stream, fallback_fps=30.0))
        frame_count = int(stream.frames or 0)

        if frame_count <= 0:
            duration_sec = 0.0
            if stream.duration is not None and stream.time_base is not None:
                try:
                    duration_sec = float(stream.duration * stream.time_base)
                except Exception:
                    duration_sec = 0.0
            if duration_sec <= 0 and container.duration is not None:
                duration_sec = float(container.duration / av.time_base)
            if duration_sec > 0 and fps > 0:
                frame_count = max(1, int(round(duration_sec * fps)))
            if frame_count <= 0:
                frame_count = sum(1 for _ in container.decode(video=0))
    finally:
        container.close()

    if width <= 0 or height <= 0:
        raise Sam2RuntimeError(
            f"Invalid source dimensions ({width}x{height}) for {video_path}"
        )
    if fps <= 0 or not np.isfinite(fps):
        fps = 30.0
    if frame_count <= 0:
        # Best effort fallback when container metadata is missing.
        frame_count = max(1, int(round(fps)))
    duration_sec = frame_count / fps

    source_id = video_path.stem.split(".", 1)[0]
    return Sam2SourceMetadata(
        source_id=source_id,
        source_hash=source_id,
        path=video_path,
        width=width,
        height=height,
        fps=fps,
        frame_count=frame_count,
        duration_sec=duration_sec,
    )


def register_source_bytes(
    source_hash: str,
    filename: str,
    data: bytes,
) -> Sam2SourceMetadata:
    source_id = _sanitize_source_hash(source_hash)

    existing = _load_source_metadata(source_id)
    if existing is not None:
        return existing

    suffix = Path(filename).suffix if filename else ""
    if not suffix:
        suffix = ".mp4"
    source_path = SOURCES_DIR / f"{source_id}{suffix}"
    source_path.write_bytes(data)

    metadata = _inspect_video(source_path)
    normalized = Sam2SourceMetadata(
        source_id=source_id,
        source_hash=source_id,
        path=source_path,
        width=metadata.width,
        height=metadata.height,
        fps=metadata.fps,
        frame_count=metadata.frame_count,
        duration_sec=metadata.duration_sec,
    )
    _save_source_metadata(normalized)
    return normalized


def get_source_metadata(source_id: str) -> Sam2SourceMetadata:
    normalized_id = _sanitize_source_hash(source_id)
    metadata = _load_source_metadata(normalized_id)
    if metadata is None:
        raise Sam2SourceNotFoundError(f"SAM2 source '{normalized_id}' was not found")
    return metadata


def _editor_session_key(source_id: str, mask_id: str) -> str:
    return f"{source_id}::{mask_id}"


def _prepared_video_path(source: Sam2SourceMetadata, normalized_mp4: bool) -> Path:
    suffix = "_normalized.mp4" if normalized_mp4 else ".mp4"
    return PREPARED_SOURCES_DIR / f"{source.source_id}{suffix}"


def _prepared_frames_path(
    source: Sam2SourceMetadata,
    frame_window: tuple[int, int] | None = None,
) -> Path:
    cache_version = "jpeg_v2"
    if frame_window is None:
        return PREPARED_FRAMES_DIR / f"{source.source_id}_{cache_version}"
    start_frame, end_frame = _normalize_frame_window(frame_window, source.frame_count)
    return (
        PREPARED_FRAMES_DIR
        / f"{source.source_id}_{start_frame:06d}_{end_frame:06d}_{cache_version}"
    )


def _coerce_av_rate(value: Any, fallback_fps: float = 30.0) -> Fraction:
    numerator = getattr(value, "numerator", None)
    denominator = getattr(value, "denominator", None)
    if numerator is not None and denominator is not None:
        try:
            num = int(numerator)
            den = int(denominator)
            if num > 0 and den > 0:
                return Fraction(num, den)
        except Exception:
            pass

    try:
        numeric_rate = float(value)
    except Exception:
        numeric_rate = float(fallback_fps)

    if not np.isfinite(numeric_rate) or numeric_rate <= 0:
        numeric_rate = float(fallback_fps)

    return Fraction(numeric_rate).limit_denominator(1_000_000)


def _resolve_av_stream_rate(stream: object, fallback_fps: float = 30.0) -> Fraction:
    codec_context = getattr(stream, "codec_context", None)
    for candidate in (
        getattr(stream, "average_rate", None),
        getattr(stream, "base_rate", None),
        getattr(stream, "guessed_rate", None),
        getattr(codec_context, "framerate", None),
    ):
        if candidate is None:
            continue
        return _coerce_av_rate(candidate, fallback_fps=fallback_fps)
    return _coerce_av_rate(fallback_fps, fallback_fps=fallback_fps)


def _convert_video_to_mp4(source_path: Path, target_path: Path) -> Path:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        input_container = av.open(str(source_path))
        output_container = av.open(str(target_path), mode="w")

        # Set up output streams
        in_video = input_container.streams.video[0]
        video_rate = _resolve_av_stream_rate(in_video, fallback_fps=30.0)
        out_video = output_container.add_stream("libx264", rate=video_rate)
        out_video.width = in_video.codec_context.width
        out_video.height = in_video.codec_context.height
        out_video.pix_fmt = "yuv420p"
        out_video.options = {"preset": "veryfast"}

        out_audio = None
        if input_container.streams.audio:
            in_audio = input_container.streams.audio[0]
            audio_rate = max(1, int(in_audio.rate or 48_000))
            out_audio = output_container.add_stream("aac", rate=audio_rate)

        for frame in input_container.decode(video=0):
            for packet in out_video.encode(frame):
                output_container.mux(packet)

        # Flush video
        for packet in out_video.encode():
            output_container.mux(packet)

        # Transcode audio if present
        if out_audio and input_container.streams.audio:
            input_container.seek(0)
            for frame in input_container.decode(audio=0):
                frame.pts = None
                for packet in out_audio.encode(frame):
                    output_container.mux(packet)
            for packet in out_audio.encode():
                output_container.mux(packet)

        output_container.close()
        input_container.close()
    except FileNotFoundError as exc:
        raise Sam2RuntimeError(
            f"Video file not found: '{source_path.name}'"
        ) from exc
    except Exception as exc:
        raise Sam2RuntimeError(
            f"Video conversion failed for SAM2 source '{source_path.name}': {exc}"
        ) from exc
    return target_path


def _ensure_prepared_video(source: Sam2SourceMetadata, normalized_mp4: bool) -> Path:
    prepared_path = _prepared_video_path(source, normalized_mp4=normalized_mp4)
    with _PREPARE_VIDEO_LOCK:
        if prepared_path.exists():
            return prepared_path
        return _convert_video_to_mp4(source.path, prepared_path)


def _extract_video_frames_to_jpeg(
    video_path: Path,
    target_dir: Path,
    frame_window: tuple[int, int] | None = None,
) -> Path:
    if target_dir.exists():
        for stale_file in target_dir.glob("*.jpg"):
            stale_file.unlink()
    target_dir.mkdir(parents=True, exist_ok=True)

    try:
        container = av.open(str(video_path))
    except Exception as exc:
        raise Sam2RuntimeError(
            f"Unable to open video for frame extraction: {video_path}"
        ) from exc

    start_frame = 0
    end_frame: int | None = None
    if frame_window is not None:
        start_frame = max(0, int(frame_window[0]))
        end_frame = max(start_frame, int(frame_window[1]))

    # Decode sequentially to keep source-frame indexing exact; random frame seeks
    # can land on codec-dependent positions and drift the SAM2 frame mapping.
    source_frame_index = 0
    extracted_frame_count = 0
    try:
        if not container.streams.video:
            raise Sam2RuntimeError(
                f"Unable to open video for frame extraction: {video_path}"
            )

        for frame in container.decode(video=0):
            if source_frame_index < start_frame:
                source_frame_index += 1
                continue
            if end_frame is not None and source_frame_index > end_frame:
                break
            frame_path = target_dir / f"{extracted_frame_count:05d}.jpg"
            try:
                image = frame.to_image()
                if image.mode not in ("RGB", "L"):
                    image = image.convert("RGB")
                image.save(str(frame_path), format="JPEG", quality=95)
            except Exception as exc:
                raise Sam2RuntimeError(
                    f"Failed to write extracted frame '{frame_path.name}' for SAM2"
                ) from exc
            source_frame_index += 1
            extracted_frame_count += 1
    finally:
        container.close()

    if extracted_frame_count <= 0:
        raise Sam2RuntimeError(
            f"No frames were extracted from video '{video_path.name}' for SAM2"
        )
    return target_dir


def _ensure_prepared_jpeg_frames(
    source: Sam2SourceMetadata,
    video_path: Path,
    frame_window: tuple[int, int] | None = None,
) -> Path:
    normalized_window = _normalize_frame_window(frame_window, source.frame_count)
    full_window = (0, source.frame_count - 1)
    path_window: tuple[int, int] | None = (
        None if normalized_window == full_window else normalized_window
    )
    expected_frame_count = (normalized_window[1] - normalized_window[0]) + 1
    frames_path = _prepared_frames_path(source, frame_window=path_window)
    with _PREPARE_VIDEO_LOCK:
        existing = sorted(frames_path.glob("*.jpg"))
        if len(existing) == expected_frame_count:
            return frames_path
        return _extract_video_frames_to_jpeg(
            video_path,
            frames_path,
            frame_window=normalized_window,
        )


def _initialize_inference_state(
    predictor: Any,
    source: Sam2SourceMetadata,
    frame_window: tuple[int, int] | None = None,
) -> tuple[Any, Path, int, int]:
    errors: list[str] = []
    attempted_video_paths: list[Path] = []
    normalized_window = _normalize_frame_window(frame_window, source.frame_count)
    window_start_frame, window_end_frame = normalized_window
    window_frame_count = (window_end_frame - window_start_frame) + 1

    def _try_init(video_path: Path) -> tuple[Any, Path, int, int] | None:
        try:
            attempted_video_paths.append(video_path)
            return (
                predictor.init_state(video_path=str(video_path)),
                video_path,
                0,
                source.frame_count,
            )
        except Exception as exc:  # pragma: no cover - environment dependent
            errors.append(f"{video_path.name}: {exc}")
            return None

    source_path = source.path
    source_suffix = source_path.suffix.lower()

    if source_suffix != ".mp4":
        prepared = _ensure_prepared_video(source, normalized_mp4=False)
        initialized = _try_init(prepared)
        if initialized is not None:
            return initialized
    else:
        initialized = _try_init(source_path)
        if initialized is not None:
            return initialized

        prepared = _ensure_prepared_video(source, normalized_mp4=True)
        initialized = _try_init(prepared)
        if initialized is not None:
            return initialized

    # Some SAM2 variants accept a JPEG frame directory instead of a video file.
    fallback_video_path = attempted_video_paths[-1] if attempted_video_paths else source.path
    try:
        frames_dir = _ensure_prepared_jpeg_frames(
            source,
            fallback_video_path,
            frame_window=normalized_window,
        )
        return (
            predictor.init_state(video_path=str(frames_dir)),
            frames_dir,
            window_start_frame,
            window_frame_count,
        )
    except Exception as exc:  # pragma: no cover - environment dependent
        errors.append(f"{source.source_id}/(jpeg-frames): {exc}")

    summary = "; ".join(errors) if errors else "unknown error"
    raise Sam2RuntimeError(f"Failed to initialize SAM2 inference state ({summary})")


def _create_editor_session(
    source: Sam2SourceMetadata,
    mask_id: str,
    frame_window: tuple[int, int] | None = None,
) -> _Sam2EditorSession:
    predictor = _runtime.get_predictor()
    (
        inference_state,
        prepared_video_path,
        frame_index_offset,
        frame_count,
    ) = _initialize_inference_state(
        predictor=predictor,
        source=source,
        frame_window=frame_window,
    )
    session = _Sam2EditorSession(
        source_id=source.source_id,
        mask_id=mask_id,
        prepared_video_path=prepared_video_path,
        inference_state=inference_state,
        frame_index_offset=frame_index_offset,
        frame_count=frame_count,
    )
    with _EDITOR_SESSIONS_LOCK:
        _EDITOR_SESSIONS[_editor_session_key(source.source_id, mask_id)] = session
    return session


def _get_editor_session(source_id: str, mask_id: str) -> _Sam2EditorSession | None:
    with _EDITOR_SESSIONS_LOCK:
        return _EDITOR_SESSIONS.get(_editor_session_key(source_id, mask_id))


def _session_covers_frame_window(
    session: _Sam2EditorSession,
    frame_window: tuple[int, int] | None,
    source_frame_count: int,
) -> bool:
    requested_start, requested_end = _normalize_frame_window(frame_window, source_frame_count)
    session_start = session.frame_index_offset
    session_end = session.frame_index_offset + session.frame_count - 1
    return session_start <= requested_start and requested_end <= session_end


def _get_or_create_editor_session(
    source: Sam2SourceMetadata,
    mask_id: str,
    frame_window: tuple[int, int] | None = None,
) -> _Sam2EditorSession:
    existing = _get_editor_session(source.source_id, mask_id)
    if existing is not None and _session_covers_frame_window(
        existing,
        frame_window=frame_window,
        source_frame_count=source.frame_count,
    ):
        return existing
    return _create_editor_session(source, mask_id, frame_window=frame_window)


def init_editor_session(
    source_id: str,
    mask_id: str,
    ticks_per_second: float | None = None,
    visible_source_start_ticks: float | None = None,
    visible_source_duration_ticks: float | None = None,
) -> dict[str, Any]:
    normalized_mask_id = mask_id.strip()
    if not normalized_mask_id:
        raise ValueError("mask_id is required")

    source = get_source_metadata(source_id)
    has_visible_range = (
        visible_source_start_ticks is not None
        or visible_source_duration_ticks is not None
    )
    frame_window: tuple[int, int] | None = None
    if has_visible_range:
        if ticks_per_second is None or ticks_per_second <= 0:
            raise ValueError(
                "ticks_per_second must be > 0 when visible source range is provided"
            )
        frame_window = _source_ticks_range_to_frame_window(
            source=source,
            ticks_per_second=ticks_per_second,
            visible_source_start_ticks=visible_source_start_ticks,
            visible_source_duration_ticks=visible_source_duration_ticks,
        )

    predictor = _runtime.get_predictor()
    session = _create_editor_session(
        source,
        normalized_mask_id,
        frame_window=frame_window,
    )
    if hasattr(predictor, "reset_state"):
        predictor.reset_state(session.inference_state)

    payload = {
        "sourceId": source.source_id,
        "maskId": normalized_mask_id,
        "width": source.width,
        "height": source.height,
        "fps": source.fps,
        "frameCount": source.frame_count,
    }
    if frame_window is not None:
        payload["frameWindowStartFrame"] = frame_window[0]
        payload["frameWindowEndFrame"] = frame_window[1]
    return payload


def clear_editor_session(source_id: str, mask_id: str) -> dict[str, Any]:
    normalized_mask_id = mask_id.strip()
    if not normalized_mask_id:
        raise ValueError("mask_id is required")

    key = _editor_session_key(_sanitize_source_hash(source_id), normalized_mask_id)
    with _EDITOR_SESSIONS_LOCK:
        removed = _EDITOR_SESSIONS.pop(key, None)
    return {
        "sourceId": _sanitize_source_hash(source_id),
        "maskId": normalized_mask_id,
        "cleared": removed is not None,
    }


def group_points_by_frame(
    points: Iterable[Sam2Point],
    fps: float,
    ticks_per_second: float,
    frame_count: int,
) -> dict[int, list[Sam2Point]]:
    grouped: dict[int, list[Sam2Point]] = {}
    if fps <= 0:
        raise ValueError(f"fps must be > 0, got {fps}")
    if ticks_per_second <= 0:
        raise ValueError(
            f"ticks_per_second must be > 0, got {ticks_per_second}"
        )
    for point in points:
        time_ticks = float(point["timeTicks"])
        time_sec = max(0.0, time_ticks / ticks_per_second)
        frame_index = int(np.floor(time_sec * fps))
        frame_index = max(0, min(frame_count - 1, frame_index))
        grouped.setdefault(frame_index, []).append(point)
    return grouped


def _time_ticks_to_frame_index(
    time_ticks: float,
    fps: float,
    ticks_per_second: float,
    frame_count: int,
) -> int:
    if fps <= 0:
        raise ValueError(f"fps must be > 0, got {fps}")
    if ticks_per_second <= 0:
        raise ValueError(
            f"ticks_per_second must be > 0, got {ticks_per_second}"
        )
    if frame_count <= 0:
        raise ValueError(f"frame_count must be > 0, got {frame_count}")

    time_sec = max(0.0, float(time_ticks) / ticks_per_second)
    frame_index = int(np.floor(time_sec * fps))
    return max(0, min(frame_count - 1, frame_index))


def _normalize_frame_window(
    frame_window: tuple[int, int] | None,
    frame_count: int,
) -> tuple[int, int]:
    if frame_count <= 0:
        raise ValueError(f"frame_count must be > 0, got {frame_count}")

    if frame_window is None:
        return (0, frame_count - 1)

    start_frame, end_frame = frame_window
    start_frame = max(0, min(frame_count - 1, int(start_frame)))
    end_frame = max(0, min(frame_count - 1, int(end_frame)))
    if end_frame < start_frame:
        end_frame = start_frame
    return (start_frame, end_frame)


def _source_ticks_range_to_frame_window(
    source: Sam2SourceMetadata,
    ticks_per_second: float,
    visible_source_start_ticks: float | None,
    visible_source_duration_ticks: float | None,
) -> tuple[int, int]:
    if ticks_per_second <= 0:
        raise ValueError(
            f"ticks_per_second must be > 0, got {ticks_per_second}"
        )
    if source.frame_count <= 0:
        raise ValueError(f"frame_count must be > 0, got {source.frame_count}")

    max_source_ticks = max(0.0, source.duration_sec * ticks_per_second)
    start_ticks = (
        max(0.0, float(visible_source_start_ticks))
        if visible_source_start_ticks is not None
        else 0.0
    )
    start_ticks = min(start_ticks, max_source_ticks)

    if visible_source_duration_ticks is None:
        end_ticks = max_source_ticks
    else:
        duration_ticks = max(0.0, float(visible_source_duration_ticks))
        end_ticks = min(max_source_ticks, start_ticks + duration_ticks)

    start_frame = _time_ticks_to_frame_index(
        time_ticks=start_ticks,
        fps=source.fps,
        ticks_per_second=ticks_per_second,
        frame_count=source.frame_count,
    )
    end_frame = int(
        np.ceil(
            max(0.0, end_ticks / ticks_per_second) * source.fps
        )
    ) - 1
    end_frame = max(start_frame, min(source.frame_count - 1, end_frame))
    return (start_frame, end_frame)


def _source_frame_to_predictor_frame(
    source_frame_index: int,
    frame_index_offset: int,
    predictor_frame_count: int,
) -> int | None:
    predictor_frame_index = int(source_frame_index) - int(frame_index_offset)
    if predictor_frame_index < 0 or predictor_frame_index >= int(predictor_frame_count):
        return None
    return predictor_frame_index


def _predictor_frame_to_source_frame(
    predictor_frame_index: int,
    frame_index_offset: int,
) -> int:
    return int(predictor_frame_index) + int(frame_index_offset)


def _points_to_predictor_arrays(
    frame_points: list[Sam2Point],
    width: int,
    height: int,
) -> tuple[np.ndarray, np.ndarray]:
    point_rows: list[list[float]] = []
    labels: list[int] = []

    for point in frame_points:
        normalized_x = float(point["x"])
        normalized_y = float(point["y"])
        label = int(point["label"])
        if label not in (0, 1):
            continue

        pixel_x = np.clip(np.round(normalized_x * (width - 1)), 0, width - 1)
        pixel_y = np.clip(np.round(normalized_y * (height - 1)), 0, height - 1)
        point_rows.append([float(pixel_x), float(pixel_y)])
        labels.append(label)

    if not point_rows:
        raise Sam2RuntimeError("No valid SAM2 points were provided")

    points_np = np.asarray(point_rows, dtype=np.float32)
    labels_np = np.asarray(labels, dtype=np.int32)
    return points_np, labels_np


def _call_add_points(
    predictor: Any,
    inference_state: Any,
    frame_index: int,
    points_np: np.ndarray,
    labels_np: np.ndarray,
) -> Any:
    if hasattr(predictor, "add_new_points_or_box"):
        return predictor.add_new_points_or_box(
            inference_state=inference_state,
            frame_idx=frame_index,
            obj_id=1,
            points=points_np,
            labels=labels_np,
        )

    if hasattr(predictor, "add_new_points"):
        return predictor.add_new_points(
            inference_state=inference_state,
            frame_idx=frame_index,
            obj_id=1,
            points=points_np,
            labels=labels_np,
        )

    raise Sam2RuntimeError(
        "SAM2 predictor does not expose add_new_points_or_box or add_new_points"
    )


def _call_propagate_in_video(
    predictor: Any,
    inference_state: Any,
    start_frame_idx: int,
    reverse: bool,
    max_frame_num_to_track: int | None = None,
) -> Any:
    kwargs: dict[str, Any] = {
        "start_frame_idx": start_frame_idx,
        "reverse": reverse,
    }
    if max_frame_num_to_track is None:
        return predictor.propagate_in_video(inference_state, **kwargs)

    kwargs_with_max = dict(kwargs)
    kwargs_with_max["max_frame_num_to_track"] = int(max_frame_num_to_track)
    try:
        return predictor.propagate_in_video(inference_state, **kwargs_with_max)
    except TypeError as exc:
        # Some predictor variants do not expose max_frame_num_to_track.
        if "max_frame_num_to_track" not in str(exc):
            raise
        return predictor.propagate_in_video(inference_state, **kwargs)


def _extract_logits_from_add_points_result(add_result: Any) -> Any | None:
    if not isinstance(add_result, (list, tuple)) or len(add_result) < 3:
        return None
    return add_result[2]


def _logits_to_binary_frame(logits: Any) -> np.ndarray:
    if isinstance(logits, (list, tuple)):
        if not logits:
            raise Sam2RuntimeError("SAM2 logits list is empty")
        item_frames = np.stack(
            [_logits_to_binary_frame(item) for item in logits],
            axis=0,
        )
        merged_items = np.any(item_frames > 0, axis=0)
        return np.where(merged_items, 255, 0).astype(np.uint8)

    if hasattr(logits, "detach"):
        logits_np = logits.detach().cpu().numpy()
    else:
        logits_np = np.asarray(logits)

    if logits_np.ndim == 2:
        merged = logits_np > 0
    elif logits_np.ndim >= 3:
        # Merge all leading dimensions (obj/channel/etc) into a single 2D mask.
        merge_axes = tuple(range(logits_np.ndim - 2))
        merged = np.any(logits_np > 0, axis=merge_axes)
    else:
        raise Sam2RuntimeError(f"Unexpected SAM2 logits shape: {logits_np.shape}")

    if merged.ndim != 2:
        raise Sam2RuntimeError(
            f"Unexpected merged SAM2 logits shape after reduction: {merged.shape}"
        )

    return np.where(merged, 255, 0).astype(np.uint8)


def _encode_png_frame(frame: np.ndarray) -> bytes:
    normalized = np.asarray(frame, dtype=np.uint8)
    if normalized.ndim == 3 and normalized.shape[0] == 1:
        normalized = normalized.squeeze(0)
    if normalized.ndim == 3 and normalized.shape[-1] == 1:
        normalized = normalized.squeeze(-1)
    if normalized.ndim != 2:
        raise Sam2RuntimeError(
            f"Failed to encode SAM2 frame preview (unexpected frame shape: {normalized.shape})"
        )
    if normalized.size == 0:
        raise Sam2RuntimeError("Failed to encode SAM2 frame preview (empty frame)")

    contiguous = np.ascontiguousarray(normalized)
    try:
        buffer = io.BytesIO()
        Image.fromarray(contiguous, mode="L").save(buffer, format="PNG")
        return buffer.getvalue()
    except Exception as exc:  # pragma: no cover - environment dependent
        raise Sam2RuntimeError(
            f"Failed to encode SAM2 frame preview (shape={contiguous.shape}, dtype={contiguous.dtype})"
        ) from exc


def _run_sam2_propagation(
    source: Sam2SourceMetadata,
    points_by_frame: dict[int, list[Sam2Point]],
    mask_id: str | None = None,
    frame_window: tuple[int, int] | None = None,
) -> np.ndarray:
    predictor = _runtime.get_predictor()
    frame_index_offset = 0
    predictor_frame_count = source.frame_count
    if mask_id:
        session = _get_or_create_editor_session(
            source,
            mask_id,
            frame_window=frame_window,
        )
        inference_state = session.inference_state
        frame_index_offset = session.frame_index_offset
        predictor_frame_count = session.frame_count
    else:
        (
            inference_state,
            _,
            frame_index_offset,
            predictor_frame_count,
        ) = _initialize_inference_state(
            predictor=predictor,
            source=source,
            frame_window=frame_window,
        )

    if hasattr(predictor, "reset_state"):
        predictor.reset_state(inference_state)

    frames = np.zeros(
        (source.frame_count, source.height, source.width),
        dtype=np.uint8,
    )
    active_start_frame, active_end_frame = _normalize_frame_window(
        frame_window,
        source.frame_count,
    )
    predictor_source_start = frame_index_offset
    predictor_source_end = frame_index_offset + predictor_frame_count - 1
    active_start_frame = max(active_start_frame, predictor_source_start)
    active_end_frame = min(active_end_frame, predictor_source_end)
    if active_end_frame < active_start_frame:
        raise Sam2RuntimeError(
            "SAM2 predictor initialization did not cover the clip's visible source-time range"
        )

    conditioning_source_frames: list[int] = []
    conditioning_predictor_frames: list[int] = []
    seen_frames: set[int] = set()

    for frame_index in sorted(points_by_frame.keys()):
        if frame_index < active_start_frame or frame_index > active_end_frame:
            continue

        predictor_frame_index = _source_frame_to_predictor_frame(
            frame_index,
            frame_index_offset=frame_index_offset,
            predictor_frame_count=predictor_frame_count,
        )
        if predictor_frame_index is None:
            continue

        frame_points = points_by_frame[frame_index]
        points_np, labels_np = _points_to_predictor_arrays(
            frame_points,
            source.width,
            source.height,
        )
        add_result = _call_add_points(
            predictor,
            inference_state,
            predictor_frame_index,
            points_np,
            labels_np,
        )
        conditioning_source_frames.append(frame_index)
        conditioning_predictor_frames.append(predictor_frame_index)
        seeded_logits = _extract_logits_from_add_points_result(add_result)
        if seeded_logits is not None:
            frames[frame_index] = _logits_to_binary_frame(seeded_logits)
            seen_frames.add(frame_index)

    if not conditioning_source_frames:
        raise Sam2RuntimeError(
            "No SAM2 points were provided in the clip's visible source-time range"
        )

    predictor_active_start = active_start_frame - frame_index_offset
    predictor_active_end = active_end_frame - frame_index_offset
    start_frame_idx = min(conditioning_predictor_frames)
    try:
        for reverse in (False, True):
            if reverse and start_frame_idx <= predictor_active_start:
                continue
            if reverse:
                max_track_distance = max(0, start_frame_idx - predictor_active_start)
            else:
                max_track_distance = max(0, predictor_active_end - start_frame_idx)
            propagation_iter = _call_propagate_in_video(
                predictor=predictor,
                inference_state=inference_state,
                start_frame_idx=start_frame_idx,
                reverse=reverse,
                max_frame_num_to_track=max_track_distance,
            )
            for output in propagation_iter:
                if not isinstance(output, (list, tuple)) or len(output) < 3:
                    continue
                predictor_frame_index = int(output[0])
                logits = output[2]
                source_frame_index = _predictor_frame_to_source_frame(
                    predictor_frame_index,
                    frame_index_offset=frame_index_offset,
                )
                if source_frame_index < 0 or source_frame_index >= source.frame_count:
                    continue
                if source_frame_index < active_start_frame or source_frame_index > active_end_frame:
                    continue
                frames[source_frame_index] = _logits_to_binary_frame(logits)
                seen_frames.add(source_frame_index)
    except Exception as exc:  # pragma: no cover - environment dependent
        raise Sam2RuntimeError("SAM2 propagation failed") from exc

    if not seen_frames:
        raise Sam2RuntimeError(
            "SAM2 propagation returned no frames in the clip's visible source-time range"
        )

    return frames


def _resize_binary_frame_to_source(frame: np.ndarray, source: Sam2SourceMetadata) -> np.ndarray:
    if frame.shape == (source.height, source.width):
        return frame
    normalized = np.asarray(frame, dtype=np.uint8)
    resized = np.asarray(
        Image.fromarray(normalized, mode="L").resize(
            (source.width, source.height),
            resample=Image.Resampling.NEAREST,
        ),
        dtype=np.uint8,
    )
    return np.where(resized > 0, 255, 0).astype(np.uint8)


def _extract_cached_frame_from_inference_state(
    inference_state: Any,
    source: Sam2SourceMetadata,
    frame_index: int,
) -> np.ndarray | None:
    if not isinstance(inference_state, Mapping):
        return None

    output_dict_per_obj = inference_state.get("output_dict_per_obj")
    temp_output_dict_per_obj = inference_state.get("temp_output_dict_per_obj")
    if not isinstance(output_dict_per_obj, Mapping) or not isinstance(
        temp_output_dict_per_obj,
        Mapping,
    ):
        return None

    obj_indexes = set(output_dict_per_obj.keys()) | set(temp_output_dict_per_obj.keys())
    merged_frame: np.ndarray | None = None

    for obj_idx in obj_indexes:
        obj_out: Any | None = None

        obj_temp_output = temp_output_dict_per_obj.get(obj_idx)
        if isinstance(obj_temp_output, Mapping):
            for storage_key in ("cond_frame_outputs", "non_cond_frame_outputs"):
                frame_outputs = obj_temp_output.get(storage_key)
                if isinstance(frame_outputs, Mapping) and frame_index in frame_outputs:
                    obj_out = frame_outputs[frame_index]
                    break

        if obj_out is None:
            obj_output = output_dict_per_obj.get(obj_idx)
            if isinstance(obj_output, Mapping):
                for storage_key in ("cond_frame_outputs", "non_cond_frame_outputs"):
                    frame_outputs = obj_output.get(storage_key)
                    if isinstance(frame_outputs, Mapping) and frame_index in frame_outputs:
                        obj_out = frame_outputs[frame_index]
                        break

        if not isinstance(obj_out, Mapping):
            continue

        logits = obj_out.get("pred_masks")
        if logits is None:
            continue

        object_frame = _logits_to_binary_frame(logits)
        object_frame = _resize_binary_frame_to_source(object_frame, source)

        if merged_frame is None:
            merged_frame = object_frame
        else:
            merged_frame = np.where(
                (merged_frame > 0) | (object_frame > 0),
                255,
                0,
            ).astype(np.uint8)

    return merged_frame


def generate_mask_video(
    source_id: str,
    points: list[Sam2Point],
    ticks_per_second: float,
    mask_id: str | None = None,
    visible_source_start_ticks: float | None = None,
    visible_source_duration_ticks: float | None = None,
) -> Sam2GeneratedMaskVideo:
    source = get_source_metadata(source_id)
    points_by_frame = group_points_by_frame(
        points=points,
        fps=source.fps,
        ticks_per_second=ticks_per_second,
        frame_count=source.frame_count,
    )
    if not points_by_frame:
        raise Sam2RuntimeError("No SAM2 points were provided")

    frame_window = _source_ticks_range_to_frame_window(
        source=source,
        ticks_per_second=ticks_per_second,
        visible_source_start_ticks=visible_source_start_ticks,
        visible_source_duration_ticks=visible_source_duration_ticks,
    )
    frames = _run_sam2_propagation(
        source,
        points_by_frame,
        mask_id=mask_id,
        frame_window=frame_window,
    )
    try:
        video_bytes = encode_binary_masks_to_transparent_webm(frames, source.fps)
    except Sam2EncodingError as exc:
        raise Sam2RuntimeError(str(exc)) from exc

    return Sam2GeneratedMaskVideo(
        video_bytes=video_bytes,
        width=source.width,
        height=source.height,
        fps=source.fps,
        frame_count=source.frame_count,
    )


def generate_single_frame_mask(
    source_id: str,
    points: list[Sam2Point],
    ticks_per_second: float,
    time_ticks: float,
    mask_id: str | None = None,
) -> Sam2GeneratedMaskFrame:
    source = get_source_metadata(source_id)
    target_frame_index = _time_ticks_to_frame_index(
        time_ticks=time_ticks,
        fps=source.fps,
        ticks_per_second=ticks_per_second,
        frame_count=source.frame_count,
    )

    predictor = _runtime.get_predictor()
    frame_index_offset = 0
    predictor_frame_count = source.frame_count
    target_frame_window = (target_frame_index, target_frame_index)
    if mask_id:
        session = _get_or_create_editor_session(
            source,
            mask_id,
            frame_window=target_frame_window,
        )
        inference_state = session.inference_state
        frame_index_offset = session.frame_index_offset
        predictor_frame_count = session.frame_count
    else:
        if not points:
            raise Sam2RuntimeError(
                "mask_id is required when requesting a predictor frame without points"
            )
        (
            inference_state,
            _,
            frame_index_offset,
            predictor_frame_count,
        ) = _initialize_inference_state(
            predictor=predictor,
            source=source,
            frame_window=target_frame_window,
        )
        if hasattr(predictor, "reset_state"):
            predictor.reset_state(inference_state)

    predictor_target_frame_index = _source_frame_to_predictor_frame(
        target_frame_index,
        frame_index_offset=frame_index_offset,
        predictor_frame_count=predictor_frame_count,
    )
    if predictor_target_frame_index is None:
        raise Sam2RuntimeError(
            "The requested frame is outside the prepared source-time range for this SAM2 session."
        )

    if points:
        points_by_frame = group_points_by_frame(
            points=points,
            fps=source.fps,
            ticks_per_second=ticks_per_second,
            frame_count=source.frame_count,
        )
        frame_points = points_by_frame.get(target_frame_index)
        if not frame_points:
            raise Sam2RuntimeError(
                "No SAM2 points found at the requested frame. Add points at the current playhead frame."
            )

        points_np, labels_np = _points_to_predictor_arrays(
            frame_points,
            source.width,
            source.height,
        )
        add_result = _call_add_points(
            predictor,
            inference_state,
            predictor_target_frame_index,
            points_np,
            labels_np,
        )
        seeded_logits = _extract_logits_from_add_points_result(add_result)
        if seeded_logits is None:
            raise Sam2RuntimeError("SAM2 did not return logits for the requested frame")
        frame = _logits_to_binary_frame(seeded_logits)
        frame = _resize_binary_frame_to_source(frame, source)
    else:
        frame = _extract_cached_frame_from_inference_state(
            inference_state=inference_state,
            source=source,
            frame_index=predictor_target_frame_index,
        )
        if frame is None:
            raise Sam2RuntimeError(
                "No cached SAM2 frame is available at this time. Click 'Generate Current Frame Preview' or regenerate the mask video."
            )

    png_bytes = _encode_png_frame(frame)

    return Sam2GeneratedMaskFrame(
        png_bytes=png_bytes,
        width=source.width,
        height=source.height,
        frame_index=target_frame_index,
        time_ticks=float(time_ticks),
    )


def get_health() -> dict[str, Any]:
    with _EDITOR_SESSIONS_LOCK:
        active_sessions = len(_EDITOR_SESSIONS)
    return {
        "status": "ok",
        "runtime": _runtime.health(),
        "cacheDir": str(SAM2_CACHE_DIR),
        "activeEditorSessions": active_sessions,
    }
