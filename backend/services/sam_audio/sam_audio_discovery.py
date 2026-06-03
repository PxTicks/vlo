from __future__ import annotations

from pathlib import Path
from typing import TypedDict

from config import SAM_AUDIO_MODEL_DIR


class SamAudioModelInfo(TypedDict):
    key: str
    name: str
    path: str
    config_path: str
    checkpoint_path: str


def discover_sam_audio_models() -> list[SamAudioModelInfo]:
    """Find locally downloaded SAM-Audio model directories."""
    models: list[SamAudioModelInfo] = []
    if not SAM_AUDIO_MODEL_DIR.exists() or not SAM_AUDIO_MODEL_DIR.is_dir():
        return models

    for model_dir in sorted(SAM_AUDIO_MODEL_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not model_dir.is_dir():
            continue

        config_path = model_dir / "config.json"
        checkpoint_path = model_dir / "checkpoint.pt"
        if not config_path.is_file() or not checkpoint_path.is_file():
            continue

        models.append(
            {
                "key": model_dir.name,
                "name": model_dir.name,
                "path": str(model_dir),
                "config_path": str(config_path),
                "checkpoint_path": str(checkpoint_path),
            }
        )

    return models


def get_local_sam_audio_model_path(model_key: str) -> Path | None:
    normalized = model_key.strip()
    if not normalized:
        return None

    candidate = SAM_AUDIO_MODEL_DIR / normalized
    if (candidate / "config.json").is_file() and (candidate / "checkpoint.pt").is_file():
        return candidate
    return None
