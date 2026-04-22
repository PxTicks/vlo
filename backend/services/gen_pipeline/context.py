from __future__ import annotations

from typing import Any

import httpx

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
        prompt_id: str | None = None,
        workflow: dict[str, Any],
        workflow_id: str | None = None,
        pipeline_inputs: dict[str, dict[str, Any]] | None = None,
        injections: dict[str, dict[str, Any]] | None = None,
        widget_overrides: dict[str, dict[str, Any]] | None = None,
        derived_widget_values: dict[str, Any] | None = None,
        widget_modes: dict[str, dict[str, str]] | None = None,
        buffered_media: dict[str, dict[str, Any]] | None = None,
        graph_data: dict[str, Any] | None = None,
        rules: dict[str, Any] | None = None,
        rules_model: ResolvedWorkflowRules | None = None,
        rules_override_provided: bool = False,
        warnings: list[dict[str, Any]] | None = None,
        provided_input_ids: set[str] | None = None,
        applied_widget_values: dict[str, str] | None = None,
        pipeline_outputs: dict[str, dict[str, Any]] | None = None,
        resolved_pipeline_controls: dict[str, dict[str, Any]] | None = None,
        stage_state: dict[str, dict[str, Any]] | None = None,
        comfyui_response: httpx.Response | None = None,
        skip_graph_rewrite: bool = False,
    ) -> None:
        self.client = client
        self.client_id = client_id
        self.workflow = workflow
        self.workflow_id = workflow_id
        self.prompt_id = prompt_id
        self.pipeline_inputs = {
            stage_id: dict(values)
            for stage_id, values in (pipeline_inputs or {}).items()
            if isinstance(stage_id, str) and isinstance(values, dict)
        }
        self.injections = dict(injections or {})
        self.widget_overrides = dict(widget_overrides or {})
        self.derived_widget_values = dict(derived_widget_values or {})
        self.widget_modes = dict(widget_modes or {})
        self.buffered_media = dict(buffered_media or {})
        self.graph_data = graph_data
        self.rules_override_provided = rules_override_provided
        self.warnings = list(warnings or [])
        self.provided_input_ids = set(provided_input_ids or set())
        self.applied_widget_values = dict(applied_widget_values or {})
        self.pipeline_outputs = {
            stage_id: dict(values)
            for stage_id, values in (pipeline_outputs or {}).items()
            if isinstance(stage_id, str) and isinstance(values, dict)
        }
        self.resolved_pipeline_controls = {
            stage_id: dict(values)
            for stage_id, values in (resolved_pipeline_controls or {}).items()
            if isinstance(stage_id, str) and isinstance(values, dict)
        }
        self.stage_state = {
            stage_id: dict(values)
            for stage_id, values in (stage_state or {}).items()
            if isinstance(stage_id, str) and isinstance(values, dict)
        }
        self.comfyui_response = comfyui_response
        self.skip_graph_rewrite = skip_graph_rewrite

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
