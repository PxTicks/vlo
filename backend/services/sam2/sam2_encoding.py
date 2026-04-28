from io import BytesIO
from fractions import Fraction
import math
from typing import cast

import av
import numpy as np
from av.video.stream import VideoStream


class Sam2EncodingError(RuntimeError):
    """Raised when mask video encoding fails."""


def _fps_to_av_rate(fps: float) -> Fraction:
    numeric_fps = float(fps)
    if not math.isfinite(numeric_fps) or numeric_fps <= 0:
        raise Sam2EncodingError(f"FPS must be > 0 and finite, got {fps}")
    return Fraction(numeric_fps).limit_denominator(1_000_000)


def _validate_mask_frames(mask_frames: np.ndarray) -> tuple[int, int, int]:
    if mask_frames.ndim != 3:
        raise Sam2EncodingError(
            f"Expected mask frames shape (N,H,W), got {mask_frames.shape}"
        )
    frame_count, height, width = mask_frames.shape
    if frame_count <= 0 or height <= 0 or width <= 0:
        raise Sam2EncodingError(
            f"Invalid mask dimensions: frames={frame_count}, height={height}, width={width}"
        )
    return frame_count, height, width


def encode_binary_masks_to_red_mp4(mask_frames: np.ndarray, fps: float) -> bytes:
    """
    Encode binary mask frames into an H.264 MP4 without alpha.

    Each frame stores mask coverage in the red channel only:
    - R: 0 for background, 255 for mask
    - G: 0
    - B: 0
    """
    frame_count, height, width = _validate_mask_frames(mask_frames)

    av_rate = _fps_to_av_rate(fps)

    # Ensure uint8 binary values for deterministic encoding.
    if mask_frames.dtype != np.uint8:
        mask_frames = mask_frames.astype(np.uint8)
    mask_frames = np.where(mask_frames > 0, 255, 0).astype(np.uint8)

    buf = BytesIO()
    try:
        output = av.open(buf, mode="w", format="mp4")
        stream = cast(VideoStream, output.add_stream("libx264", rate=av_rate))
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuv420p"
        stream.options = {
            "crf": "0",
            "preset": "ultrafast",
        }

        for i in range(frame_count):
            mask = mask_frames[i]
            rgb = np.zeros((height, width, 3), dtype=np.uint8)
            rgb[..., 0] = mask
            frame = av.VideoFrame.from_ndarray(rgb, format="rgb24")
            frame.pts = i
            for packet in stream.encode(frame):
                output.mux(packet)

        # Flush
        for packet in stream.encode():
            output.mux(packet)
        output.close()
    except Exception as exc:
        raise Sam2EncodingError(f"PyAV encoding failed: {exc}") from exc

    return buf.getvalue()


def encode_binary_masks_to_transparent_mp4(mask_frames: np.ndarray, fps: float) -> bytes:
    """Backward-compatible wrapper for older call sites."""
    return encode_binary_masks_to_red_mp4(mask_frames, fps)
