import os
import shutil
import subprocess
import sys
from fractions import Fraction
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
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


def _make_mp4(
    width: int,
    height: int,
    num_frames: int,
    *,
    with_audio: bool = False,
    frame_fn=None,
) -> bytes:
    """Create a minimal MP4 in memory for crop analysis and crop tests."""
    if with_audio:
        if frame_fn is not None:
            raise ValueError("Audio-backed fixtures do not support custom frame_fn")
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            pytest.skip("ffmpeg is required to build audio-backed MP4 fixtures")
        duration_sec = max(num_frames / 10, 0.1)
        with TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "fixture.mp4"
            subprocess.run(
                [
                    ffmpeg,
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    f"color=c=black:s={width}x{height}:r=10:d={duration_sec}",
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=48000:cl=mono",
                    "-shortest",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    str(output_path),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return output_path.read_bytes()

    buf = BytesIO()
    container = av.open(buf, mode="w", format="mp4")
    video_stream = cast(
        VideoStream,
        container.add_stream("libx264", rate=Fraction(10, 1)),
    )
    video_stream.width = width
    video_stream.height = height
    video_stream.pix_fmt = "yuv420p"
    video_stream.options = {"crf": "0", "preset": "ultrafast"}

    for i in range(num_frames):
        if frame_fn is not None:
            arr = frame_fn(i, width, height)
        else:
            arr = np.zeros((height, width, 3), dtype=np.uint8)
        frame = av.VideoFrame.from_ndarray(arr, format="rgb24")
        frame.pts = i
        for packet in video_stream.encode(frame):
            container.mux(packet)

    for packet in video_stream.encode():
        container.mux(packet)

    container.close()
    return buf.getvalue()


def _mask_frame_fn(x1, y1, x2, y2):
    def fn(i, w, h):
        del i
        arr = np.zeros((h, w, 3), dtype=np.uint8)
        arr[y1:y2, x1:x2, 0] = 255
        return arr

    return fn


def _decode_stream_summary(video_bytes: bytes) -> tuple[int, int, int, str]:
    container = av.open(BytesIO(video_bytes), mode="r")
    try:
        stream = container.streams.video[0]
        return (
            stream.width,
            stream.height,
            len(container.streams.audio),
            stream.codec_context.pix_fmt or "",
        )
    finally:
        container.close()


class TestAnalyzeMaskVideoBounds:
    def test_empty_mask_returns_none(self):
        mp4 = _make_mp4(320, 180, 3)
        result = analyze_mask_video_bounds(mp4, target_ar=16 / 9, dilation=0.1)
        assert result is None

    def test_small_mask_returns_crop(self):
        mp4 = _make_mp4(
            320,
            180,
            3,
            frame_fn=_mask_frame_fn(100, 60, 200, 120),
        )
        result = analyze_mask_video_bounds(mp4, target_ar=16 / 9, dilation=0.1)
        assert result is not None
        x1, y1, x2, y2 = result
        assert x1 <= 100
        assert y1 <= 60
        assert x2 >= 200
        assert y2 >= 120
        assert x1 >= 0 and y1 >= 0
        assert x2 <= 320 and y2 <= 180

    def test_video_range_white_foreground_still_returns_crop(self):
        def video_range_mask(i, w, h):
            del i
            arr = np.zeros((h, w, 3), dtype=np.uint8)
            arr[60:120, 100:200, 0] = 235
            return arr

        mp4 = _make_mp4(320, 180, 3, frame_fn=video_range_mask)
        result = analyze_mask_video_bounds(mp4, target_ar=16 / 9, dilation=0.1)
        assert result is not None
        x1, y1, x2, y2 = result
        assert x1 <= 100
        assert y1 <= 60
        assert x2 >= 200
        assert y2 >= 120

    def test_full_mask_returns_none(self):
        def full_mask(i, w, h):
            del i
            arr = np.zeros((h, w, 3), dtype=np.uint8)
            arr[..., 0] = 255
            return arr

        mp4 = _make_mp4(320, 180, 2, frame_fn=full_mask)
        result = analyze_mask_video_bounds(mp4, target_ar=16 / 9, dilation=0.0)
        assert result is None


class TestCropVideo:
    def test_crop_dimensions(self):
        mp4 = _make_mp4(320, 180, 2)
        crop = (50, 20, 250, 160)
        cropped = crop_video(mp4, crop, lossless=False)
        width, height, _, _ = _decode_stream_summary(cropped)
        assert width == 200
        assert height == 140

    def test_crop_preserves_audio_streams(self):
        mp4 = _make_mp4(320, 180, 2, with_audio=True)
        cropped = crop_video(mp4, (0, 0, 160, 90), lossless=False)
        _, _, audio_stream_count, _ = _decode_stream_summary(cropped)
        assert audio_stream_count == 1

    def test_crop_uses_lossless_profile_only_when_requested(self):
        mp4 = _make_mp4(320, 180, 1)
        lossless = crop_video(mp4, (0, 0, 160, 90), lossless=True)
        lossy = crop_video(mp4, (0, 0, 160, 90), lossless=False)
        _, _, _, lossless_pix_fmt = _decode_stream_summary(lossless)
        _, _, _, lossy_pix_fmt = _decode_stream_summary(lossy)

        assert "444" in lossless_pix_fmt
        assert "420" in lossy_pix_fmt

    def test_crop_preserves_content(self):
        def colored_frame(i, w, h):
            del i
            arr = np.zeros((h, w, 3), dtype=np.uint8)
            arr[40:60, 80:120, 0] = 200
            return arr

        mp4 = _make_mp4(320, 180, 1, frame_fn=colored_frame)
        cropped = crop_video(mp4, (60, 20, 140, 80), lossless=False)
        width, height, _, _ = _decode_stream_summary(cropped)
        assert width == 80
        assert height == 60

    def test_invalid_crop_raises(self):
        mp4 = _make_mp4(320, 180, 1)
        with pytest.raises(Exception):
            crop_video(mp4, (100, 100, 50, 50), lossless=False)
