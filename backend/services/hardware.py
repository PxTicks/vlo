"""Hardware detection helpers for runtime recommendations."""

from __future__ import annotations

import subprocess
import time
from dataclasses import dataclass
from typing import Any, Literal

HIGH_VRAM_THRESHOLD_MB = 48 * 1024
_LOCAL_VRAM_CACHE_TTL_SECONDS = 60.0
_cached_local_vram: tuple[float, "VramInfo"] | None = None

VramSource = Literal["comfyui", "nvidia_smi"]


@dataclass(frozen=True)
class VramInfo:
    total_mb: int | None
    source: VramSource | None = None

    @property
    def meets_high_vram_threshold(self) -> bool:
        return self.total_mb is not None and self.total_mb >= HIGH_VRAM_THRESHOLD_MB


def _bytes_to_mb(value: int | float) -> int:
    return int(round(float(value) / (1024 * 1024)))


def detect_vram_from_system_stats(system_stats: dict[str, Any]) -> VramInfo:
    devices = system_stats.get("devices")
    if not isinstance(devices, list):
        return VramInfo(total_mb=None)

    totals: list[int] = []
    for raw_device in devices:
        if not isinstance(raw_device, dict):
            continue
        raw_total = raw_device.get("vram_total")
        if isinstance(raw_total, (int, float)):
            totals.append(_bytes_to_mb(raw_total))

    return VramInfo(total_mb=max(totals) if totals else None, source="comfyui")


def detect_local_vram() -> VramInfo:
    global _cached_local_vram

    now = time.monotonic()
    if _cached_local_vram is not None:
        cached_at, cached_info = _cached_local_vram
        if now - cached_at < _LOCAL_VRAM_CACHE_TTL_SECONDS:
            return cached_info

    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.total",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        info = VramInfo(total_mb=None)
        _cached_local_vram = (now, info)
        return info

    totals: list[int] = []
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            totals.append(int(float(stripped)))
        except ValueError:
            continue

    info = VramInfo(total_mb=max(totals) if totals else None, source="nvidia_smi")
    _cached_local_vram = (now, info)
    return info
