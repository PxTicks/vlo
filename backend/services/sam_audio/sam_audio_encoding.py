from __future__ import annotations

from io import BytesIO
from typing import Any

import numpy as np
import soundfile as sf


class SamAudioEncodingError(RuntimeError):
    """Raised when SAM-Audio stem encoding fails."""


def _to_numpy_audio(audio: Any) -> np.ndarray:
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    else:
        audio = np.asarray(audio)

    array = np.asarray(audio, dtype=np.float32)
    if array.ndim == 0:
        raise SamAudioEncodingError("Audio tensor is scalar")
    if array.ndim == 1:
        array = array[:, None]
    elif array.ndim == 2:
        # soundfile expects (samples, channels). SAM-Audio/torchaudio commonly
        # uses (channels, samples), so transpose when the first dimension looks
        # like a channel count.
        if array.shape[0] <= 8 and array.shape[0] < array.shape[1]:
            array = array.T
    else:
        raise SamAudioEncodingError(f"Expected 1D or 2D audio, got shape {array.shape}")

    if array.size == 0:
        raise SamAudioEncodingError("Audio tensor is empty")

    array = np.nan_to_num(array, nan=0.0, posinf=0.0, neginf=0.0)
    return np.clip(array, -1.0, 1.0)


def encode_wav_bytes(audio: Any, sample_rate: int) -> bytes:
    if sample_rate <= 0:
        raise SamAudioEncodingError(f"sample_rate must be positive, got {sample_rate}")

    buffer = BytesIO()
    try:
        sf.write(buffer, _to_numpy_audio(audio), sample_rate, format="WAV", subtype="PCM_16")
    except Exception as exc:  # pragma: no cover - soundfile environment dependent
        raise SamAudioEncodingError(f"Failed to encode SAM-Audio stem WAV: {exc}") from exc
    return buffer.getvalue()
