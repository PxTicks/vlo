"""Decode, analyse, and crop WebM videos using PyAV.

Provides two main capabilities:

1. **analyse_mask_video_bounds** – scan a mask WebM to compute the union
   bounding-box crop region across all frames.
2. **crop_video** – spatially crop a WebM video (with or without alpha)
   to a given rectangle and re-encode.
"""

from __future__ import annotations

import logging
from fractions import Fraction
from io import BytesIO
from typing import TYPE_CHECKING, cast

import av
import numpy as np
from av.container.input import InputContainer
from av.video.stream import VideoStream

from services.gen_pipeline.processors.utils.mask_crop import (
    compute_mask_crop,
    get_mask_bounds_from_frame,
    union_bounds,
)

if TYPE_CHECKING:
    pass

log = logging.getLogger(__name__)


class VideoCropError(RuntimeError):
    """Raised when video cropping fails."""


# Frontend mask WebMs are analyzed as bright-on-dark RGB video where the white
# region is the ComfyUI replace area. After VP9/YUV roundtrips, nominal white
# often decodes near studio-range 235 instead of 255, while black backgrounds
# can lift slightly above 0. Use a modest cutoff so bright mask content stays
# positive without letting dark background noise dominate the bounds.
MASK_VIDEO_WHITE_THRESHOLD = 32


# ---------------------------------------------------------------------------
# Mask analysis
# ---------------------------------------------------------------------------


def get_video_dimensions(video_bytes: bytes) -> tuple[int, int]:
    """Return (width, height) of the first video stream without decoding frames."""
    container = av.open(BytesIO(video_bytes), mode="r")
    try:
        stream = container.streams.video[0]
        return stream.width, stream.height
    finally:
        container.close()


def analyze_mask_video_bounds(
    mask_bytes: bytes,
    target_ar: float,
    dilation: float = 0.1,
) -> tuple[int, int, int, int] | None:
    """Decode a mask WebM and compute the optimal crop region.

    Returns ``(x1, y1, x2, y2)`` with even-integer dimensions that enclose
    all mask content across every frame, expanded to *target_ar* and dilated
    by *dilation*.  Returns ``None`` when the mask is empty (no crop needed).
    """
    container = av.open(BytesIO(mask_bytes), mode="r")
    try:
        stream = container.streams.video[0]
        container_w = stream.width
        container_h = stream.height

        accumulated: tuple[int, int, int, int] | None = None

        for frame in container.decode(video=0):
            rgba = frame.to_ndarray(format="rgba")
            bounds = get_mask_bounds_from_frame(
                rgba[:, :, 0],
                threshold=MASK_VIDEO_WHITE_THRESHOLD,
            )
            accumulated = union_bounds(accumulated, bounds)
    finally:
        container.close()

    return compute_mask_crop(
        accumulated,
        container_w,
        container_h,
        target_ar,
        dilation,
    )


# ---------------------------------------------------------------------------
# Video cropping
# ---------------------------------------------------------------------------


def _detect_has_alpha(container: InputContainer) -> bool:
    """Return True if the first video stream uses a pixel format with alpha."""
    stream = container.streams.video[0]
    pix_fmt = stream.codec_context.pix_fmt or ""
    return "a" in pix_fmt  # e.g. yuva420p, rgba, etc.


def crop_video(
    video_bytes: bytes,
    crop: tuple[int, int, int, int],
) -> bytes:
    """Crop every frame of *video_bytes* to *crop* ``(x1, y1, x2, y2)`` and
    re-encode as WebM VP9.

    Preserves the alpha channel when the source has one.
    """
    x1, y1, x2, y2 = crop
    crop_w = x2 - x1
    crop_h = y2 - y1
    if crop_w <= 0 or crop_h <= 0:
        raise VideoCropError(
            f"Invalid crop dimensions: {crop_w}x{crop_h} from region {crop}"
        )

    in_container = av.open(BytesIO(video_bytes), mode="r")
    try:
        in_stream = in_container.streams.video[0]
        has_alpha = _detect_has_alpha(in_container)
        src_rate = in_stream.average_rate or Fraction(30, 1)

        buf = BytesIO()
        out_container = av.open(buf, mode="w", format="webm")
        try:
            out_stream = cast(VideoStream, out_container.add_stream("libvpx-vp9", rate=src_rate))
            out_stream.width = crop_w
            out_stream.height = crop_h
            out_stream.pix_fmt = "yuva420p" if has_alpha else "yuv420p"
            out_stream.options = {
                "lossless": "1",
                "row-mt": "1",
                "auto-alt-ref": "0",
            }

            src_fmt = "rgba" if has_alpha else "rgb24"

            for idx, frame in enumerate(in_container.decode(video=0)):
                arr = frame.to_ndarray(format=src_fmt)
                cropped = arr[y1:y2, x1:x2].copy()
                out_frame = av.VideoFrame.from_ndarray(cropped, format=src_fmt)
                out_frame.pts = idx
                for packet in out_stream.encode(out_frame):
                    out_container.mux(packet)

            # Flush encoder.
            for packet in out_stream.encode():
                out_container.mux(packet)
            out_container.close()
        except Exception:
            out_container.close()
            raise
    except VideoCropError:
        raise
    except Exception as exc:
        raise VideoCropError(f"Video crop failed: {exc}") from exc
    finally:
        in_container.close()

    return buf.getvalue()
