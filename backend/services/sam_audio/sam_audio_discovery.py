from __future__ import annotations

from pathlib import Path
from typing import TypedDict

from config import SAM_AUDIO_SEARCH_PATHS


class SamAudioModelInfo(TypedDict):
    key: str
    name: str
    path: str
    config_path: str
    checkpoint_path: str


def discover_sam_audio_models() -> list[SamAudioModelInfo]:
    """Find locally downloaded SAM-Audio model directories."""
    models: list[SamAudioModelInfo] = []
    seen_keys: set[str] = set()

    for search_dir in SAM_AUDIO_SEARCH_PATHS:
        if not search_dir.exists() or not search_dir.is_dir():
            continue

        for model_dir in sorted(search_dir.iterdir(), key=lambda p: p.name.lower()):
            if not model_dir.is_dir() or model_dir.name in seen_keys:
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
            seen_keys.add(model_dir.name)

    return models


def get_local_sam_audio_model_path(model_key: str) -> Path | None:
    normalized = model_key.strip()
    if not normalized:
        return None

    for search_dir in SAM_AUDIO_SEARCH_PATHS:
        candidate = search_dir / normalized
        if (candidate / "config.json").is_file() and (candidate / "checkpoint.pt").is_file():
            return candidate
    return None
