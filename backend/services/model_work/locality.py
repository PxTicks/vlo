"""Where ComfyUI's GPU actually is, and therefore whether to gate it.

Hostname inference misclassifies LAN hosts, containers, WSL bridges, and
tunnels, so locality is an explicit tri-state setting. ``auto`` keeps the
hostname inference as a default; ``remote`` resolves to *no admission resource*,
which means ComfyUI work is recorded observe-only and never serialised against
local inference. It deliberately does not resolve to a second width-1 key.
"""

from __future__ import annotations

from services.model_work.ledger import LOCAL_GPU_RESOURCE
from services.runtime_settings import get_comfyui_gpu_locality


def is_comfyui_gpu_local() -> bool:
    locality = get_comfyui_gpu_locality()
    if locality == "local":
        return True
    if locality == "remote":
        return False

    # Imported lazily: model_registry pulls in the download and discovery
    # services, which have no business being loaded to answer this question.
    from services.model_registry import is_comfyui_local

    return is_comfyui_local()


def comfy_resource_key() -> str | None:
    """The admission resource for ComfyUI work, or ``None`` for observe-only."""

    return LOCAL_GPU_RESOURCE if is_comfyui_gpu_local() else None
