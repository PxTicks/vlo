"""Generate golden parity fixtures for the generation media-processing math.

The backend implementations under
``backend/services/gen_pipeline/processors/utils/`` are the source of truth;
this script captures their behaviour as JSON so both test suites can assert
against identical expectations:

- ``backend/tests/test_generation_processing_parity.py`` (guards backend drift)
- ``frontend/src/features/generation/processing/__tests__/parity.fixtures.test.ts``
  (guards the frontend ports)

Regenerate after intentionally changing the backend math:

    backend/.venv/bin/python3.13 scripts/generate_processing_parity_fixtures.py
"""

from __future__ import annotations

import json
import os
import random
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))

import numpy as np  # noqa: E402

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

FIXTURES_DIR = REPO_ROOT / "shared" / "fixtures" / "generation-processing"

ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "2.35:1", "5:4"]
RESOLUTIONS = [240, 480, 512, 640, 720, 768, 1080, 1088, 1288]


def build_parse_aspect_ratio_cases() -> list[dict]:
    inputs = [
        "16:9",
        "9/16",
        " 4 : 3 ",
        "1.85:1",
        "2.35/1",
        "16:9:extra",
        "16",
        "",
        "  ",
        "0:9",
        "16:0",
        "-16:9",
        "abc:def",
        "1e1:1",
    ]
    cases = []
    for value in inputs:
        parsed = _parse_aspect_ratio(value)
        cases.append(
            {
                "input": value,
                "expected": list(parsed) if parsed is not None else None,
            }
        )
    return cases


def build_short_edge_cases() -> list[dict]:
    cases = []
    for aspect_ratio in ASPECT_RATIOS:
        for resolution in RESOLUTIONS:
            result = derive_true_dimensions_from_short_edge(aspect_ratio, resolution)
            cases.append(
                {
                    "aspect_ratio": aspect_ratio,
                    "resolution": resolution,
                    "expected": list(result) if result is not None else None,
                }
            )
    return cases


def build_strided_cases(rng: random.Random) -> list[dict]:
    cases = []

    def add(target_width: int, target_height: int, stride: int, search_steps: int):
        result = find_best_strided_dimensions(
            target_width=target_width,
            target_height=target_height,
            stride=stride,
            search_steps=search_steps,
        )
        cases.append(
            {
                "target_width": target_width,
                "target_height": target_height,
                "stride": stride,
                "search_steps": search_steps,
                "expected": result,
            }
        )

    # Deliberate coverage: banker's-rounding ties (1288/16 = 80.5), tiny
    # targets, degenerate params, common project dimensions.
    for aspect_ratio in ASPECT_RATIOS:
        for resolution in RESOLUTIONS:
            dims = derive_true_dimensions_from_short_edge(aspect_ratio, resolution)
            if dims is None:
                continue
            for stride in (8, 16, 32, 64):
                for steps in (0, 1, 2):
                    add(dims[0], dims[1], stride, steps)

    add(1288, 724, 16, 2)
    add(1288, 1288, 16, 2)
    add(24, 8, 16, 2)
    add(10, 10, 16, 1)
    add(2, 2, 16, 0)
    add(0, 100, 16, 2)
    add(100, 0, 16, 2)
    add(100, 100, 0, 2)
    add(100, 100, 16, -1)

    for _ in range(150):
        add(
            rng.randint(1, 4096),
            rng.randint(1, 4096),
            rng.choice([8, 16, 32, 64]),
            rng.randint(0, 3),
        )
    return cases


def build_union_bounds_cases(rng: random.Random) -> list[dict]:
    def rand_bounds():
        x1 = rng.randint(0, 1900)
        y1 = rng.randint(0, 1060)
        return (x1, y1, rng.randint(x1 + 1, 1920), rng.randint(y1 + 1, 1080))

    cases = [
        {"a": None, "b": None},
        {"a": [10, 20, 30, 40], "b": None},
        {"a": None, "b": [10, 20, 30, 40]},
        {"a": [10, 20, 30, 40], "b": [5, 25, 35, 50]},
    ]
    for _ in range(30):
        cases.append({"a": list(rand_bounds()), "b": list(rand_bounds())})

    for case in cases:
        a = tuple(case["a"]) if case["a"] is not None else None
        b = tuple(case["b"]) if case["b"] is not None else None
        result = union_bounds(a, b)
        case["expected"] = list(result) if result is not None else None
    return cases


