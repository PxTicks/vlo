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


def encode_binary_masks_to_transparent_webm(mask_frames: np.ndarray, fps: float) -> bytes:
    """
    Encodes binary mask frames (0/255) into a VP9 WebM with alpha.

    Each frame is stored as black/white in RGB plus matching alpha:
    - RGB: 0 for background, 255 for mask
    - A:   0 for background, 255 for mask
    """
    frame_count, height, width = _validate_mask_frames(mask_frames)

    av_rate = _fps_to_av_rate(fps)

    # Ensure uint8 binary values for deterministic encoding.
    if mask_frames.dtype != np.uint8:
        mask_frames = mask_frames.astype(np.uint8)
    mask_frames = np.where(mask_frames > 0, 255, 0).astype(np.uint8)

    buf = BytesIO()
    try:
        output = av.open(buf, mode="w", format="webm")
        stream = cast(VideoStream, output.add_stream("libvpx-vp9", rate=av_rate))
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuva420p"
        stream.options = {
            "lossless": "1",
            "row-mt": "1",
            "auto-alt-ref": "0",
        }

        for i in range(frame_count):
            mask = mask_frames[i]
            # Build YUVA420p frame: Y=mask value, U/V=128 (neutral), A=mask value
            # Using rgb24 intermediate and letting PyAV convert is simpler and reliable
            rgba = np.zeros((height, width, 4), dtype=np.uint8)
            rgba[..., 0] = mask  # R
            rgba[..., 1] = mask  # G
            rgba[..., 2] = mask  # B
            rgba[..., 3] = mask  # A
            frame = av.VideoFrame.from_ndarray(rgba, format="rgba")
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
