import numpy as np
import pytest

from services.sam2 import sam2_distance
from services.sam2.sam2_distance import (
    MASK_DISTANCE_BAND_PX,
    MASK_DISTANCE_INSIDE_LEVEL,
    MASK_DISTANCE_LEVELS_PER_PIXEL,
    MASK_DISTANCE_ZERO_LEVEL,
    distance_frames_inside,
    logits_to_distance_frame,
)


def _decode(levels: np.ndarray) -> np.ndarray:
    return (MASK_DISTANCE_ZERO_LEVEL - levels.astype(np.float64)) / MASK_DISTANCE_LEVELS_PER_PIXEL


def _blobby_logits(height: int, width: int, seed: int = 3) -> np.ndarray:
    """A SAM2-shaped field: smooth low-resolution logits, bilinearly upsampled."""
    rng = np.random.default_rng(seed)
    coarse = rng.standard_normal((height // 8 + 2, width // 8 + 2)).astype(np.float32) * 3
    return sam2_distance._resize_field(coarse, (height, width))


def _brute_force_squared(field: np.ndarray) -> np.ndarray:
    ops = sam2_distance._Ops(field)
    points_x, points_y = sam2_distance._boundary_points(ops, field)
    grid_y, grid_x = np.mgrid[0 : field.shape[0], 0 : field.shape[1]].astype(np.float32)
    squared = (grid_x[..., None] - points_x) ** 2 + (grid_y[..., None] - points_y) ** 2
    return squared.min(axis=-1)


def test_straight_edge_distances_are_sub_pixel() -> None:
    columns = np.arange(96, dtype=np.float32)
    logits = np.tile(40.3 - columns, (24, 1))

    distance = _decode(logits_to_distance_frame(logits))[12]

    in_band = np.abs(columns - 40.3) < MASK_DISTANCE_BAND_PX - 1
    # One level is 1/8 px; rounding is at most half of that.
    assert np.abs(distance - (columns - 40.3))[in_band].max() <= 1 / 16 + 1e-6


def test_midpoint_cut_reproduces_the_logits_sign_exactly() -> None:
    logits = _blobby_logits(64, 80)

    levels = logits_to_distance_frame(logits)

    assert np.array_equal(distance_frames_inside(levels), logits > 0)
    assert np.array_equal(levels >= MASK_DISTANCE_INSIDE_LEVEL, logits > 0)


def test_far_pixels_saturate_the_band() -> None:
    logits = np.full((40, 40), -5.0, dtype=np.float32)
    logits[18:22, 18:22] = 5.0

    levels = logits_to_distance_frame(logits)

    assert levels[0, 0] == 0
    assert np.all(levels[18:22, 18:22] >= MASK_DISTANCE_INSIDE_LEVEL)
    assert np.array_equal(logits_to_distance_frame(np.ones((8, 8))), np.full((8, 8), 255))
    assert np.array_equal(logits_to_distance_frame(-np.ones((8, 8))), np.zeros((8, 8)))


def test_objects_merge_as_a_union() -> None:
    first = np.full((32, 32), -4.0, dtype=np.float32)
    second = first.copy()
    first[4:12, 4:12] = 4.0
    second[18:28, 16:30] = 4.0
    union = np.maximum(first, second)

    stacked = logits_to_distance_frame(np.stack([first, second])[:, None])
    listed = logits_to_distance_frame([first[None], second[None]])

    assert np.array_equal(stacked, logits_to_distance_frame(union))
    assert np.array_equal(listed, stacked)


def test_low_resolution_logits_are_resampled_to_the_requested_size() -> None:
    coarse = np.full((16, 16), -3.0, dtype=np.float32)
    coarse[4:12, 4:12] = 3.0

    levels = logits_to_distance_frame(coarse, (64, 64))

    assert levels.shape == (64, 64)
    # The 8 px coarse square becomes ~32 px: the centre is ~16 px deep.
    assert _decode(levels[32:33, 32:33])[0, 0] < -15
    assert levels[0, 0] == 0


def test_splat_is_exact_and_the_flood_agrees_within_the_band() -> None:
    field = _blobby_logits(48, 64)
    ops = sam2_distance._Ops(field)
    points_x, points_y = sam2_distance._boundary_points(ops, field)

    splat = np.sqrt(sam2_distance._nearest_squared_by_splat(ops, points_x, points_y, 48, 64))
    flood = np.sqrt(sam2_distance._nearest_squared_by_flood(ops, field))
    exact = np.sqrt(_brute_force_squared(field))

    in_band = exact <= MASK_DISTANCE_BAND_PX
    assert np.abs(splat - exact)[in_band].max() < 1e-4
    # The flood keeps one seed per pixel, so a crossing that is not its own
    # pixels' nearest is lost: many tiny errors, all well under a pixel.
    flood_error = np.abs(flood - exact)[in_band]
    assert np.sqrt(np.mean(flood_error**2)) < 0.03
    assert flood_error.max() < 0.25


def test_torch_matches_numpy() -> None:
    torch = pytest.importorskip("torch")
    logits = _blobby_logits(64, 96)

    reference = logits_to_distance_frame(logits)
    on_cpu = logits_to_distance_frame(torch.from_numpy(logits.copy())[None, None])

    # Same device class, same method: identical bytes.
    assert np.array_equal(on_cpu, reference)
    if torch.cuda.is_available():
        on_gpu = logits_to_distance_frame(torch.from_numpy(logits.copy()).cuda()[None, None])
        # The GPU splats exactly; the CPU floods. They agree to a level.
        assert np.abs(on_gpu.astype(int) - reference.astype(int)).max() <= 1
        assert np.array_equal(on_gpu >= MASK_DISTANCE_INSIDE_LEVEL, logits > 0)
