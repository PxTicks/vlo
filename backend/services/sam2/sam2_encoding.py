from io import BytesIO
from fractions import Fraction
import math
from collections.abc import Callable
from typing import cast

import av
import numpy as np
from av.video.stream import VideoStream
from av.video.frame import PictureType


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


def encode_mask_distance_fields_mp4(
    mask_frames: np.ndarray,
    fps: float,
    *,
    window_start_frame: int = 0,
    source_frame_count: int | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> bytes:
    """
    Encode distance-band mask frames (see sam2_distance) into an H.264 MP4.

    Each uint8 level is written to R, G and B, so it lives in full-resolution
    luma: red alone sits mostly in half-resolution chroma, which smears the
    edge by about half a pixel. Frames outside the window are level 0, far
    outside the mask.
    """
    frame_count, height, width = _validate_mask_frames(mask_frames)
    if window_start_frame < 0:
        raise Sam2EncodingError(
            f"Window start frame must be >= 0, got {window_start_frame}"
        )
    if source_frame_count is None:
        source_frame_count = window_start_frame + frame_count
    if source_frame_count <= 0:
        raise Sam2EncodingError(
            f"Source frame count must be > 0, got {source_frame_count}"
        )
    window_end_frame = window_start_frame + frame_count - 1
    if window_end_frame >= source_frame_count:
        raise Sam2EncodingError(
            "Mask window exceeds the source frame count: "
            f"window={window_start_frame}-{window_end_frame}, "
            f"source_frame_count={source_frame_count}"
        )

    av_rate = _fps_to_av_rate(fps)

    buf = BytesIO()
    try:
        output = av.open(buf, mode="w", format="mp4")
        stream = cast(VideoStream, output.add_stream("libx264", rate=av_rate))
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuv420p"
        # Avoid crf=0: x264 lossless forces the High 4:4:4 Predictive profile
        # (profile_idc 244), which consumer players (Windows Media Player,
        # hardware/browser decoders) reject even though the pix_fmt is 4:2:0.
        # A low crf keeps us on a broadly-compatible 4:2:0 profile (ultrafast
        # lands on Baseline); the distance band decodes to ~0.2 px RMS and its
        # midpoint cut is unbiased. The profile cap guards against richer presets.
        stream.options = {
            "crf": "18",
            "preset": "ultrafast",
            "profile": "high",
        }

        blank_mask = np.zeros((height, width), dtype=np.uint8)
        samples: list[tuple[int, np.ndarray, bool]] = []
        if window_start_frame > 0:
            samples.append((0, blank_mask, True))

        for local_index in range(frame_count):
            samples.append(
                (
                    window_start_frame + local_index,
                    mask_frames[local_index],
                    local_index == 0,
                )
            )

        # MP4 samples remain active until the following sample. Insert a blank
        # immediately after the window so the final mask does not fill the
        # source suffix, then retain a terminal sample for the source duration.
        post_window_frame = window_end_frame + 1
        if post_window_frame < source_frame_count:
            samples.append((post_window_frame, blank_mask, True))
        terminal_frame = source_frame_count - 1
        if samples[-1][0] < terminal_frame:
            samples.append((terminal_frame, blank_mask, False))

        for source_index, mask, force_keyframe in samples:
            if cancel_check is not None and cancel_check():
                raise Sam2EncodingError("SAM2 mask encoding was cancelled")
            rgb = np.repeat(np.asarray(mask, dtype=np.uint8)[..., None], 3, axis=-1)
            frame = av.VideoFrame.from_ndarray(rgb, format="rgb24")
            frame.pts = source_index
            if force_keyframe:
                frame.pict_type = PictureType.I
            for packet in stream.encode(frame):
                output.mux(packet)

        # Flush
        for packet in stream.encode():
            output.mux(packet)
        output.close()
    except Exception as exc:
        raise Sam2EncodingError(f"PyAV encoding failed: {exc}") from exc

    return buf.getvalue()