def build_force_aspect_ratio_cases(rng: random.Random) -> list[dict]:
    cases = []

    def add(bbox, target_ar):
        result = force_aspect_ratio(tuple(bbox), target_ar)
        cases.append(
            {
                "bbox": list(bbox),
                "target_ar": target_ar,
                "expected": list(result),
            }
        )

    add((0, 0, 160, 90), 16 / 9)
    add((0, 0, 200, 50), 1.0)
    add((0, 0, 50, 200), 1.0)
    add((100, 100, 200, 150), 16 / 9)
    add((100, 100, 100, 150), 16 / 9)  # zero width
    add((100, 100, 200, 100), 16 / 9)  # zero height

    for _ in range(60):
        x1 = rng.randint(0, 1800)
        y1 = rng.randint(0, 1000)
        bbox = (x1, y1, rng.randint(x1 + 1, 1920), rng.randint(y1 + 1, 1080))
        add(bbox, rng.choice([16 / 9, 9 / 16, 1.0, 4 / 3, 21 / 9, 2.35]))
    return cases


def build_crop_region_cases(rng: random.Random) -> list[dict]:
    cases = []

    def add(bbox, dilation, container_w, container_h, target_ar):
        result = compute_crop_region(
            tuple(bbox), dilation, container_w, container_h, target_ar
        )
        cases.append(
            {
                "bbox": list(bbox),
                "dilation": dilation,
                "container_w": container_w,
                "container_h": container_h,
                "target_ar": target_ar,
                "expected": list(result),
            }
        )

    add((100.0, 100.0, 300.0, 212.5), 0.0, 1920, 1080, 16 / 9)
    add((100.0, 100.0, 300.0, 212.5), 0.2, 1920, 1080, 16 / 9)
    add((0.0, 0.0, 1900.0, 1068.75), 0.5, 1920, 1080, 16 / 9)
    add((0.0, 100.0, 100.0, 156.25), 0.1, 1920, 1080, 16 / 9)
    add((100.0, 1000.0, 300.0, 1080.0), 0.1, 1920, 1080, 16 / 9)
    add((50.5, 50.5, 151.5, 107.3), 0.1, 1920, 1080, 16 / 9)
    # Odd containers exercise the min(crop, container) parity path.
    add((10.0, 10.0, 100.0, 60.625), 0.3, 1919, 1079, 16 / 9)

    for _ in range(120):
        container_w, container_h, target_ar = rng.choice(
            [
                (1920, 1080, 16 / 9),
                (1280, 720, 16 / 9),
                (608, 1080, 608 / 1080),
                (1080, 1080, 1.0),
                (1919, 1079, 1919 / 1079),
            ]
        )
        x1 = rng.uniform(0, container_w - 2)
        y1 = rng.uniform(0, container_h - 2)
        bbox = (
            x1,
            y1,
            rng.uniform(x1 + 1, container_w),
            rng.uniform(y1 + 1, container_h),
        )
        ar_box = force_aspect_ratio(
            (round(bbox[0]), round(bbox[1]), round(bbox[2]), round(bbox[3])),
            target_ar,
        )
        add(ar_box, rng.choice([0.0, 0.05, 0.1, 0.25, 0.5]), container_w, container_h, target_ar)
    return cases


