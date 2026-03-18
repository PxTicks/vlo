import os
import sys
import types
from collections.abc import Callable
from fractions import Fraction
from io import BytesIO
from pathlib import Path
from typing import Any, cast

import av
import anyio
import numpy as np
import pytest
from fastapi import HTTPException
from PIL import Image

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routers import sam2 as sam2_router  # noqa: E402
from routers.sam2 import (  # noqa: E402
    Sam2GenerateFrameRequest,
    Sam2GenerateMaskRequest,
    Sam2PointRequest,
)
from services.sam2 import sam2_service  # noqa: E402
from services.sam2.sam2_service import (  # noqa: E402
    Sam2GeneratedMaskFrame,
    Sam2GeneratedMaskVideo,
    Sam2Point,
    Sam2SourceMetadata,
    Sam2SourceNotFoundError,
)


def _configure_tmp_cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    sources_dir = tmp_path / "sources"
    metadata_dir = tmp_path / "metadata"
    sources_dir.mkdir(parents=True, exist_ok=True)
    metadata_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(sam2_service, "SOURCES_DIR", sources_dir)
    monkeypatch.setattr(sam2_service, "METADATA_DIR", metadata_dir)


def _write_mp4(
    video_path: Path,
    width: int,
    height: int,
    num_frames: int,
    *,
    fps: Fraction = Fraction(10, 1),
    frame_fn: Callable[[int, int, int], np.ndarray] | None = None,
) -> None:
    container = av.open(str(video_path), mode="w")
    try:
        stream = container.add_stream("mpeg4", rate=fps)
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuv420p"

        for index in range(num_frames):
            if frame_fn is None:
                frame_array = np.zeros((height, width, 3), dtype=np.uint8)
            else:
                frame_array = frame_fn(index, width, height)
            frame = av.VideoFrame.from_ndarray(frame_array, format="rgb24")
            frame.pts = index
            for packet in stream.encode(frame):
                container.mux(packet)

        for packet in stream.encode():
            container.mux(packet)
    finally:
        container.close()


def test_group_points_by_frame_uses_time_ticks() -> None:
    points: list[Sam2Point] = [
        {"x": 0.5, "y": 0.5, "label": 1, "timeTicks": 0},
        {"x": 0.2, "y": 0.3, "label": 0, "timeTicks": 96_000},
        {"x": 0.7, "y": 0.9, "label": 1, "timeTicks": 192_000},
    ]
    grouped = sam2_service.group_points_by_frame(
        points=points,
        fps=24.0,
        ticks_per_second=96_000,
        frame_count=100,
    )
    assert sorted(grouped.keys()) == [0, 24, 48]


def test_source_ticks_range_to_frame_window_maps_to_expected_bounds() -> None:
    source = Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=Path("/tmp/source.mp4"),
        width=1920,
        height=1080,
        fps=24.0,
        frame_count=120,
        duration_sec=5.0,
    )

    frame_window = sam2_service._source_ticks_range_to_frame_window(
        source=source,
        ticks_per_second=96_000,
        visible_source_start_ticks=96_000,      # 1s
        visible_source_duration_ticks=192_000,  # +2s
    )

    assert frame_window == (24, 71)


def test_register_source_video_dedupes_by_hash(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_tmp_cache(monkeypatch, tmp_path)

    inspect_calls: list[Path] = []

    def fake_inspect(video_path: Path) -> Sam2SourceMetadata:
        inspect_calls.append(video_path)
        source_id = video_path.stem.split(".", 1)[0]
        return Sam2SourceMetadata(
            source_id=source_id,
            source_hash=source_id,
            path=video_path,
            width=640,
            height=360,
            fps=30.0,
            frame_count=300,
            duration_sec=10.0,
        )

    monkeypatch.setattr(sam2_service, "_inspect_video", fake_inspect)

    first = sam2_service.register_source_bytes(
        source_hash="abc123",
        filename="sample.mp4",
        data=b"first-video",
    )
    second = sam2_service.register_source_bytes(
        source_hash="abc123",
        filename="sample.mp4",
        data=b"second-video",
    )

    assert first.source_id == "abc123"
    assert second.source_id == "abc123"
    assert len(inspect_calls) == 1
    assert first.path.read_bytes() == b"first-video"


def test_inspect_video_reads_metadata_from_pyav(tmp_path: Path) -> None:
    video_path = tmp_path / "source.mp4"
    _write_mp4(video_path, width=4, height=3, num_frames=6, fps=Fraction(12, 1))

    metadata = sam2_service._inspect_video(video_path)

    assert metadata.width == 4
    assert metadata.height == 3
    assert metadata.fps == pytest.approx(12.0)
    assert metadata.frame_count == 6
    assert metadata.duration_sec == pytest.approx(0.5)


def test_extract_video_frames_to_jpeg_uses_requested_window(tmp_path: Path) -> None:
    video_path = tmp_path / "source.mp4"

    def frame_fn(index: int, width: int, height: int) -> np.ndarray:
        frame = np.zeros((height, width, 3), dtype=np.uint8)
        frame[..., index % 3] = 255
        return frame

    _write_mp4(video_path, width=5, height=4, num_frames=4, frame_fn=frame_fn)
    frames_dir = sam2_service._extract_video_frames_to_jpeg(
        video_path,
        tmp_path / "frames",
        frame_window=(1, 2),
    )

    extracted_files = sorted(frames_dir.glob("*.jpg"))

    assert [path.name for path in extracted_files] == ["00000.jpg", "00001.jpg"]
    with Image.open(extracted_files[0]) as image:
        assert image.size == (5, 4)


def test_encode_png_frame_returns_valid_grayscale_png() -> None:
    frame = np.array(
        [
            [0, 255],
            [255, 0],
        ],
        dtype=np.uint8,
    )

    encoded = sam2_service._encode_png_frame(frame)

    with Image.open(BytesIO(encoded)) as image:
        assert image.mode == "L"
        assert image.size == (2, 2)
        assert np.array_equal(np.asarray(image), frame)


def test_resize_binary_frame_to_source_uses_nearest_neighbor() -> None:
    source = Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=Path("/tmp/source.mp4"),
        width=4,
        height=4,
        fps=24.0,
        frame_count=10,
        duration_sec=10 / 24.0,
    )
    frame = np.array(
        [
            [0, 255],
            [255, 0],
        ],
        dtype=np.uint8,
    )

    resized = sam2_service._resize_binary_frame_to_source(frame, source)

    assert np.array_equal(
        resized,
        np.array(
            [
                [0, 0, 255, 255],
                [0, 0, 255, 255],
                [255, 255, 0, 0],
                [255, 255, 0, 0],
            ],
            dtype=np.uint8,
        ),
    )


