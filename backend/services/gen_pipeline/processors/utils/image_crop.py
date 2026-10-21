"""Analyse and crop still images whose alpha channel is their mask.

A frame captured with its timeline masks keeps the masked pixels' colour under
zero alpha, so ``255 - alpha`` is the mask: bright where the workflow should
regenerate. The crop region comes from the same bounding-box math as mask
videos, so a still and a video with the same mask crop identically.
"""

from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image

from services.gen_pipeline.processors.utils.mask_crop import (
    compute_mask_crop,
    get_mask_bounds_from_frame,
)


class ImageCropError(RuntimeError):
    """Raised when an image cannot be decoded or cropped."""


def read_alpha_mask(image_bytes: bytes) -> np.ndarray | None:
    """Return the image's mask (``255 - alpha``) as an (H, W) uint8 array.

    *None* when the image has no alpha channel: nothing in it is masked.
    """
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            image.load()
            if "A" not in image.getbands() and "transparency" not in image.info:
                return None
            alpha = np.asarray(image.convert("RGBA").getchannel("A"), dtype=np.uint8)
    except (OSError, ValueError) as exc:
        raise ImageCropError(f"Could not decode image: {exc}") from exc
    return (255 - alpha).astype(np.uint8)


def analyze_alpha_mask_bounds(
    mask: np.ndarray,
    target_ar: float,
    dilation: float = 0.1,
) -> tuple[int, int, int, int] | None:
    """Crop region ``(x1, y1, x2, y2)`` for *mask*, or *None* for a full-frame run."""
    height, width = mask.shape
    bounds = get_mask_bounds_from_frame(mask)
    return compute_mask_crop(bounds, width, height, target_ar, dilation)


def crop_image(image_bytes: bytes, region: tuple[int, int, int, int]) -> bytes:
    """Crop to *region* and re-encode as PNG, keeping the alpha channel."""
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            image.load()
            cropped = image.crop(region)
    except (OSError, ValueError) as exc:
        raise ImageCropError(f"Could not crop image: {exc}") from exc
    output = BytesIO()
    cropped.save(output, format="PNG")
    return output.getvalue()


def encode_mask_png(mask: np.ndarray) -> bytes:
    """Encode an (H, W) uint8 mask as a greyscale PNG, white where masked."""
    output = BytesIO()
    Image.fromarray(mask).save(output, format="PNG")
    return output.getvalue()
