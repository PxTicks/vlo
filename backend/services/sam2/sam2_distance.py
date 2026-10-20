"""Signed distance bands for SAM2 mask assets (docs/mask-distance-field-plan.md).

SAM2 predicts a smooth logit field whose zero set is the mask edge, known to
well under a pixel. Thresholding it to a binary video throws that position
away. Instead each frame stores a truncated signed distance to the zero set:

    v = clamp(round(127.5 - 8 * d), 0, 255)

with d in source pixels, negative inside: a +-16 px band at 1/8 px per level.
v >= 128 exactly where the logits are positive, so cutting at the midpoint
recovers SAM2's own binary mask.

The distances are computed on whatever device the logits live on (SAM2's
torch device in production), or with numpy for plain arrays. Both run the
same algorithm through `_Ops`.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

import numpy as np

MASK_DISTANCE_ENCODING = "tsdf8_k8"
MASK_BINARY_ENCODING = "binary"
MASK_DISTANCE_LEVELS_PER_PIXEL = 8.0
MASK_DISTANCE_ZERO_LEVEL = 127.5
# Levels at or above this are inside the mask.
MASK_DISTANCE_INSIDE_LEVEL = 128
MASK_DISTANCE_BAND_PX = MASK_DISTANCE_ZERO_LEVEL / MASK_DISTANCE_LEVELS_PER_PIXEL

# Every pixel this close to a boundary point gets an exact distance; anything
# farther saturates the band anyway.
_SPLAT_RADIUS = int(math.ceil(MASK_DISTANCE_BAND_PX))
# Bounds the (points x offsets) working set per batch.
_SPLAT_BATCH_ELEMENTS = 1 << 22
# The exact splat beats the cropped flood only on CUDA and only for ordinary
# boundary lengths (1080p, RTX 5090 laptop: 4.6 vs 5.5 ms at 12 writes per
# pixel, 17.9 vs 7.8 ms at 44). On the CPU the flood always won (135 vs 225 ms
# for an ordinary mask), so the CPU and numpy paths always flood.
_MAX_CUDA_SPLAT_WRITES_PER_PIXEL = 16
# Bounded jump flood ("JFA+1") covering the band: halve from 16, then repeat
# the unit step to repair the flood's rare wrong-seed picks.
_FLOOD_STEPS = (16, 8, 4, 2, 1, 1)
_FAR = 1.0e9


def _is_torch_tensor(value: Any) -> bool:
    return hasattr(value, "detach") and hasattr(value, "device")


class _Ops:
    """The handful of array operations the algorithm needs, for one library."""

    def __init__(self, like: Any) -> None:
        self.torch = None
        if _is_torch_tensor(like):
            import torch  # type: ignore

            self.torch = torch
            self.device = like.device

    @property
    def is_cuda(self) -> bool:
        return self.torch is not None and self.device.type == "cuda"

    def full(self, shape: int | tuple[int, ...], value: float) -> Any:
        shape = (shape,) if isinstance(shape, int) else shape
        if self.torch is not None:
            return self.torch.full(shape, value, dtype=self.torch.float32, device=self.device)
        return np.full(shape, value, dtype=np.float32)

    def grid(self, height: int, width: int) -> tuple[Any, Any]:
        if self.torch is not None:
            ys = self.torch.arange(height, dtype=self.torch.float32, device=self.device)
            xs = self.torch.arange(width, dtype=self.torch.float32, device=self.device)
            grid_y, grid_x = self.torch.meshgrid(ys, xs, indexing="ij")
            return grid_y, grid_x
        grid_y, grid_x = np.mgrid[0:height, 0:width]
        return grid_y.astype(np.float32), grid_x.astype(np.float32)

    def copy(self, value: Any) -> Any:
        return value.clone() if self.torch is not None else value.copy()

    def pad(self, value: Any, width: int, fill: float) -> Any:
        if self.torch is not None:
            import torch.nn.functional as F  # type: ignore

            return F.pad(value, (width, width, width, width), value=fill)
        return np.pad(value, width, constant_values=fill)

    def nonzero_bounds(self, mask: Any) -> tuple[int, int, int, int] | None:
        """(top, bottom, left, right), inclusive, of the true entries."""
        if self.torch is not None:
            rows = self.torch.nonzero(mask.any(dim=1)).flatten()
            cols = self.torch.nonzero(mask.any(dim=0)).flatten()
            if rows.numel() == 0:
                return None
            return int(rows[0]), int(rows[-1]), int(cols[0]), int(cols[-1])
        rows = np.flatnonzero(mask.any(axis=1))
        cols = np.flatnonzero(mask.any(axis=0))
        if rows.size == 0:
            return None
        return int(rows[0]), int(rows[-1]), int(cols[0]), int(cols[-1])

    def nonzero(self, mask: Any) -> tuple[Any, Any]:
        if self.torch is not None:
            rows, cols = self.torch.nonzero(mask, as_tuple=True)
            return rows, cols
        return np.nonzero(mask)

    def as_float(self, value: Any) -> Any:
        if self.torch is not None:
            return value.to(self.torch.float32)
        return value.astype(np.float32)

    def floor_int(self, value: Any) -> Any:
        if self.torch is not None:
            return self.torch.floor(value).to(self.torch.int64)
        return np.floor(value).astype(np.int64)

    def concat(self, parts: list[Any]) -> Any:
        if self.torch is not None:
            return self.torch.cat(parts)
        return np.concatenate(parts)

    def offsets(self, radius: int) -> tuple[Any, Any]:
        """Window offsets from a point's floor() pixel that can lie within
        `radius` + 1 of the point (a disc, not the full square)."""
        span = np.arange(-radius, radius + 2)
        oy, ox = np.meshgrid(span, span, indexing="ij")
        # The point lies in [0, 1) of its floor pixel; measure from the centre
        # of that cell so the disc keeps every pixel that can be in reach.
        keep = (oy - 0.5) ** 2 + (ox - 0.5) ** 2 <= (radius + 1 + 0.75) ** 2
        oy, ox = oy[keep], ox[keep]
        if self.torch is not None:
            return (
                self.torch.from_numpy(oy).to(self.device),
                self.torch.from_numpy(ox).to(self.device),
            )
        return oy, ox

    def scatter_min(self, target: Any, index: Any, values: Any) -> None:
        if self.torch is not None:
            target.scatter_reduce_(0, index, values, reduce="amin")
        else:
            np.minimum.at(target, index, values)

    def where(self, condition: Any, a: Any, b: Any) -> Any:
        if self.torch is not None:
            return self.torch.where(condition, a, b)
        return np.where(condition, a, b)

    def sqrt(self, value: Any) -> Any:
        return self.torch.sqrt(value) if self.torch is not None else np.sqrt(value)

    def round(self, value: Any) -> Any:
        return self.torch.round(value) if self.torch is not None else np.round(value)

    def clip_int(self, value: Any, low: int, high: int) -> Any:
        if self.torch is not None:
            return self.torch.clamp(value, low, high)
        return np.clip(value, low, high)

    def clip(self, value: Any, low: float, high: float) -> Any:
        if self.torch is not None:
            return self.torch.clamp(value, low, high)
        return np.clip(value, low, high)

    def to_uint8(self, value: Any) -> np.ndarray:
        if self.torch is not None:
            value = value.to(self.torch.uint8).cpu().numpy()
        return np.ascontiguousarray(value, dtype=np.uint8)


def _merge_objects(logits: Any) -> Any:
    """Union every object/channel into one (H, W) float field: the max logit."""
    if isinstance(logits, (list, tuple)):
        if not logits:
            raise ValueError("SAM2 logits list is empty")
        fields = [_merge_objects(item) for item in logits]
        merged = fields[0]
        for field in fields[1:]:
            merged = _Ops(merged).where(field > merged, field, merged)
        return merged

    if _is_torch_tensor(logits):
        field = logits.detach().float()
    else:
        field = np.asarray(logits, dtype=np.float32)

    if field.ndim < 2:
        raise ValueError(f"Unexpected SAM2 logits shape: {tuple(field.shape)}")
    if field.ndim > 2:
        height, width = field.shape[-2], field.shape[-1]
        flat = field.reshape(-1, height, width)
        field = flat.amax(dim=0) if _is_torch_tensor(flat) else flat.max(axis=0)
    return field


def _resize_field(field: Any, size: tuple[int, int]) -> Any:
    """Bilinearly resample the logits, as SAM2 does for its video-res output."""
    height, width = size
    if tuple(field.shape) == (height, width):
        return field
    if _is_torch_tensor(field):
        import torch.nn.functional as F  # type: ignore

        return F.interpolate(
            field[None, None],
            size=(height, width),
            mode="bilinear",
            align_corners=False,
        )[0, 0]
    from PIL import Image

    resized = Image.fromarray(np.asarray(field, dtype=np.float32), mode="F").resize(
        (width, height),
        resample=Image.Resampling.BILINEAR,
    )
    return np.asarray(resized, dtype=np.float32)


def _boundary_points(ops: _Ops, field: Any) -> tuple[Any, Any]:
    """Sub-pixel boundary: the linear zero crossing on every 4-neighbour edge
    whose endpoints straddle it. Pixel (x, y) is centred on (x, y)."""
    xs_parts: list[Any] = []
    ys_parts: list[Any] = []
    for axis in (0, 1):
        if axis == 0:
            a, b = field[:-1, :], field[1:, :]
        else:
            a, b = field[:, :-1], field[:, 1:]
        rows, cols = ops.nonzero((a > 0) != (b > 0))
        start = a[rows, cols]
        t = ops.clip(start / (start - b[rows, cols]), 0.0, 1.0)
        rows_f = ops.as_float(rows)
        cols_f = ops.as_float(cols)
        xs_parts.append(cols_f + t if axis == 1 else cols_f)
        ys_parts.append(rows_f + t if axis == 0 else rows_f)
    return ops.concat(xs_parts), ops.concat(ys_parts)


def _nearest_squared_by_splat(
    ops: _Ops,
    points_x: Any,
    points_y: Any,
    height: int,
    width: int,
) -> Any:
    """Exact squared distance to the nearest boundary point, within the band.

    Each point writes its squared distance into every pixel of the window
    around it and each pixel keeps the minimum, so the cost follows the
    boundary length and an empty frame costs nothing. Off-frame targets are
    not filtered out, which would cost a compaction per batch: they write a
    far value onto the nearest border pixel, which never lowers its minimum
    (one shared spare slot would serialise the GPU's atomics on it).
    """
    nearest_squared = ops.full(height * width, _FAR)
    offset_y, offset_x = ops.offsets(_SPLAT_RADIUS)
    batch = max(1, _SPLAT_BATCH_ELEMENTS // len(offset_x))
    for start in range(0, len(points_x), batch):
        px = points_x[start : start + batch]
        py = points_y[start : start + batch]
        target_x = ops.floor_int(px)[:, None] + offset_x[None, :]
        target_y = ops.floor_int(py)[:, None] + offset_y[None, :]
        squared = (ops.as_float(target_x) - px[:, None]) ** 2 + (
            ops.as_float(target_y) - py[:, None]
        ) ** 2
        on_frame = (
            (target_x >= 0)
            & (target_x < width)
            & (target_y >= 0)
            & (target_y < height)
        )
        index = ops.clip_int(target_y, 0, height - 1) * width + ops.clip_int(
            target_x, 0, width - 1
        )
        ops.scatter_min(
            nearest_squared,
            index.reshape(-1),
            ops.where(on_frame, squared, _FAR).reshape(-1),
        )
    return nearest_squared.reshape(height, width)


def _nearest_squared_by_flood(ops: _Ops, field: Any) -> Any:
    """Squared distance to the nearest boundary point by a bounded jump flood.

    Approximate (rare wrong-seed picks of at most half a pixel) but a fixed
    cost per pixel, for boundaries too long to splat cheaply.
    """
    height, width = field.shape
    grid_y, grid_x = ops.grid(height, width)
    seed_x = ops.full((height, width), _FAR)
    seed_y = ops.full((height, width), _FAR)
    best = ops.full((height, width), _FAR)

    # 1. Seed each boundary pixel with the nearest crossing on its own edges.
    for axis in (0, 1):
        if axis == 0:
            first, second = (slice(0, height - 1), slice(None)), (slice(1, height), slice(None))
        else:
            first, second = (slice(None), slice(0, width - 1)), (slice(None), slice(1, width))
        a = field[first]
        b = field[second]
        crosses = (a > 0) != (b > 0)
        t = ops.clip(a / ops.where(crosses, a - b, ops.full(tuple(a.shape), 1.0)), 0.0, 1.0)
        crossing_x = grid_x[first] + (t if axis == 1 else 0.0)
        crossing_y = grid_y[first] + (t if axis == 0 else 0.0)
        for region, distance in ((first, t), (second, 1.0 - t)):
            take = crosses & (distance < best[region])
            best[region] = ops.where(take, distance, best[region])
            seed_x[region] = ops.where(take, crossing_x, seed_x[region])
            seed_y[region] = ops.where(take, crossing_y, seed_y[region])

    # 2. Flood only the seeds' bounds grown by the band: no pixel farther from
    #    every seed can land inside it.
    nearest_squared = ops.full((height, width), _FAR**2)
    bounds = ops.nonzero_bounds(best < _FAR)
    if bounds is None:
        return nearest_squared
    reach = _SPLAT_RADIUS + 1
    top, bottom, left, right = bounds
    window = (
        slice(max(0, top - reach), min(height, bottom + reach + 1)),
        slice(max(0, left - reach), min(width, right + reach + 1)),
    )
    window_x = grid_x[window]
    window_y = grid_y[window]
    crop_x = seed_x[window]
    crop_y = seed_y[window]
    crop_height, crop_width = crop_x.shape
    crop_best = (crop_x - window_x) ** 2 + (crop_y - window_y) ** 2
    for step in _FLOOD_STEPS:
        # Every pass reads the previous pass's seeds.
        padded_x = ops.pad(crop_x, step, _FAR)
        padded_y = ops.pad(crop_y, step, _FAR)
        next_x = ops.copy(crop_x)
        next_y = ops.copy(crop_y)
        for dy in (-step, 0, step):
            for dx in (-step, 0, step):
                if dy == 0 and dx == 0:
                    continue
                rows = slice(step + dy, step + dy + crop_height)
                cols = slice(step + dx, step + dx + crop_width)
                candidate_x = padded_x[rows, cols]
                candidate_y = padded_y[rows, cols]
                squared = (candidate_x - window_x) ** 2 + (candidate_y - window_y) ** 2
                take = squared < crop_best
                crop_best = ops.where(take, squared, crop_best)
                next_x = ops.where(take, candidate_x, next_x)
                next_y = ops.where(take, candidate_y, next_y)
        crop_x, crop_y = next_x, next_y
    nearest_squared[window] = crop_best
    return nearest_squared


def _distance_levels(field: Any) -> np.ndarray:
    ops = _Ops(field)
    height, width = field.shape
    inside = field > 0
    points_x, points_y = _boundary_points(ops, field)

    # 1. Distances within the band, by whichever method is cheaper here.
    splat_writes = len(points_x) * len(ops.offsets(_SPLAT_RADIUS)[0])
    if ops.is_cuda and splat_writes <= _MAX_CUDA_SPLAT_WRITES_PER_PIXEL * height * width:
        nearest_squared = _nearest_squared_by_splat(ops, points_x, points_y, height, width)
    else:
        nearest_squared = _nearest_squared_by_flood(ops, field)

    # 2. Quantise, forcing the midpoint cut to agree with the logits' sign.
    distance = ops.sqrt(nearest_squared)
    signed = ops.where(inside, -distance, distance)
    levels = ops.clip(
        ops.round(MASK_DISTANCE_ZERO_LEVEL - MASK_DISTANCE_LEVELS_PER_PIXEL * signed),
        0.0,
        255.0,
    )
    levels = ops.where(
        inside,
        ops.clip(levels, float(MASK_DISTANCE_INSIDE_LEVEL), 255.0),
        ops.clip(levels, 0.0, float(MASK_DISTANCE_INSIDE_LEVEL - 1)),
    )
    return ops.to_uint8(levels)


def logits_to_distance_frame(
    logits: Any,
    size: tuple[int, int] | None = None,
) -> np.ndarray:
    """Encode SAM2 logits (any leading object/channel axes) as one distance frame.

    `size` is (height, width); logits at another resolution are bilinearly
    resampled to it first.
    """
    field = _merge_objects(logits)
    if size is not None:
        field = _resize_field(field, size)
    return _distance_levels(field)


def distance_frames_inside(frames: np.ndarray | Sequence[np.ndarray]) -> np.ndarray:
    """Binary coverage of encoded distance frames."""
    return np.asarray(frames) >= MASK_DISTANCE_INSIDE_LEVEL