def test_generate_endpoint_rejects_empty_points() -> None:
    request = Sam2GenerateMaskRequest(
        sourceId="source_1",
        points=[],
        ticksPerSecond=96_000,
    )
    with pytest.raises(HTTPException) as exc_info:
        anyio.run(sam2_router.generate_sam2_mask_video, request)
    assert exc_info.value.status_code == 400
    assert "point" in str(exc_info.value.detail).lower()


def test_generate_endpoint_returns_404_for_missing_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def direct_threadpool(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(sam2_router, "run_in_threadpool", direct_threadpool)

    def fake_generate(*args, **kwargs):
        raise Sam2SourceNotFoundError("missing source")

    monkeypatch.setattr(sam2_service, "generate_mask_video", fake_generate)

    request = Sam2GenerateMaskRequest(
        sourceId="missing",
        points=[Sam2PointRequest(x=0.5, y=0.5, label=1, timeTicks=0)],
        ticksPerSecond=96_000,
        maskId="mask_1",
    )
    with pytest.raises(HTTPException) as exc_info:
        anyio.run(sam2_router.generate_sam2_mask_video, request)
    assert exc_info.value.status_code == 404
    assert "missing source" in str(exc_info.value.detail)


def test_generate_endpoint_returns_webm_with_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def direct_threadpool(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(sam2_router, "run_in_threadpool", direct_threadpool)

    def fake_generate(*args, **kwargs):
        return Sam2GeneratedMaskVideo(
            video_bytes=b"fake-webm-data",
            width=1280,
            height=720,
            fps=23.976,
            frame_count=120,
        )

    monkeypatch.setattr(sam2_service, "generate_mask_video", fake_generate)

    request = Sam2GenerateMaskRequest(
        sourceId="source_ok",
        points=[Sam2PointRequest(x=0.5, y=0.5, label=1, timeTicks=0)],
        ticksPerSecond=96_000,
        maskId="mask_1",
    )
    response = anyio.run(sam2_router.generate_sam2_mask_video, request)

    assert response.body == b"fake-webm-data"
    assert response.media_type == "video/webm"
    assert response.headers["x-sam2-width"] == "1280"
    assert response.headers["x-sam2-height"] == "720"
    assert response.headers["x-sam2-frame-count"] == "120"


def test_generate_endpoint_forwards_visible_source_range(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def direct_threadpool(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(sam2_router, "run_in_threadpool", direct_threadpool)

    captured_call: dict[str, object] = {}

    def fake_generate(*args, **kwargs):
        captured_call["args"] = args
        captured_call["kwargs"] = kwargs
        return Sam2GeneratedMaskVideo(
            video_bytes=b"fake-webm-data",
            width=640,
            height=360,
            fps=24.0,
            frame_count=100,
        )

    monkeypatch.setattr(sam2_service, "generate_mask_video", fake_generate)

    request = Sam2GenerateMaskRequest(
        sourceId="source_ok",
        points=[Sam2PointRequest(x=0.5, y=0.5, label=1, timeTicks=0)],
        ticksPerSecond=96_000,
        maskId="mask_1",
        visibleSourceStartTicks=9_600,
        visibleSourceDurationTicks=48_000,
    )
    response = anyio.run(sam2_router.generate_sam2_mask_video, request)

    assert response.status_code == 200
    assert captured_call["args"] == (
        "source_ok",
        [{"x": 0.5, "y": 0.5, "label": 1, "timeTicks": 0.0}],
        96_000.0,
        "mask_1",
        9_600.0,
        48_000.0,
    )
    assert captured_call["kwargs"] == {}


def test_generate_frame_endpoint_rejects_empty_points_without_mask_id() -> None:
    request = Sam2GenerateFrameRequest(
        sourceId="source_1",
        points=[],
        ticksPerSecond=96_000,
        timeTicks=0,
    )
    with pytest.raises(HTTPException) as exc_info:
        anyio.run(sam2_router.generate_sam2_mask_frame, request)
    assert exc_info.value.status_code == 400
    assert "maskid" in str(exc_info.value.detail).lower()


def test_generate_frame_endpoint_allows_empty_points_with_mask_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def direct_threadpool(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(sam2_router, "run_in_threadpool", direct_threadpool)

    def fake_generate(*args, **kwargs):
        return Sam2GeneratedMaskFrame(
            png_bytes=b"cached-frame",
            width=640,
            height=360,
            frame_index=7,
            time_ticks=1024.0,
        )

    monkeypatch.setattr(sam2_service, "generate_single_frame_mask", fake_generate)

    request = Sam2GenerateFrameRequest(
        sourceId="source_ok",
        points=[],
        ticksPerSecond=96_000,
        timeTicks=1024,
        maskId="mask_1",
    )
    response = anyio.run(sam2_router.generate_sam2_mask_frame, request)

    assert response.status_code == 200
    assert response.body == b"cached-frame"
    assert response.headers["x-sam2-frame-index"] == "7"


def test_generate_frame_endpoint_returns_png_with_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def direct_threadpool(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(sam2_router, "run_in_threadpool", direct_threadpool)

    def fake_generate(*args, **kwargs):
        return Sam2GeneratedMaskFrame(
            png_bytes=b"fake-png-data",
            width=1920,
            height=1080,
            frame_index=42,
            time_ticks=13440.0,
        )

    monkeypatch.setattr(sam2_service, "generate_single_frame_mask", fake_generate)

    request = Sam2GenerateFrameRequest(
        sourceId="source_ok",
        points=[Sam2PointRequest(x=0.5, y=0.5, label=1, timeTicks=13440)],
        ticksPerSecond=96_000,
        timeTicks=13440,
        maskId="mask_1",
    )
    response = anyio.run(sam2_router.generate_sam2_mask_frame, request)

    assert response.body == b"fake-png-data"
    assert response.media_type == "image/png"
    assert response.headers["x-sam2-width"] == "1920"
    assert response.headers["x-sam2-height"] == "1080"
    assert response.headers["x-sam2-frame-index"] == "42"


def test_generate_single_frame_mask_adds_points_only_on_requested_frame(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.mp4"
    source_path.write_bytes(b"video")
    source = Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=source_path,
        width=2,
        height=2,
        fps=24.0,
        frame_count=8,
        duration_sec=8 / 24.0,
    )

    class FakePredictor:
        def __init__(self) -> None:
            self.reset_calls = 0
            self.add_calls: list[int] = []

        def reset_state(self, _inference_state: object) -> None:
            self.reset_calls += 1

        def add_new_points_or_box(self, **kwargs):
            self.add_calls.append(int(kwargs["frame_idx"]))
            return (None, [1], np.ones((1, 2, 2), dtype=np.float32))

    fake_predictor = FakePredictor()

    monkeypatch.setattr(sam2_service, "get_source_metadata", lambda _source_id: source)
    monkeypatch.setattr(sam2_service._runtime, "get_predictor", lambda: fake_predictor)
    monkeypatch.setattr(
        sam2_service,
        "_initialize_inference_state",
        lambda predictor, source, frame_window=None: (
            {"inference": "state"},
            source.path,
            0,
            source.frame_count,
        ),
    )

    generated = sam2_service.generate_single_frame_mask(
        source_id="source_1",
        points=[
            {"x": 0.1, "y": 0.2, "label": 1, "timeTicks": 4_000},  # frame 1
            {"x": 0.5, "y": 0.5, "label": 1, "timeTicks": 12_000},  # frame 3
        ],
        ticks_per_second=96_000,
        time_ticks=12_000,  # frame 3 @ 24fps
    )

    assert generated.frame_index == 3
    assert generated.width == 2
    assert generated.height == 2
    assert generated.png_bytes
    assert fake_predictor.reset_calls == 1
    assert fake_predictor.add_calls == [3]


def test_generate_single_frame_mask_reads_cached_frame_when_points_omitted(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.mp4"
    source_path.write_bytes(b"video")
    source = Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=source_path,
        width=2,
        height=2,
        fps=24.0,
        frame_count=8,
        duration_sec=8 / 24.0,
    )

    class FakePredictor:
        pass

    fake_predictor = FakePredictor()
    cached_state = {
        "output_dict_per_obj": {
            0: {
                "cond_frame_outputs": {},
                "non_cond_frame_outputs": {
                    1: {"pred_masks": np.ones((1, 2, 2), dtype=np.float32)}
                },
            }
        },
        "temp_output_dict_per_obj": {},
    }

    monkeypatch.setattr(sam2_service, "get_source_metadata", lambda _source_id: source)
    monkeypatch.setattr(sam2_service._runtime, "get_predictor", lambda: fake_predictor)
    monkeypatch.setattr(
        sam2_service,
        "_get_or_create_editor_session",
        lambda _source, _mask_id, frame_window=None: types.SimpleNamespace(
            inference_state=cached_state,
            frame_index_offset=2,
            frame_count=3,
        ),
    )

    generated = sam2_service.generate_single_frame_mask(
        source_id="source_1",
        points=[],
        ticks_per_second=96_000,
        time_ticks=12_000,  # frame 3 @ 24fps
        mask_id="mask_1",
    )

    assert generated.frame_index == 3
    assert generated.width == 2
    assert generated.height == 2
    assert generated.png_bytes


def test_run_sam2_propagation_seeds_conditioning_frames_and_runs_bidirectional(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakePredictor:
        def __init__(self) -> None:
            self.propagate_calls: list[tuple[int, bool]] = []

        def init_state(self, video_path: str) -> dict[str, str]:
            return {"video_path": video_path}

        def reset_state(self, _inference_state: object) -> None:
            return None

        def add_new_points_or_box(self, **kwargs):
            frame_idx = int(kwargs["frame_idx"])
            if frame_idx == 2:
                return (None, [1], np.ones((1, 2, 2), dtype=np.float32))
            return (None, [1], np.zeros((1, 2, 2), dtype=np.float32))

        def propagate_in_video(
            self,
            _inference_state: object,
            start_frame_idx: int = 0,
            reverse: bool = False,
        ):
            self.propagate_calls.append((start_frame_idx, reverse))
            if reverse:
                yield (0, [1], np.ones((1, 2, 2), dtype=np.float32))
                yield (1, [1], np.ones((1, 2, 2), dtype=np.float32))
            else:
                yield (3, [1], np.ones((1, 2, 2), dtype=np.float32))
                yield (4, [1], np.ones((1, 2, 2), dtype=np.float32))

    fake_predictor = FakePredictor()
    monkeypatch.setattr(sam2_service._runtime, "get_predictor", lambda: fake_predictor)

    source_path = tmp_path / "source.mp4"
    source_path.write_bytes(b"video")
    source = Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=source_path,
        width=2,
        height=2,
        fps=24.0,
        frame_count=5,
        duration_sec=5 / 24.0,
    )
    points_by_frame: dict[int, list[Sam2Point]] = {
        2: [{"x": 0.5, "y": 0.5, "label": 1, "timeTicks": 0}],
    }

    frames = sam2_service._run_sam2_propagation(source, points_by_frame)

    assert fake_predictor.propagate_calls == [(2, False), (2, True)]
    assert np.all(frames[2] == 255)  # Seeded from add_new_points_or_box output.
    assert np.all(frames[0] == 255)  # Reverse pass.
    assert np.all(frames[4] == 255)  # Forward pass.


def test_run_sam2_propagation_respects_frame_window(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakePredictor:
        def init_state(self, video_path: str) -> dict[str, str]:
            return {"video_path": video_path}

        def reset_state(self, _inference_state: object) -> None:
            return None

        def add_new_points_or_box(self, **kwargs):
            del kwargs
            return (None, [1], np.ones((1, 2, 2), dtype=np.float32))

        def propagate_in_video(
            self,
            _inference_state: object,
            start_frame_idx: int = 0,
            reverse: bool = False,
        ):
            del start_frame_idx
            if reverse:
                yield (0, [1], np.ones((1, 2, 2), dtype=np.float32))
                yield (1, [1], np.ones((1, 2, 2), dtype=np.float32))
            else:
                yield (3, [1], np.ones((1, 2, 2), dtype=np.float32))
                yield (4, [1], np.ones((1, 2, 2), dtype=np.float32))

    fake_predictor = FakePredictor()
    monkeypatch.setattr(sam2_service._runtime, "get_predictor", lambda: fake_predictor)

    source_path = tmp_path / "source.mp4"
    source_path.write_bytes(b"video")
    source = Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=source_path,
        width=2,
        height=2,
        fps=24.0,
        frame_count=5,
        duration_sec=5 / 24.0,
    )
    points_by_frame: dict[int, list[Sam2Point]] = {
        2: [{"x": 0.5, "y": 0.5, "label": 1, "timeTicks": 0}],
    }

    frames = sam2_service._run_sam2_propagation(
        source,
        points_by_frame,
        frame_window=(2, 3),
    )

    assert np.all(frames[2] == 255)
    assert np.all(frames[3] == 255)
    assert np.all(frames[0] == 0)
    assert np.all(frames[1] == 0)
    assert np.all(frames[4] == 0)


def test_run_sam2_propagation_maps_source_frames_for_windowed_sessions(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakePredictor:
        def __init__(self) -> None:
            self.add_calls: list[int] = []
            self.propagate_calls: list[tuple[int, bool, int | None]] = []

        def reset_state(self, _inference_state: object) -> None:
            return None

        def add_new_points_or_box(self, **kwargs):
            frame_idx = int(kwargs["frame_idx"])
            self.add_calls.append(frame_idx)
            return (None, [1], np.ones((1, 2, 2), dtype=np.float32))

        def propagate_in_video(
            self,
            _inference_state: object,
            start_frame_idx: int = 0,
            max_frame_num_to_track: int | None = None,
            reverse: bool = False,
        ):
            self.propagate_calls.append(
                (start_frame_idx, reverse, max_frame_num_to_track)
            )
            if reverse:
                yield (0, [1], np.ones((1, 2, 2), dtype=np.float32))
            else:
                yield (2, [1], np.ones((1, 2, 2), dtype=np.float32))

    fake_predictor = FakePredictor()
    monkeypatch.setattr(sam2_service._runtime, "get_predictor", lambda: fake_predictor)

    source_path = tmp_path / "source.mp4"
    source_path.write_bytes(b"video")
    source = Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=source_path,
        width=2,
        height=2,
        fps=24.0,
        frame_count=6,
        duration_sec=6 / 24.0,
    )

    session = types.SimpleNamespace(
        inference_state={"state": "ok"},
        frame_index_offset=2,
        frame_count=3,
    )
    monkeypatch.setattr(
        sam2_service,
        "_get_or_create_editor_session",
        lambda _source, _mask_id, frame_window=None: session,
    )

    points_by_frame: dict[int, list[Sam2Point]] = {
        3: [{"x": 0.5, "y": 0.5, "label": 1, "timeTicks": 0}],
    }

    frames = sam2_service._run_sam2_propagation(
        source,
        points_by_frame,
        mask_id="mask_1",
        frame_window=(2, 4),
    )

    # Source frame 3 maps to predictor frame 1 (offset +2).
    assert fake_predictor.add_calls == [1]
    assert fake_predictor.propagate_calls == [
        (1, False, 1),
        (1, True, 1),
    ]
    assert np.all(frames[2] == 255)
    assert np.all(frames[3] == 255)
    assert np.all(frames[4] == 255)


def test_run_sam2_propagation_uses_max_frame_num_to_track_when_supported(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakePredictor:
        def __init__(self) -> None:
            self.propagate_calls: list[tuple[int, bool, int | None]] = []

        def init_state(self, video_path: str) -> dict[str, str]:
            return {"video_path": video_path}

        def reset_state(self, _inference_state: object) -> None:
            return None

        def add_new_points_or_box(self, **kwargs):
            del kwargs
            return (None, [1], np.ones((1, 2, 2), dtype=np.float32))

        def propagate_in_video(
            self,
            _inference_state: object,
            start_frame_idx: int = 0,
            max_frame_num_to_track: int | None = None,
            reverse: bool = False,
        ):
            self.propagate_calls.append(
                (start_frame_idx, reverse, max_frame_num_to_track)
            )
            yield (start_frame_idx, [1], np.ones((1, 2, 2), dtype=np.float32))

    fake_predictor = FakePredictor()
    monkeypatch.setattr(sam2_service._runtime, "get_predictor", lambda: fake_predictor)

    source_path = tmp_path / "source.mp4"
    source_path.write_bytes(b"video")
    source = Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=source_path,
        width=2,
        height=2,
        fps=24.0,
        frame_count=8,
        duration_sec=8 / 24.0,
    )
    points_by_frame: dict[int, list[Sam2Point]] = {
        2: [{"x": 0.5, "y": 0.5, "label": 1, "timeTicks": 0}],
    }

    sam2_service._run_sam2_propagation(
        source,
        points_by_frame,
        frame_window=(1, 4),
    )

    assert fake_predictor.propagate_calls == [
        (2, False, 2),
        (2, True, 1),
    ]


def test_generate_mask_video_passes_visible_source_window_to_propagation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.mp4"
    source_path.write_bytes(b"video")
    source = Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=source_path,
        width=2,
        height=2,
        fps=24.0,
        frame_count=5,
        duration_sec=5 / 24.0,
    )

    captured_window: dict[str, tuple[int, int] | None] = {"value": None}

    def fake_run(
        _source: Sam2SourceMetadata,
        _points_by_frame: dict[int, list[Sam2Point]],
        mask_id: str | None = None,
        frame_window: tuple[int, int] | None = None,
    ) -> np.ndarray:
        del mask_id
        captured_window["value"] = frame_window
        return np.zeros((source.frame_count, source.height, source.width), dtype=np.uint8)

    monkeypatch.setattr(sam2_service, "get_source_metadata", lambda _source_id: source)
    monkeypatch.setattr(
        sam2_service,
        "_run_sam2_propagation",
        fake_run,
    )
    monkeypatch.setattr(
        sam2_service,
        "encode_binary_masks_to_transparent_webm",
        lambda _frames, _fps: b"webm",
    )

    generated = sam2_service.generate_mask_video(
        source_id="source_1",
        points=[{"x": 0.5, "y": 0.5, "label": 1, "timeTicks": 0}],
        ticks_per_second=96_000,
        mask_id="mask_1",
        visible_source_start_ticks=4_000,
        visible_source_duration_ticks=2_000,
    )

    assert generated.video_bytes == b"webm"
    assert captured_window["value"] == (1, 1)


def test_runtime_raises_when_cuda_is_requested_but_not_detected(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    checkpoint_path = tmp_path / "sam2.ckpt"
    config_path = tmp_path / "sam2.yaml"
    checkpoint_path.write_bytes(b"ckpt")
    config_path.write_text("model: sam2", encoding="utf-8")

    def fake_discover():
        return [{
            "name": "sam2.ckpt",
            "checkpoint_path": str(checkpoint_path),
            "config_path": config_path.name,
        }]

    monkeypatch.setattr(sam2_service, "discover_sam2_models", fake_discover)
    monkeypatch.setattr(sam2_service, "SAM2_DEVICE", "cuda")

    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = types.SimpleNamespace(is_available=lambda: False)  # type: ignore[attr-defined]
    fake_torch.load = lambda *args, **kwargs: {"checkpoint": "ok"}  # type: ignore[attr-defined]

    build_calls: list[str] = []

    def fake_builder(*args, **kwargs):
        del args
        device = str(kwargs.get("device", ""))
        build_calls.append(device)
        return {"predictor": "ok", "device": device}

    sam2_module = types.ModuleType("sam2")
    sam2_build_module = types.ModuleType("sam2.build_sam")
    sam2_build_module_any = cast(Any, sam2_build_module)
    sam2_module_any = cast(Any, sam2_module)
    sam2_build_module_any.build_sam2_video_predictor = fake_builder
    sam2_module_any.build_sam = sam2_build_module

    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "sam2", sam2_module)
    monkeypatch.setitem(sys.modules, "sam2.build_sam", sam2_build_module)

    runtime = sam2_service._Sam2PredictorRuntime()
    with pytest.raises(sam2_service.Sam2ConfigError) as exc_info:
        runtime.get_predictor()

    assert "torch.cuda.is_available() is false" in str(exc_info.value)
    assert build_calls == []


def test_runtime_applies_torch_load_weights_only_compat_for_builder(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    checkpoint_path = tmp_path / "sam2.ckpt"
    config_path = tmp_path / "sam2.yaml"
    checkpoint_path.write_bytes(b"ckpt")
    config_path.write_text("model: sam2", encoding="utf-8")

    def fake_discover():
        return [{
            "name": "sam2.ckpt",
            "checkpoint_path": str(checkpoint_path),
            "config_path": config_path.name,
        }]

    monkeypatch.setattr(sam2_service, "discover_sam2_models", fake_discover)
    monkeypatch.setattr(sam2_service, "SAM2_DEVICE", "cpu")

    captured_weights_only: list[object] = []

    def fake_torch_load(*args, **kwargs):
        del args
        captured_weights_only.append(kwargs.get("weights_only"))
        return {"checkpoint": "ok"}

    fake_torch = types.ModuleType("torch")
    fake_torch.load = fake_torch_load  # type: ignore[attr-defined]

    def fake_builder(*args, **kwargs):
        del args, kwargs
        import torch
        torch.load("unused.ckpt")
        return {"predictor": "ok"}

    sam2_module = types.ModuleType("sam2")
    sam2_build_module = types.ModuleType("sam2.build_sam")
    sam2_build_module_any = cast(Any, sam2_build_module)
    sam2_module_any = cast(Any, sam2_module)
    sam2_build_module_any.build_sam2_video_predictor = fake_builder
    sam2_module_any.build_sam = sam2_build_module

    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "sam2", sam2_module)
    monkeypatch.setitem(sys.modules, "sam2.build_sam", sam2_build_module)

    runtime = sam2_service._Sam2PredictorRuntime()
    predictor = runtime.get_predictor()

    assert predictor == {"predictor": "ok"}
    assert captured_weights_only == [False]


def test_runtime_does_not_fallback_to_cpu_when_cuda_is_detected(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    checkpoint_path = tmp_path / "sam2.ckpt"
    config_path = tmp_path / "sam2.yaml"
    checkpoint_path.write_bytes(b"ckpt")
    config_path.write_text("model: sam2", encoding="utf-8")

    def fake_discover():
        return [{
            "name": "sam2.ckpt",
            "checkpoint_path": str(checkpoint_path),
            "config_path": config_path.name,
        }]

    monkeypatch.setattr(sam2_service, "discover_sam2_models", fake_discover)
    monkeypatch.setattr(sam2_service, "SAM2_DEVICE", "auto")

    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = types.SimpleNamespace(is_available=lambda: True)  # type: ignore[attr-defined]
    fake_torch.load = lambda *args, **kwargs: {"checkpoint": "ok"}  # type: ignore[attr-defined]

    build_calls: list[str] = []

    def fake_builder(*args, **kwargs):
        del args
        device = str(kwargs.get("device", ""))
        build_calls.append(device)
        raise RuntimeError("CUDA init failure")

    sam2_module = types.ModuleType("sam2")
    sam2_build_module = types.ModuleType("sam2.build_sam")
    sam2_build_module_any = cast(Any, sam2_build_module)
    sam2_module_any = cast(Any, sam2_module)
    sam2_build_module_any.build_sam2_video_predictor = fake_builder
    sam2_module_any.build_sam = sam2_build_module

    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "sam2", sam2_module)
    monkeypatch.setitem(sys.modules, "sam2.build_sam", sam2_build_module)

    runtime = sam2_service._Sam2PredictorRuntime()
    with pytest.raises(sam2_service.Sam2ConfigError):
        runtime.get_predictor()

    assert build_calls == ["cuda"]


def test_runtime_applies_torch_load_compat_for_module_aliases(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    checkpoint_path = tmp_path / "sam2.ckpt"
    config_path = tmp_path / "sam2.yaml"
    checkpoint_path.write_bytes(b"ckpt")
    config_path.write_text("model: sam2", encoding="utf-8")

    def fake_discover():
        return [{
            "name": "sam2.ckpt",
            "checkpoint_path": str(checkpoint_path),
            "config_path": str(config_path)
        }]

    monkeypatch.setattr(sam2_service, "discover_sam2_models", fake_discover)
    monkeypatch.setattr(sam2_service, "SAM2_DEVICE", "cpu")

    captured_weights_only: list[object] = []

    def fake_torch_load(*args, **kwargs):
        del args
        captured_weights_only.append(kwargs.get("weights_only"))
        return {"checkpoint": "ok"}

    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = types.SimpleNamespace(is_available=lambda: False)  # type: ignore[attr-defined]
    fake_torch.load = fake_torch_load  # type: ignore[attr-defined]
    fake_torch.serialization = types.SimpleNamespace(load=fake_torch_load)  # type: ignore[attr-defined]

    sam2_module = types.ModuleType("sam2")
    sam2_build_module = types.ModuleType("sam2.build_sam")
    sam2_build_module_any = cast(Any, sam2_build_module)
    sam2_module_any = cast(Any, sam2_module)
    sam2_build_module_any.torch_load_alias = fake_torch_load

    def fake_builder(*args, **kwargs):
        del args, kwargs
        return {"predictor": sam2_build_module_any.torch_load_alias("unused.ckpt")}

    sam2_build_module_any.build_sam2_video_predictor = fake_builder
    sam2_module_any.build_sam = sam2_build_module

    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "sam2", sam2_module)
    monkeypatch.setitem(sys.modules, "sam2.build_sam", sam2_build_module)

    runtime = sam2_service._Sam2PredictorRuntime()
    predictor = runtime.get_predictor()

    assert predictor == {"predictor": {"checkpoint": "ok"}}
    assert captured_weights_only == [False]


def test_runtime_loads_safetensors_checkpoint_with_manual_state_dict_loading(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    checkpoint_path = tmp_path / "sam2_hiera_s.safetensors"
    config_path = tmp_path / "sam2_hiera_s.yaml"
    checkpoint_path.write_bytes(b"safetensors")
    config_path.write_text("model: sam2", encoding="utf-8")

    def fake_discover():
        return [{
            "name": checkpoint_path.name,
            "checkpoint_path": str(checkpoint_path),
            "config_path": str(config_path),
        }]

    monkeypatch.setattr(sam2_service, "discover_sam2_models", fake_discover)
    monkeypatch.setattr(sam2_service, "SAM2_DEVICE", "cpu")

    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = types.SimpleNamespace(is_available=lambda: False)  # type: ignore[attr-defined]

    def _unexpected_torch_load(*args, **kwargs):
        raise AssertionError("torch.load should not be used for .safetensors checkpoints")

    fake_torch.load = _unexpected_torch_load  # type: ignore[attr-defined]

    loaded_paths: list[str] = []

    def fake_load_file(path: str):
        loaded_paths.append(path)
        return {"model": {"w": "ok"}}

    fake_safetensors_module = types.ModuleType("safetensors")
    fake_safetensors_torch_module = types.ModuleType("safetensors.torch")
    fake_safetensors_torch_module_any = cast(Any, fake_safetensors_torch_module)
    fake_safetensors_module_any = cast(Any, fake_safetensors_module)
    fake_safetensors_torch_module_any.load_file = fake_load_file
    fake_safetensors_module_any.torch = fake_safetensors_torch_module

    class FakePredictor:
        def __init__(self) -> None:
            self.loaded_state_dict = None

        def load_state_dict(self, state_dict):
            self.loaded_state_dict = state_dict

    predictor_instance = FakePredictor()
    builder_ckpt_values: list[object] = []

    def fake_builder(*args, **kwargs):
        del args
        builder_ckpt_values.append(kwargs.get("ckpt_path"))
        return predictor_instance

    sam2_module = types.ModuleType("sam2")
    sam2_build_module = types.ModuleType("sam2.build_sam")
    sam2_build_module_any = cast(Any, sam2_build_module)
    sam2_module_any = cast(Any, sam2_module)
    sam2_build_module_any.build_sam2_video_predictor = fake_builder
    sam2_module_any.build_sam = sam2_build_module

    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "safetensors", fake_safetensors_module)
    monkeypatch.setitem(sys.modules, "safetensors.torch", fake_safetensors_torch_module)
    monkeypatch.setitem(sys.modules, "sam2", sam2_module)
    monkeypatch.setitem(sys.modules, "sam2.build_sam", sam2_build_module)

    runtime = sam2_service._Sam2PredictorRuntime()
    predictor = runtime.get_predictor()

    assert predictor is predictor_instance
    assert builder_ckpt_values == [None]
    assert loaded_paths == [str(checkpoint_path)]
    assert predictor_instance.loaded_state_dict == {"w": "ok"}


def test_initialize_inference_state_uses_prepared_video_for_non_mp4(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.mov"
    source_path.write_bytes(b"video")
    prepared_path = tmp_path / "source.mp4"
    prepared_path.write_bytes(b"prepared")

    source = Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=source_path,
        width=640,
        height=360,
        fps=30.0,
        frame_count=120,
        duration_sec=4.0,
    )

    init_calls: list[str] = []

    class FakePredictor:
        def init_state(self, video_path: str):
            init_calls.append(video_path)
            return {"video_path": video_path}

    monkeypatch.setattr(
        sam2_service,
        "_ensure_prepared_video",
        lambda _source, normalized_mp4: prepared_path,
    )

    (
        inference_state,
        used_path,
        frame_index_offset,
        frame_count,
    ) = sam2_service._initialize_inference_state(
        predictor=FakePredictor(),
        source=source,
    )

    assert inference_state == {"video_path": str(prepared_path)}
    assert used_path == prepared_path
    assert frame_index_offset == 0
    assert frame_count == source.frame_count
    assert init_calls == [str(prepared_path)]


def test_initialize_inference_state_falls_back_to_normalized_mp4_for_mp4_failures(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.mp4"
    source_path.write_bytes(b"video")
    prepared_path = tmp_path / "source_normalized.mp4"
    prepared_path.write_bytes(b"prepared")

    source = Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=source_path,
        width=640,
        height=360,
        fps=30.0,
        frame_count=120,
        duration_sec=4.0,
    )

    init_calls: list[str] = []

    class FakePredictor:
        def init_state(self, video_path: str):
            init_calls.append(video_path)
            if video_path == str(source_path):
                raise RuntimeError("primary init failed")
            return {"video_path": video_path}

    monkeypatch.setattr(
        sam2_service,
        "_ensure_prepared_video",
        lambda _source, normalized_mp4: prepared_path,
    )

    (
        inference_state,
        used_path,
        frame_index_offset,
        frame_count,
    ) = sam2_service._initialize_inference_state(
        predictor=FakePredictor(),
        source=source,
    )

    assert inference_state == {"video_path": str(prepared_path)}
    assert used_path == prepared_path
    assert frame_index_offset == 0
    assert frame_count == source.frame_count
    assert init_calls == [str(source_path), str(prepared_path)]


def test_editor_session_init_and_clear(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.mp4"
    source_path.write_bytes(b"video")
    source = Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=source_path,
        width=640,
        height=360,
        fps=30.0,
        frame_count=120,
        duration_sec=4.0,
    )

    class FakePredictor:
        def reset_state(self, _inference_state: object) -> None:
            return None

    fake_predictor = FakePredictor()

    monkeypatch.setattr(sam2_service, "get_source_metadata", lambda _source_id: source)
    monkeypatch.setattr(sam2_service._runtime, "get_predictor", lambda: fake_predictor)
    monkeypatch.setattr(
        sam2_service,
        "_initialize_inference_state",
        lambda predictor, source, frame_window=None: (
            {"inference": "state"},
            source.path,
            0,
            source.frame_count,
        ),
    )

    init_payload = sam2_service.init_editor_session("source_1", "mask_1")
    assert init_payload["sourceId"] == "source_1"
    assert init_payload["maskId"] == "mask_1"
    assert sam2_service._get_editor_session("source_1", "mask_1") is not None

    clear_payload = sam2_service.clear_editor_session("source_1", "mask_1")
    assert clear_payload == {
        "sourceId": "source_1",
        "maskId": "mask_1",
        "cleared": True,
    }
    assert sam2_service._get_editor_session("source_1", "mask_1") is None


def test_init_editor_session_uses_visible_source_range_window(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.mp4"
    source_path.write_bytes(b"video")
    source = Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=source_path,
        width=640,
        height=360,
        fps=30.0,
        frame_count=120,
        duration_sec=4.0,
    )

    class FakePredictor:
        def __init__(self) -> None:
            self.reset_calls = 0

        def reset_state(self, _inference_state: object) -> None:
            self.reset_calls += 1

    fake_predictor = FakePredictor()
    captured_window: dict[str, tuple[int, int] | None] = {"value": None}

    def fake_create_session(
        _source: Sam2SourceMetadata,
        _mask_id: str,
        frame_window: tuple[int, int] | None = None,
    ):
        captured_window["value"] = frame_window
        return types.SimpleNamespace(
            inference_state={"state": "ok"},
            frame_index_offset=0,
            frame_count=source.frame_count,
        )

    monkeypatch.setattr(sam2_service, "get_source_metadata", lambda _source_id: source)
    monkeypatch.setattr(sam2_service._runtime, "get_predictor", lambda: fake_predictor)
    monkeypatch.setattr(sam2_service, "_create_editor_session", fake_create_session)

    payload = sam2_service.init_editor_session(
        "source_1",
        "mask_1",
        ticks_per_second=96_000,
        visible_source_start_ticks=96_000,
        visible_source_duration_ticks=192_000,
    )

    assert captured_window["value"] == (30, 89)
    assert payload["frameWindowStartFrame"] == 30
    assert payload["frameWindowEndFrame"] == 89
    assert fake_predictor.reset_calls == 1


def test_initialize_inference_state_falls_back_to_jpeg_frames_directory(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.mov"
    source_path.write_bytes(b"video")
    prepared_video_path = tmp_path / "source.mp4"
    prepared_video_path.write_bytes(b"prepared")
    prepared_frames_path = tmp_path / "prepared_frames"
    prepared_frames_path.mkdir(parents=True, exist_ok=True)

    source = Sam2SourceMetadata(
        source_id="source_1",
        source_hash="source_1",
        path=source_path,
        width=640,
        height=360,
        fps=30.0,
        frame_count=120,
        duration_sec=4.0,
    )

    init_calls: list[str] = []

    class FakePredictor:
        def init_state(self, video_path: str):
            init_calls.append(video_path)
            if video_path == str(prepared_video_path):
                raise RuntimeError("Only JPEG frames are supported at this moment")
            if video_path == str(prepared_frames_path):
                return {"video_path": video_path}
            raise RuntimeError("unexpected path")

    monkeypatch.setattr(
        sam2_service,
        "_ensure_prepared_video",
        lambda _source, normalized_mp4: prepared_video_path,
    )
    captured_window: dict[str, tuple[int, int] | None] = {"value": None}

    def fake_prepare_jpegs(
        _source: Sam2SourceMetadata,
        _video_path: Path,
        frame_window: tuple[int, int] | None = None,
    ) -> Path:
        captured_window["value"] = frame_window
        return prepared_frames_path

    monkeypatch.setattr(sam2_service, "_ensure_prepared_jpeg_frames", fake_prepare_jpegs)

    (
        inference_state,
        used_path,
        frame_index_offset,
        frame_count,
    ) = sam2_service._initialize_inference_state(
        predictor=FakePredictor(),
        source=source,
        frame_window=(12, 23),
    )

    assert inference_state == {"video_path": str(prepared_frames_path)}
    assert used_path == prepared_frames_path
    assert frame_index_offset == 12
    assert frame_count == 12
    assert captured_window["value"] == (12, 23)
    assert init_calls == [str(prepared_video_path), str(prepared_frames_path)]
