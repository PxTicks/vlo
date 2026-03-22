from __future__ import annotations

from typing import Any

import httpx

from services.workflow_rules.mask_pairs import MaskCroppingMode
from services.workflow_rules.schema import (
    ResolvedWorkflowRules,
    default_resolved_rules_model,
    dump_resolved_rules,
)


class BackendPipelineContext:
    """Mutable context that flows through the backend generation pipeline."""

    def __init__(
        self,
        *,
        client: httpx.AsyncClient,
        client_id: str,
        workflow: dict[str, Any],
        workflow_id: str | None = None,
        target_aspect_ratio: str | None = None,
        target_resolution: Any = None,
        mask_crop_dilation: float | None = None,
        mask_crop_mode: MaskCroppingMode | None = None,
        injections: dict[str, dict[str, Any]] | None = None,
        widget_overrides: dict[str, dict[str, Any]] | None = None,
        derived_widget_values: dict[str, Any] | None = None,
        widget_modes: dict[str, dict[str, str]] | None = None,
        buffered_videos: dict[str, dict[str, Any]] | None = None,
        graph_data: dict[str, Any] | None = None,
        rules: dict[str, Any] | None = None,
        rules_model: ResolvedWorkflowRules | None = None,
        warnings: list[dict[str, Any]] | None = None,
        provided_input_ids: set[str] | None = None,
        applied_widget_values: dict[str, str] | None = None,
        aspect_ratio_metadata: dict[str, Any] | None = None,
        aspect_ratio_applied: bool = False,
        mask_crop_metadata: dict[str, Any] | None = None,
        processed_mask_bytes: bytes | None = None,
        prompt_id: str | None = None,
        comfyui_response: httpx.Response | None = None,
    ) -> None:
        self.client = client
        self.client_id = client_id
        self.workflow = workflow
        self.workflow_id = workflow_id
        self.target_aspect_ratio = target_aspect_ratio
        self.target_resolution = target_resolution
        self.mask_crop_dilation = mask_crop_dilation
        self.mask_crop_mode = mask_crop_mode
        self.injections = dict(injections or {})
        self.widget_overrides = dict(widget_overrides or {})
        self.derived_widget_values = dict(derived_widget_values or {})
        self.widget_modes = dict(widget_modes or {})
        self.buffered_videos = dict(buffered_videos or {})
        self.graph_data = graph_data
        self.warnings = list(warnings or [])
        self.provided_input_ids = set(provided_input_ids or set())
        self.applied_widget_values = dict(applied_widget_values or {})
        self.aspect_ratio_metadata = aspect_ratio_metadata
        self.aspect_ratio_applied = aspect_ratio_applied
        self.mask_crop_metadata = mask_crop_metadata
        self.processed_mask_bytes = processed_mask_bytes
        self.prompt_id = prompt_id
        self.comfyui_response = comfyui_response

        self._rules_model = default_resolved_rules_model()
        if rules_model is not None:
            self.rules_model = rules_model
        elif rules is not None:
            self.rules = rules

    @property
    def rules_model(self) -> ResolvedWorkflowRules:
        return self._rules_model

    @rules_model.setter
    def rules_model(self, value: ResolvedWorkflowRules | None) -> None:
        self._rules_model = value if value is not None else default_resolved_rules_model()

    @property
    def rules(self) -> dict[str, Any]:
        return dump_resolved_rules(self._rules_model)

    @rules.setter
    def rules(self, value: dict[str, Any] | None) -> None:
        if value is None:
            self._rules_model = default_resolved_rules_model()
            return
        self._rules_model = ResolvedWorkflowRules.model_validate(value)
