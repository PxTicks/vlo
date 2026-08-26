"""Beat This! checkpoint discovery.

Beat This! fetches its checkpoints through ``torch.hub`` on first use, so there
is no model file to require — the cache directory is the thing worth looking at,
and its absence is a download that has not happened yet rather than a fault.
"""

from __future__ import annotations

from pathlib import Path

from ..contract import Check, CheckStatus, VerificationStage
from ..descriptors import CapabilityDescriptor, Discovery
from ..environment import config_value, display_path


def discover(descriptor: CapabilityDescriptor) -> Discovery:
    del descriptor

    cache_dir = Path(config_value("BEATTHIS_CACHE_DIR"))
    model = str(config_value("BEATTHIS_DEFAULT_MODEL", ""))

    return Discovery(
        checks=(_model_check(cache_dir, model),),
        selected_model=model,
        # A checkpoint that downloads on first use is always obtainable, so
        # nothing about discovery can make this capability unwanted.
        found=True,
    )


def _cached_checkpoints(cache_dir: Path, model: str) -> list[Path]:
    checkpoints = cache_dir / "torch" / "hub" / "checkpoints"
    if not checkpoints.is_dir():
        return []
    return [path for path in checkpoints.glob(f"*{model}*") if path.is_file()]


def _model_check(cache_dir: Path, model: str) -> Check:
    cached = _cached_checkpoints(cache_dir, model)
    if cached:
        return Check(
            id="model.default",
            status=CheckStatus.PASS,
            stage=VerificationStage.DISCOVERED,
            summary=f"Checkpoint {model} is cached locally",
            detail=display_path(cached[0]),
        )
    return Check(
        id="model.default",
        status=CheckStatus.PASS,
        stage=VerificationStage.DISCOVERED,
        summary=f"Checkpoint {model} downloads on first use",
        detail=display_path(cache_dir),
    )


__all__ = ["discover"]
