from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from services.workflow_rules.mask_pairs import MaskCroppingMode


@dataclass
class BackendPipelineContext:
    """Mutable context that flows through the backend generation pipeline.

    Each processor reads from and writes to this context.  The runner
    populates the input fields from ``GenerationInput`` before the
    pipeline starts; processors populate the output fields as they run.
    """

    # --- Inputs (populated before the runner starts) ---

    client: httpx.AsyncClient
    """HTTP client for ComfyUI communication."""

    client_id: str
    """WebSocket client ID for ComfyUI prompt tracking."""

    workflow: dict[str, Any]
    """The ComfyUI API-format workflow being assembled."""

    workflow_id: str | None = None
    """Filename of the active workflow (used to load sidecar rules)."""

    target_aspect_ratio: str | None = None
    """User-requested aspect ratio, e.g. '16:9'."""

    target_resolution: Any = None
    """User-requested resolution (long-edge pixels)."""

    mask_crop_dilation: float | None = None
    """Dilation factor for mask-crop preprocessing (0.0–1.0)."""

    mask_crop_mode: MaskCroppingMode | None = None
    """Optional runtime override for mask-crop preprocessing mode."""

    injections: dict[str, dict[str, Any]] = field(default_factory=dict)
    """Per-node value injections from the frontend (node_id → {param, value})."""

    manual_slot_values: dict[str, Any] = field(default_factory=dict)
    """Manual slot payloads keyed by slot ID."""

    widget_overrides: dict[str, dict[str, Any]] = field(default_factory=dict)
    """Frontend-supplied widget value overrides (node_id → {param: value})."""

    widget_modes: dict[str, dict[str, str]] = field(default_factory=dict)
    """Widget control modes (node_id → {param: 'fixed' | 'randomize'})."""

    buffered_videos: dict[str, dict[str, Any]] = field(default_factory=dict)
    """Video bytes awaiting upload (node_id → {bytes, filename, content_type})."""

    graph_data: dict[str, Any] | None = None
    """Visual-format workflow graph (for embedding in output file metadata via extra_pnginfo)."""

    # --- Accumulated state (processors write to these) ---

    rules: dict[str, Any] = field(default_factory=dict)
    """Normalized workflow rules (populated by the rules processor)."""

    warnings: list[dict[str, Any]] = field(default_factory=list)
    """Accumulated pipeline warnings."""

    provided_input_ids: set[str] = field(default_factory=set)
    """Normalized set of input IDs the current request is considered to provide."""

    applied_widget_values: dict[str, str] = field(default_factory=dict)
    """Final widget values after overrides and randomization (node_id:param → value)."""

    aspect_ratio_metadata: dict[str, Any] | None = None
    """Aspect ratio processing result metadata (returned to frontend for postprocessing)."""

    mask_crop_metadata: dict[str, Any] | None = None
    """Mask crop processing result metadata (returned to frontend for generation metadata)."""

    processed_mask_bytes: bytes | None = None
    """Processed mask video bytes (after crop if applicable), returned to frontend for asset ingestion."""

    prompt_id: str | None = None
    """ComfyUI prompt ID (set after submission)."""

    comfyui_response: httpx.Response | None = None
    """Raw ComfyUI response (set after submission)."""
