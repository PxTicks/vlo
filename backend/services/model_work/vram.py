"""VRAM release policy for the model-work coordinator.

Serialising inference removes *concurrent peak* allocation. It does not free
resident weights — all three local services keep lazy singleton models after
their work completes. v1 policy is B: retain weights, but return the caching
allocator's freed-but-cached blocks to the driver when a local torch worker
hands the resource back. After a propagation over hundreds of frames that slack
is substantial, and the cost is milliseconds with no reload penalty.

This is deliberately *not* a generic coordinator hook:

- running it after a ComfyUI token settles cannot clear allocations that live in
  the separate ComfyUI process;
- CPU-only work must not initialise torch merely to release a lease.
"""

from __future__ import annotations

import logging
import sys

logger = logging.getLogger(__name__)


def release_cuda_cache() -> None:
    """Return cached-but-unused CUDA blocks to the driver, if torch is live.

    No-ops when torch was never imported, when CUDA is unavailable, or when the
    CUDA context was never initialised in this process.
    """

    torch = sys.modules.get("torch")
    if torch is None:
        return

    try:
        cuda = getattr(torch, "cuda", None)
        if cuda is None or not cuda.is_available():
            return
        is_initialized = getattr(cuda, "is_initialized", None)
        if callable(is_initialized) and not is_initialized():
            return
        cuda.empty_cache()
    except Exception as exc:  # pragma: no cover - environment dependent
        logger.debug("torch.cuda.empty_cache() failed after lease release: %s", exc)