def build_mask_crop_cases(rng: random.Random) -> list[dict]:
    cases = []

    def add(bounds, container_w, container_h, target_ar, dilation):
        result = compute_mask_crop(
            tuple(bounds) if bounds is not None else None,
            container_w,
            container_h,
            target_ar,
            dilation,
        )
        cases.append(
            {
                "bounds": list(bounds) if bounds is not None else None,
                "container_w": container_w,
                "container_h": container_h,
                "target_ar": target_ar,
                "dilation": dilation,
                "expected": list(result) if result is not None else None,
            }
        )

    add(None, 1920, 1080, 16 / 9, 0.1)
    add((0, 0, 1920, 1080), 1920, 1080, 16 / 9, 0.0)
    add((400, 300, 600, 500), 1920, 1080, 16 / 9, 0.1)
    add((100, 200, 200, 400), 608, 1080, 9 / 16, 0.1)
    add((0, 0, 2, 2), 1920, 1080, 16 / 9, 0.1)
    add((1918, 1078, 1920, 1080), 1920, 1080, 16 / 9, 0.1)

    for _ in range(150):
        container_w, container_h = rng.choice(
            [(1920, 1080), (1280, 720), (608, 1080), (1080, 1080), (854, 480)]
        )
        target_ar = container_w / container_h
        x1 = rng.randint(0, container_w - 2)
        y1 = rng.randint(0, container_h - 2)
        bounds = (
            x1,
            y1,
            rng.randint(x1 + 1, container_w),
            rng.randint(y1 + 1, container_h),
        )
        add(bounds, container_w, container_h, target_ar, rng.choice([0.0, 0.1, 0.3]))
    return cases


def build_frame_bounds_cases() -> list[dict]:
    specs = [
        {"width": 200, "height": 100, "rects": [], "threshold": 13},
        {
            "width": 200,
            "height": 100,
            "rects": [{"x1": 80, "y1": 50, "x2": 81, "y2": 51, "value": 255}],
            "threshold": 13,
        },
        {
            "width": 200,
            "height": 100,
            "rects": [{"x1": 40, "y1": 10, "x2": 90, "y2": 30, "value": 255}],
            "threshold": 13,
        },
        # Threshold is strictly-greater-than: value == threshold is excluded.
        {
            "width": 200,
            "height": 100,
            "rects": [
                {"x1": 10, "y1": 10, "x2": 11, "y2": 11, "value": 32},
                {"x1": 80, "y1": 50, "x2": 81, "y2": 51, "value": 33},
            ],
            "threshold": 32,
        },
        {
            "width": 200,
            "height": 100,
            "rects": [
                {"x1": 10, "y1": 5, "x2": 11, "y2": 6, "value": 255},
                {"x1": 180, "y1": 90, "x2": 181, "y2": 91, "value": 255},
            ],
            "threshold": 13,
        },
        {
            "width": 64,
            "height": 64,
            "rects": [{"x1": 0, "y1": 0, "x2": 64, "y2": 64, "value": 200}],
            "threshold": 32,
        },
    ]
    cases = []
    for spec in specs:
        frame = np.zeros((spec["height"], spec["width"]), dtype=np.uint8)
        for rect in spec["rects"]:
            frame[rect["y1"] : rect["y2"], rect["x1"] : rect["x2"]] = rect["value"]
        result = get_mask_bounds_from_frame(frame, threshold=spec["threshold"])
        cases.append(
            {**spec, "expected": list(result) if result is not None else None}
        )
    return cases


def main() -> None:
    rng = random.Random(20260706)
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

    aspect_ratio_fixture = {
        "description": (
            "Golden outputs of the backend aspect-ratio processing math. "
            "Generated by scripts/generate_processing_parity_fixtures.py — do not edit by hand."
        ),
        "parse_aspect_ratio": build_parse_aspect_ratio_cases(),
        "derive_true_dimensions_from_short_edge": build_short_edge_cases(),
        "find_best_strided_dimensions": build_strided_cases(rng),
    }
    mask_crop_fixture = {
        "description": (
            "Golden outputs of the backend mask-crop bounding-box math. "
            "Generated by scripts/generate_processing_parity_fixtures.py — do not edit by hand."
        ),
        "union_bounds": build_union_bounds_cases(rng),
        "force_aspect_ratio": build_force_aspect_ratio_cases(rng),
        "compute_crop_region": build_crop_region_cases(rng),
        "compute_mask_crop": build_mask_crop_cases(rng),
        "get_mask_bounds_from_frame": build_frame_bounds_cases(),
    }

    for name, fixture in (
        ("aspect-ratio-cases.json", aspect_ratio_fixture),
        ("mask-crop-cases.json", mask_crop_fixture),
    ):
        path = FIXTURES_DIR / name
        with path.open("w", encoding="utf-8") as handle:
            json.dump(fixture, handle, indent=1)
            handle.write("\n")
        print(f"wrote {path.relative_to(REPO_ROOT)} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
