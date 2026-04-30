"""Decode, analyse, and crop MP4 videos using PyAV.

Provides two main capabilities:

1. **analyse_mask_video_bounds** – scan a mask MP4 to compute the union
   bounding-box crop region across all frames.
2. **crop_video** – spatially crop an MP4 video
   to a given rectangle and re-encode.
"""

from __future__ import annotations

import logging
from fractions import Fraction
from io import BytesIO
from typing import cast

import av
import numpy as np
from av.audio.stream import AudioStream
from av.video.stream import VideoStream

from services.gen_pipeline.processors.utils.mask_crop import (
    compute_mask_crop,
    get_mask_bounds_from_frame,
    union_bounds,
)

log = logging.getLogger(__name__)


class VideoCropError(RuntimeError):
    """Raised when video cropping fails."""


# Frontend/runtime mask MP4s are analyzed as bright-on-dark red-channel video.
# After H.264/YUV roundtrips, nominal white often decodes near studio-range 235
# instead of 255, while black backgrounds can lift slightly above 0. Use a
# modest cutoff so bright mask content stays positive without letting dark
# background noise dominate the bounds.
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
    """Decode a mask MP4 and compute the optimal crop region.

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
            rgb = frame.to_ndarray(format="rgb24")
            bounds = get_mask_bounds_from_frame(
                rgb[:, :, 0],
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


def crop_video(
    video_bytes: bytes,
    crop: tuple[int, int, int, int],
    *,
    lossless: bool,
) -> bytes:
    """Crop every frame of *video_bytes* to *crop* ``(x1, y1, x2, y2)`` and
    re-encode as MP4 H.264, preserving audio streams by packet copy.
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
        src_rate = in_stream.average_rate or Fraction(30, 1)
        audio_in_streams = list(in_container.streams.audio)

        buf = BytesIO()
        out_container = av.open(buf, mode="w", format="mp4")
        try:
            out_stream = cast(VideoStream, out_container.add_stream("libx264", rate=src_rate))
            out_stream.width = crop_w
            out_stream.height = crop_h
            out_stream.pix_fmt = "yuv444p" if lossless else "yuv420p"
            out_stream.options = (
                {"crf": "0", "preset": "ultrafast"}
                if lossless
                else {"crf": "23", "preset": "ultrafast"}
            )
            out_stream.time_base = in_stream.time_base

            audio_stream_map: dict[int, AudioStream] = {}
            for audio_stream in audio_in_streams:
                out_audio_stream = cast(
                    AudioStream,
                    out_container.add_stream(
                        audio_stream.codec_context.name,
                        rate=audio_stream.rate,
                    ),
                )
                # PyAV 15 no longer exposes add_stream(template=...), so we
                # carry over codec-side data explicitly before packet copy.
                out_audio_stream.codec_context.extradata = (
                    audio_stream.codec_context.extradata
                )
                out_audio_stream.time_base = audio_stream.time_base
                audio_stream_map[audio_stream.index] = out_audio_stream

            src_fmt = "rgb24"

            for packet in in_container.demux(in_stream, *audio_in_streams):
                if packet.stream.type == "audio":
                    if packet.dts is None:
                        continue
                    out_audio_stream = audio_stream_map.get(packet.stream.index)
                    if out_audio_stream is None:
                        continue
                    packet.stream = out_audio_stream
                    out_container.mux(packet)
                    continue

                if packet.stream.type != "video":
                    continue

                for frame in packet.decode():
                    arr = frame.to_ndarray(format=src_fmt)
                    cropped = arr[y1:y2, x1:x2].copy()
                    out_frame = av.VideoFrame.from_ndarray(cropped, format=src_fmt)
                    out_frame.pts = frame.pts
                    out_frame.time_base = frame.time_base
                    for out_packet in out_stream.encode(out_frame):
                        out_container.mux(out_packet)

            # Flush encoder.
            for out_packet in out_stream.encode():
                out_container.mux(out_packet)
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
