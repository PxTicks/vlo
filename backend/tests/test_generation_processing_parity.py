"""Golden-fixture guard for the generation media-processing math.

The fixtures under ``shared/fixtures/generation-processing/`` were generated
from these backend implementations (``scripts/generate_processing_parity_fixtures.py``)
and are also asserted against the frontend ports in
``frontend/src/features/generation/processing/__tests__/parity.fixtures.test.ts``.
If a backend change breaks this test, either revert the behaviour change or
regenerate the fixtures — and expect the frontend parity suite to flag the
frontend port for the same update.
"""

import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.gen_pipeline.processors.utils.aspect_ratio_processing import (  # noqa: E402
    _parse_aspect_ratio,
    derive_true_dimensions_from_short_edge,
    find_best_strided_dimensions,
)
from services.gen_pipeline.processors.utils.mask_crop import (  # noqa: E402
    compute_crop_region,
    compute_mask_crop,
    force_aspect_ratio,
    get_mask_bounds_from_frame,
    union_bounds,
)

FIXTURES_DIR = (
    Path(__file__).resolve().parents[2] / "shared" / "fixtures" / "generation-processing"
)


def _load(name: str) -> dict:
    with (FIXTURES_DIR / name).open(encoding="utf-8") as handle:
        return json.load(handle)


@pytest.fixture(scope="module")
def aspect_ratio_fixture() -> dict:
    return _load("aspect-ratio-cases.json")


@pytest.fixture(scope="module")
def mask_crop_fixture() -> dict:
    return _load("mask-crop-cases.json")


def _as_tuple(value):
    return tuple(value) if value is not None else None


class TestAspectRatioParity:
    def test_parse_aspect_ratio(self, aspect_ratio_fixture):
        for case in aspect_ratio_fixture["parse_aspect_ratio"]:
            assert _parse_aspect_ratio(case["input"]) == _as_tuple(
                case["expected"]
            ), case

    def test_derive_true_dimensions_from_short_edge(self, aspect_ratio_fixture):
        for case in aspect_ratio_fixture["derive_true_dimensions_from_short_edge"]:
            result = derive_true_dimensions_from_short_edge(
                case["aspect_ratio"], case["resolution"]
            )
            assert result == _as_tuple(case["expected"]), case

    def test_find_best_strided_dimensions(self, aspect_ratio_fixture):
        for case in aspect_ratio_fixture["find_best_strided_dimensions"]:
            result = find_best_strided_dimensions(
                target_width=case["target_width"],
                target_height=case["target_height"],
                stride=case["stride"],
                search_steps=case["search_steps"],
            )
            assert result == case["expected"], case


class TestMaskCropParity:
    def test_union_bounds(self, mask_crop_fixture):
        for case in mask_crop_fixture["union_bounds"]:
            result = union_bounds(_as_tuple(case["a"]), _as_tuple(case["b"]))
            assert result == _as_tuple(case["expected"]), case

    def test_force_aspect_ratio(self, mask_crop_fixture):
        for case in mask_crop_fixture["force_aspect_ratio"]:
            result = force_aspect_ratio(tuple(case["bbox"]), case["target_ar"])
            assert result == _as_tuple(case["expected"]), case

    def test_compute_crop_region(self, mask_crop_fixture):
        for case in mask_crop_fixture["compute_crop_region"]:
            result = compute_crop_region(
                tuple(case["bbox"]),
                case["dilation"],
                case["container_w"],
                case["container_h"],
                case["target_ar"],
            )
            assert result == _as_tuple(case["expected"]), case

    def test_compute_mask_crop(self, mask_crop_fixture):
        for case in mask_crop_fixture["compute_mask_crop"]:
            result = compute_mask_crop(
                _as_tuple(case["bounds"]),
                case["container_w"],
                case["container_h"],
                case["target_ar"],
                case["dilation"],
            )
            assert result == _as_tuple(case["expected"]), case

    def test_get_mask_bounds_from_frame(self, mask_crop_fixture):
        for case in mask_crop_fixture["get_mask_bounds_from_frame"]:
            frame = np.zeros((case["height"], case["width"]), dtype=np.uint8)
            for rect in case["rects"]:
                frame[rect["y1"] : rect["y2"], rect["x1"] : rect["x2"]] = rect["value"]
            result = get_mask_bounds_from_frame(frame, threshold=case["threshold"])
            assert result == _as_tuple(case["expected"]), case
