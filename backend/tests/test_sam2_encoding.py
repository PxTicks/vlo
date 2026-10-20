from io import BytesIO

import av
import numpy as np

from services.sam2.sam2_distance import (
    MASK_DISTANCE_INSIDE_LEVEL,
    MASK_DISTANCE_LEVELS_PER_PIXEL,
    MASK_DISTANCE_ZERO_LEVEL,
    logits_to_distance_frame,
)
from services.sam2.sam2_encoding import encode_mask_distance_fields_mp4


def _decode_first_frame(video_bytes: bytes) -> tuple[str, np.ndarray]:
    container = av.open(BytesIO(video_bytes), mode="r")
    try:
        stream = container.streams.video[0]
        frame = next(container.decode(video=0))
        return (stream.codec_context.pix_fmt or "", frame.to_ndarray(format="rgb24"))
    finally:
        container.close()


def _disc_logits(size: int, radius: float) -> np.ndarray:
    grid_y, grid_x = np.mgrid[0:size, 0:size].astype(np.float32)
    distance = np.hypot(grid_x - size / 2 + 0.3, grid_y - size / 2 - 0.2)
    return (radius - distance).astype(np.float32)


def test_encode_mask_distance_fields_mp4_writes_levels_to_luma_without_alpha() -> None:
    logits = _disc_logits(64, 18.4)
    frames = logits_to_distance_frame(logits)[None]

    encoded = encode_mask_distance_fields_mp4(frames, 24.0)
    pix_fmt, decoded = _decode_first_frame(encoded)

    assert "a" not in pix_fmt
    # Grey, not red: every channel carries the level.
    assert np.abs(decoded[..., 0].astype(int) - decoded[..., 2].astype(int)).max() <= 4
    recovered_inside = decoded[..., 0] >= MASK_DISTANCE_INSIDE_LEVEL
    mismatched = np.count_nonzero(recovered_inside != (logits > 0))
    # The codec may move the midpoint cut by a fraction of a pixel.
    perimeter = 2 * np.pi * 18.4
    assert mismatched <= 0.1 * perimeter


def test_encode_mask_distance_fields_mp4_keeps_sub_pixel_distances() -> None:
    logits = _disc_logits(96, 30.6)
    frames = logits_to_distance_frame(logits)[None]

    _, decoded = _decode_first_frame(encode_mask_distance_fields_mp4(frames, 24.0))
    distance = (MASK_DISTANCE_ZERO_LEVEL - decoded[..., 0].astype(np.float64)) / (
        MASK_DISTANCE_LEVELS_PER_PIXEL
    )
    true_distance = -logits.astype(np.float64)
    in_band = np.abs(true_distance) < 12
    error = np.abs(distance - true_distance)[in_band]

    assert np.sqrt(np.mean(error**2)) < 0.3


def test_encode_mask_distance_fields_mp4_uses_sparse_source_timestamps() -> None:
    frames = np.full((3, 16, 16), 255, dtype=np.uint8)

    encoded = encode_mask_distance_fields_mp4(
        frames,
        10.0,
        window_start_frame=4,
        source_frame_count=12,
    )
    container = av.open(BytesIO(encoded), mode="r")
    try:
        stream = container.streams.video[0]
        decoded = list(container.decode(video=0))
        timestamps = [round(float(frame.time), 6) for frame in decoded]
        level_means = [frame.to_ndarray(format="rgb24")[..., 0].mean() for frame in decoded]

        assert timestamps == [0.0, 0.4, 0.5, 0.6, 0.7, 1.1]
        # Frames outside the window are level 0: far outside the mask.
        assert level_means[0] < 32
        assert all(value > 200 for value in level_means[1:4])
        assert all(value < 32 for value in level_means[4:])
        assert decoded[1].key_frame
        assert decoded[4].key_frame
        assert stream.frames == 6
        assert float(stream.duration * stream.time_base) == 1.2
    finally:
        container.close()
