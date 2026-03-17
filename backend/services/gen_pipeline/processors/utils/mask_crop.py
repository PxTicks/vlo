"""Bounding-box math for mask-aware cropping.

Given per-frame mask data, computes the tightest union bounding box,
expands it to a target aspect ratio, applies dilation (padding),
and clamps/shifts to stay within the container.
"""

from __future__ import annotations

import math

import numpy as np


# ---------------------------------------------------------------------------
# Per-frame bounds
# ---------------------------------------------------------------------------


def get_mask_bounds_from_frame(
    frame: np.ndarray,
    threshold: int = 13,
) -> tuple[int, int, int, int] | None:
    """Return (x1, y1, x2, y2) of non-zero mask pixels, or *None* if empty.

    *frame* is a 2-D array (H, W) — typically the alpha channel of an RGBA
    frame.  Pixels whose value exceeds *threshold* (~0.05 * 255) are
    considered mask-positive.
    """
    mask = frame > threshold
    if not mask.any():
        return None

    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)
    y_indices = np.nonzero(rows)[0]
    x_indices = np.nonzero(cols)[0]

    y1 = int(y_indices[0])
    y2 = int(y_indices[-1]) + 1
    x1 = int(x_indices[0])
    x2 = int(x_indices[-1]) + 1

    return x1, y1, x2, y2


# ---------------------------------------------------------------------------
# Union
# ---------------------------------------------------------------------------


def union_bounds(
    a: tuple[int, int, int, int] | None,
    b: tuple[int, int, int, int] | None,
) -> tuple[int, int, int, int] | None:
    """Return the tightest box enclosing both *a* and *b*."""
    if a is None:
        return b
    if b is None:
        return a
    return (
        min(a[0], b[0]),
        min(a[1], b[1]),
        max(a[2], b[2]),
        max(a[3], b[3]),
    )


# ---------------------------------------------------------------------------
# Aspect-ratio forcing
# ---------------------------------------------------------------------------


def force_aspect_ratio(
    bbox: tuple[int, int, int, int],
    target_ar: float,
) -> tuple[float, float, float, float]:
    """Expand *bbox* symmetrically so its aspect ratio matches *target_ar*.

    *target_ar* is width / height.  The shorter dimension is grown outward
    from the centre of the original box.

    Returns floating-point coordinates (x1, y1, x2, y2).
    """
    x1, y1, x2, y2 = bbox
    w = x2 - x1
    h = y2 - y1
    if h == 0 or w == 0:
        return float(x1), float(y1), float(x2), float(y2)

    current_ar = w / h
    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0

    if current_ar > target_ar:
        # Too wide → grow height
        new_w = float(w)
        new_h = w / target_ar
    else:
        # Too tall → grow width
        new_w = h * target_ar
        new_h = float(h)

    return (
        cx - new_w / 2.0,
        cy - new_h / 2.0,
        cx + new_w / 2.0,
        cy + new_h / 2.0,
    )


# ---------------------------------------------------------------------------
# Dilation + clamping
# ---------------------------------------------------------------------------


def _round_even(value: float) -> int:
    """Round to nearest even integer (codec-friendly)."""
    return int(math.floor(value / 2.0 + 0.5)) * 2


def compute_crop_region(
    bbox: tuple[float, float, float, float],
    dilation: float,
    container_w: int,
    container_h: int,
    target_ar: float,
) -> tuple[int, int, int, int]:
    """Apply dilation, cap at container, shift to fit, return even-int coords.

    *bbox* is (x1, y1, x2, y2) in float coordinates (output of
    :func:`force_aspect_ratio`).  *dilation* is a fraction (e.g. 0.1 = 10 %
    padding on each side).

    Because the box has already been forced to *target_ar* and the container
    shares that AR, a single-dimension cap suffices.
    """
    x1, y1, x2, y2 = bbox
    w = x2 - x1
    h = y2 - y1
    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0

    new_w = w * (1.0 + dilation)
    new_h = h * (1.0 + dilation)

    # Cap at container (AR matches, so capping one dimension suffices).
    if new_w > container_w or new_h > container_h:
        new_w = float(container_w)
        new_h = float(container_h)

    # Re-derive from centre, then round to even integers.
    fx1 = cx - new_w / 2.0
    fy1 = cy - new_h / 2.0
    fx2 = cx + new_w / 2.0
    fy2 = cy + new_h / 2.0

    # Ensure dimensions are even.
    crop_w = _round_even(fx2 - fx1)
    crop_h = _round_even(fy2 - fy1)

    # Minimum 2×2.
    crop_w = max(2, min(crop_w, container_w))
    crop_h = max(2, min(crop_h, container_h))

    # Re-derive from centre with even dimensions.
    fx1 = cx - crop_w / 2.0
    fy1 = cy - crop_h / 2.0

    # Shift to stay within container bounds.
    if fx1 < 0:
        fx1 = 0.0
    elif fx1 + crop_w > container_w:
        fx1 = float(container_w - crop_w)

    if fy1 < 0:
        fy1 = 0.0
    elif fy1 + crop_h > container_h:
        fy1 = float(container_h - crop_h)

    ix1 = int(round(fx1))
    iy1 = int(round(fy1))

    return ix1, iy1, ix1 + crop_w, iy1 + crop_h


# ---------------------------------------------------------------------------
# High-level: full pipeline from accumulated frame bounds
# ---------------------------------------------------------------------------


def compute_mask_crop(
    accumulated_bounds: tuple[int, int, int, int] | None,
    container_w: int,
    container_h: int,
    target_ar: float,
    dilation: float = 0.1,
) -> tuple[int, int, int, int] | None:
    """End-to-end: union bbox → force AR → dilate → crop region.

    Returns ``(x1, y1, x2, y2)`` with even-integer dimensions, or *None*
    if the mask is empty everywhere.
    """
    if accumulated_bounds is None:
        return None

    ar_box = force_aspect_ratio(accumulated_bounds, target_ar)
    crop = compute_crop_region(ar_box, dilation, container_w, container_h, target_ar)

    # If the crop covers the whole container, skip — no benefit.
    cx1, cy1, cx2, cy2 = crop
    if cx1 == 0 and cy1 == 0 and cx2 >= container_w and cy2 >= container_h:
        return None

    return crop
