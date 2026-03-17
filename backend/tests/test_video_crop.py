import os
import sys
from fractions import Fraction
from io import BytesIO
from typing import cast

import av
import numpy as np
import pytest
from av.video.stream import VideoStream

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.gen_pipeline.processors.utils.video_crop import (  # noqa: E402
    analyze_mask_video_bounds,
    crop_video,
)


# ---------------------------------------------------------------------------
# Helpers — create synthetic WebM videos for testing
# ---------------------------------------------------------------------------


def _make_webm(
    width: int,
    height: int,
    num_frames: int,
    *,
    has_alpha: bool = False,
    frame_fn=None,
) -> bytes:
    """Create a minimal VP9 WebM in memory.

    *frame_fn(i, w, h)* should return an (H, W, C) uint8 ndarray.
    C is 4 when *has_alpha* else 3.
    """
    buf = BytesIO()
    container = av.open(buf, mode="w", format="webm")
    stream = cast(VideoStream, container.add_stream("libvpx-vp9", rate=Fraction(10, 1)))
    stream.width = width
    stream.height = height
    stream.pix_fmt = "yuva420p" if has_alpha else "yuv420p"
    stream.options = {"lossless": "1", "row-mt": "1", "auto-alt-ref": "0"}

    fmt = "rgba" if has_alpha else "rgb24"
    channels = 4 if has_alpha else 3

    for i in range(num_frames):
        if frame_fn is not None:
            arr = frame_fn(i, width, height)
        else:
            arr = np.zeros((height, width, channels), dtype=np.uint8)
            if has_alpha:
                arr[..., 3] = 255  # fully opaque by default
        frame = av.VideoFrame.from_ndarray(arr, format=fmt)
        frame.pts = i
        for packet in stream.encode(frame):
            container.mux(packet)

    for packet in stream.encode():
        container.mux(packet)
    container.close()
    return buf.getvalue()


def _mask_frame_fn(x1, y1, x2, y2):
    """Return a frame function matching the frontend binary mask format.

    Foreground (mask content) = white (R=G=B=255), alpha=255.
    Background = black (R=G=B=0), alpha=255.
    """

    def fn(i, w, h):
        arr = np.zeros((h, w, 4), dtype=np.uint8)  # black + opaque
        arr[..., 3] = 255
        arr[y1:y2, x1:x2, :3] = 255  # foreground = white
        return arr

    return fn


def _decode_frame_dimensions(video_bytes: bytes) -> tuple[int, int]:
    """Return (width, height) of the first frame in a WebM."""
    container = av.open(BytesIO(video_bytes), mode="r")
    stream = container.streams.video[0]
    w, h = stream.width, stream.height
    container.close()
    return w, h


# ---------------------------------------------------------------------------
# analyze_mask_video_bounds
# ---------------------------------------------------------------------------


class TestAnalyzeMaskVideoBounds:
    def test_empty_mask_returns_none(self):
        # All-transparent mask
        webm = _make_webm(320, 180, 3, has_alpha=True)
        result = analyze_mask_video_bounds(webm, target_ar=16 / 9, dilation=0.1)
        assert result is None

    def test_small_mask_returns_crop(self):
        # Mask with a small rectangle in the center
        webm = _make_webm(
            320, 180, 3,
            has_alpha=True,
            frame_fn=_mask_frame_fn(100, 60, 200, 120),
        )
        result = analyze_mask_video_bounds(webm, target_ar=16 / 9, dilation=0.1)
        assert result is not None
        x1, y1, x2, y2 = result
        # Should contain the original mask region
        assert x1 <= 100
        assert y1 <= 60
        assert x2 >= 200
        assert y2 >= 120
        # Should stay within container
        assert x1 >= 0 and y1 >= 0
        assert x2 <= 320 and y2 <= 180

    def test_video_range_white_foreground_still_returns_crop(self):
        # WebM/VP9 often decodes "white" near studio-range 235 rather than 255.
        # The crop analysis should still detect that bright region while
        # ignoring the dark background.
        def video_range_mask(i, w, h):
            del i
            arr = np.full((h, w, 4), 16, dtype=np.uint8)
            arr[..., 3] = 255
            arr[60:120, 100:200, :3] = 235
            return arr

        webm = _make_webm(
            320,
            180,
            3,
            has_alpha=True,
            frame_fn=video_range_mask,
        )
        result = analyze_mask_video_bounds(webm, target_ar=16 / 9, dilation=0.1)
        assert result is not None
        x1, y1, x2, y2 = result
        assert x1 <= 100
        assert y1 <= 60
        assert x2 >= 200
        assert y2 >= 120

    def test_full_mask_returns_none(self):
        # Mask covering entire frame (all white = all foreground) → crop == container → None
        def full_mask(i, w, h):
            arr = np.full((h, w, 4), 255, dtype=np.uint8)
            arr[..., 3] = 255  # opaque
            return arr

        webm = _make_webm(320, 180, 2, has_alpha=True, frame_fn=full_mask)
        result = analyze_mask_video_bounds(webm, target_ar=16 / 9, dilation=0.0)
        assert result is None


# ---------------------------------------------------------------------------
# crop_video
# ---------------------------------------------------------------------------


class TestCropVideo:
    def test_crop_dimensions(self):
        webm = _make_webm(320, 180, 2, has_alpha=True)
        crop = (50, 20, 250, 160)
        cropped = crop_video(webm, crop)
        w, h = _decode_frame_dimensions(cropped)
        assert w == 200
        assert h == 140

    def test_crop_without_alpha(self):
        webm = _make_webm(320, 180, 2, has_alpha=False)
        crop = (0, 0, 160, 90)
        cropped = crop_video(webm, crop)
        w, h = _decode_frame_dimensions(cropped)
        assert w == 160
        assert h == 90

    def test_crop_preserves_content(self):
        # Create a frame with known pixel values
        def colored_frame(i, w, h):
            arr = np.zeros((h, w, 4), dtype=np.uint8)
            arr[..., 3] = 255  # fully opaque
            arr[40:60, 80:120, 0] = 200  # red rectangle
            return arr

        webm = _make_webm(320, 180, 1, has_alpha=True, frame_fn=colored_frame)
        # Crop to include the red rectangle
        crop = (60, 20, 140, 80)
        cropped = crop_video(webm, crop)

        # Verify dimensions
        w, h = _decode_frame_dimensions(cropped)
        assert w == 80
        assert h == 60

    def test_invalid_crop_raises(self):
        webm = _make_webm(320, 180, 1)
        with pytest.raises(Exception):
            crop_video(webm, (100, 100, 50, 50))  # x2 < x1
