import os
import sys

import numpy as np
import pytest

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.gen_pipeline.processors.utils.mask_crop import (  # noqa: E402
    compute_crop_region,
    compute_mask_crop,
    force_aspect_ratio,
    get_mask_bounds_from_frame,
    union_bounds,
)


# ---------------------------------------------------------------------------
# get_mask_bounds_from_frame
# ---------------------------------------------------------------------------


class TestGetMaskBoundsFromFrame:
    def test_empty_frame_returns_none(self):
        frame = np.zeros((100, 200), dtype=np.uint8)
        assert get_mask_bounds_from_frame(frame) is None

    def test_single_pixel(self):
        frame = np.zeros((100, 200), dtype=np.uint8)
        frame[50, 80] = 255
        result = get_mask_bounds_from_frame(frame)
        assert result == (80, 50, 81, 51)

    def test_rectangle_region(self):
        frame = np.zeros((100, 200), dtype=np.uint8)
        frame[10:30, 40:90] = 255
        result = get_mask_bounds_from_frame(frame)
        assert result == (40, 10, 90, 30)

    def test_threshold_filtering(self):
        frame = np.zeros((100, 200), dtype=np.uint8)
        # Below threshold — should be ignored
        frame[10, 10] = 10
        # Above threshold
        frame[50, 80] = 20
        result = get_mask_bounds_from_frame(frame, threshold=13)
        assert result == (80, 50, 81, 51)

    def test_scattered_pixels(self):
        frame = np.zeros((100, 200), dtype=np.uint8)
        frame[5, 10] = 255
        frame[90, 180] = 255
        result = get_mask_bounds_from_frame(frame)
        assert result == (10, 5, 181, 91)


# ---------------------------------------------------------------------------
# union_bounds
# ---------------------------------------------------------------------------


class TestUnionBounds:
    def test_both_none(self):
        assert union_bounds(None, None) is None

    def test_a_none(self):
        b = (10, 20, 30, 40)
        assert union_bounds(None, b) == b

    def test_b_none(self):
        a = (10, 20, 30, 40)
        assert union_bounds(a, None) == a

    def test_union(self):
        a = (10, 20, 30, 40)
        b = (5, 25, 35, 50)
        assert union_bounds(a, b) == (5, 20, 35, 50)


# ---------------------------------------------------------------------------
# force_aspect_ratio
# ---------------------------------------------------------------------------


class TestForceAspectRatio:
    def test_already_matching(self):
        # 16:9 box with 16:9 target
        bbox = (0, 0, 160, 90)
        result = force_aspect_ratio(bbox, 16 / 9)
        x1, y1, x2, y2 = result
        w, h = x2 - x1, y2 - y1
        assert abs(w / h - 16 / 9) < 0.01

    def test_too_wide_grows_height(self):
        # Very wide box, 1:1 target
        bbox = (0, 0, 200, 50)
        result = force_aspect_ratio(bbox, 1.0)
        x1, y1, x2, y2 = result
        w, h = x2 - x1, y2 - y1
        assert abs(w - 200) < 0.01
        assert abs(h - 200) < 0.01

    def test_too_tall_grows_width(self):
        # Very tall box, 1:1 target
        bbox = (0, 0, 50, 200)
        result = force_aspect_ratio(bbox, 1.0)
        x1, y1, x2, y2 = result
        w, h = x2 - x1, y2 - y1
        assert abs(w - 200) < 0.01
        assert abs(h - 200) < 0.01

    def test_preserves_center(self):
        bbox = (100, 100, 200, 150)
        result = force_aspect_ratio(bbox, 16 / 9)
        x1, y1, x2, y2 = result
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2
        assert abs(cx - 150) < 0.01
        assert abs(cy - 125) < 0.01


# ---------------------------------------------------------------------------
# compute_crop_region
# ---------------------------------------------------------------------------


class TestComputeCropRegion:
    def test_basic_crop(self):
        # Small box in a 1920x1080 container, 16:9 AR
        bbox = (100.0, 100.0, 300.0, 212.5)  # already 16:9
        crop = compute_crop_region(bbox, 0.0, 1920, 1080, 16 / 9)
        x1, y1, x2, y2 = crop
        w, h = x2 - x1, y2 - y1
        assert w % 2 == 0
        assert h % 2 == 0
        assert x1 >= 0 and y1 >= 0
        assert x2 <= 1920 and y2 <= 1080

    def test_dilation_increases_size(self):
        bbox = (100.0, 100.0, 300.0, 212.5)
        crop_no_dilation = compute_crop_region(bbox, 0.0, 1920, 1080, 16 / 9)
        crop_with_dilation = compute_crop_region(bbox, 0.2, 1920, 1080, 16 / 9)
        w0 = crop_no_dilation[2] - crop_no_dilation[0]
        w1 = crop_with_dilation[2] - crop_with_dilation[0]
        assert w1 > w0

    def test_capped_at_container(self):
        # Large box that after dilation exceeds container
        bbox = (0.0, 0.0, 1900.0, 1068.75)  # nearly full 16:9
        crop = compute_crop_region(bbox, 0.5, 1920, 1080, 16 / 9)
        x1, y1, x2, y2 = crop
        assert x2 - x1 <= 1920
        assert y2 - y1 <= 1080

    def test_shift_left_edge(self):
        # Box near left edge that would go negative
        bbox = (0.0, 100.0, 100.0, 156.25)
        crop = compute_crop_region(bbox, 0.1, 1920, 1080, 16 / 9)
        assert crop[0] >= 0

    def test_shift_bottom_edge(self):
        # Box near bottom edge
        bbox = (100.0, 1000.0, 300.0, 1080.0)
        crop = compute_crop_region(bbox, 0.1, 1920, 1080, 16 / 9)
        assert crop[3] <= 1080

    def test_even_dimensions(self):
        bbox = (50.5, 50.5, 151.5, 107.3)
        crop = compute_crop_region(bbox, 0.1, 1920, 1080, 16 / 9)
        w = crop[2] - crop[0]
        h = crop[3] - crop[1]
        assert w % 2 == 0
        assert h % 2 == 0


# ---------------------------------------------------------------------------
# compute_mask_crop (end-to-end)
# ---------------------------------------------------------------------------


class TestComputeMaskCrop:
    def test_none_bounds_returns_none(self):
        assert compute_mask_crop(None, 1920, 1080, 16 / 9) is None

    def test_full_container_returns_none(self):
        # Bounds covering nearly the whole container → crop == container → skip
        result = compute_mask_crop((0, 0, 1920, 1080), 1920, 1080, 16 / 9, 0.0)
        assert result is None

    def test_small_region_returns_crop(self):
        result = compute_mask_crop((400, 300, 600, 500), 1920, 1080, 16 / 9, 0.1)
        assert result is not None
        x1, y1, x2, y2 = result
        assert x1 >= 0 and y1 >= 0
        assert x2 <= 1920 and y2 <= 1080
        w, h = x2 - x1, y2 - y1
        assert w % 2 == 0
        assert h % 2 == 0
        # Should contain the original bounds
        assert x1 <= 400 and y1 <= 300
        assert x2 >= 600 and y2 >= 500

    def test_portrait_aspect_ratio(self):
        # 9:16 container (e.g. 608x1080)
        result = compute_mask_crop(
            (100, 200, 200, 400), 608, 1080, 9 / 16, 0.1
        )
        assert result is not None
        x1, y1, x2, y2 = result
        assert x2 <= 608 and y2 <= 1080
