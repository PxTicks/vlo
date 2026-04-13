from __future__ import annotations

import math
from typing import Any

from services.workflow_rules.normalize import WorkflowRules


def iter_pipeline_stages(rules: WorkflowRules | None) -> list[dict[str, Any]]:
    if not isinstance(rules, dict):
        return []
    pipeline = rules.get("pipeline")
    if not isinstance(pipeline, list):
        return []
    return [stage for stage in pipeline if isinstance(stage, dict)]


def find_pipeline_stage(
    rules: WorkflowRules | None,
    *,
    stage_id: str | None = None,
    kind: str | None = None,
) -> dict[str, Any] | None:
    for stage in iter_pipeline_stages(rules):
        if isinstance(stage_id, str) and stage.get("id") == stage_id:
            return stage
        if isinstance(kind, str) and stage.get("kind") == kind:
            return stage
    return None


def get_stage_controls(stage: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(stage, dict):
        return []
    controls = stage.get("controls")
    if not isinstance(controls, list):
        return []
    return [control for control in controls if isinstance(control, dict)]


def find_stage_control(
    stage: dict[str, Any] | None,
    key: str,
) -> dict[str, Any] | None:
    for control in get_stage_controls(stage):
        if control.get("key") == key:
            return control
    return None


def resolve_control_options(
    control: dict[str, Any] | None,
    *,
    fallback_options: list[Any] | None = None,
) -> list[Any]:
    if not isinstance(control, dict):
        return list(fallback_options or [])

    options = control.get("options")
    if isinstance(options, list):
        resolved = list(options)
    else:
        resolved = list(fallback_options or [])

    include_options = control.get("include_options")
    if isinstance(include_options, list) and include_options:
        included = set(include_options)
        resolved = [option for option in resolved if option in included]

    exclude_options = control.get("exclude_options")
    if isinstance(exclude_options, list) and exclude_options:
        excluded = set(exclude_options)
        resolved = [option for option in resolved if option not in excluded]

    deduped: list[Any] = []
    for option in resolved:
        if option in deduped:
            continue
        deduped.append(option)
    return deduped


def _coerce_numeric(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            number = float(stripped)
        except ValueError:
            return None
        return number if math.isfinite(number) else None
    return None


def compare_control_value(current: Any, operator: str, expected: Any) -> bool:
    if operator in {"lt", "lte", "gt", "gte"}:
        current_number = _coerce_numeric(current)
        expected_number = _coerce_numeric(expected)
        if current_number is None or expected_number is None:
            return False
        if operator == "lt":
            return current_number < expected_number
        if operator == "lte":
            return current_number <= expected_number
        if operator == "gt":
            return current_number > expected_number
        return current_number >= expected_number

    current_number = _coerce_numeric(current)
    expected_number = _coerce_numeric(expected)
    if current_number is not None and expected_number is not None:
        matches = math.isclose(current_number, expected_number, rel_tol=0.0, abs_tol=1e-9)
    elif isinstance(current, str) and isinstance(expected, str):
        matches = current.strip().lower() == expected.strip().lower()
    else:
        matches = current == expected

    if operator == "neq":
        return not matches
    return matches


def _resolve_reference_value(
    ref: Any,
    workflow: dict[str, Any],
    resolved_controls: dict[str, dict[str, Any]],
) -> Any:
    if not isinstance(ref, dict):
        return None
    ref_kind = ref.get("kind")
    if ref_kind == "workflow_param":
        node = workflow.get(ref.get("node_id"))
        if not isinstance(node, dict):
            return None
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            return None
        return inputs.get(ref.get("param"))
    if ref_kind == "pipeline_control":
        stage_values = resolved_controls.get(str(ref.get("stage_id")))
        if not isinstance(stage_values, dict):
            return None
        return stage_values.get(str(ref.get("key")))
    return None


def resolve_stage_control_value(
    control: dict[str, Any],
    *,
    workflow: dict[str, Any],
    stage_inputs: dict[str, Any],
    resolved_controls: dict[str, dict[str, Any]],
    fallback_options: list[Any] | None = None,
) -> Any:
    key = control.get("key")
    if not isinstance(key, str) or not key:
        return None

    allowed_options = resolve_control_options(
        control,
        fallback_options=fallback_options,
    )

    if key in stage_inputs:
        value = stage_inputs[key]
    elif isinstance(control.get("bind"), dict):
        value = _resolve_reference_value(control["bind"], workflow, resolved_controls)
    else:
        value = None
        for default_rule in control.get("default_rules") or []:
            if not isinstance(default_rule, dict):
                continue
            when = default_rule.get("when")
            if not isinstance(when, dict):
                continue
            if not compare_control_value(
                _resolve_reference_value(when.get("ref"), workflow, resolved_controls),
                str(when.get("operator", "eq")),
                when.get("value"),
            ):
                continue
            value = default_rule.get("value")
            break
        if value is None and "default" in control:
            value = control.get("default")

    if allowed_options and value not in allowed_options:
        return allowed_options[0]
    return value


def resolve_pipeline_control_values(
    rules: WorkflowRules | None,
    workflow: dict[str, Any],
    pipeline_inputs: dict[str, dict[str, Any]] | None,
    *,
    control_option_fallbacks: dict[tuple[str, str], list[Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    resolved: dict[str, dict[str, Any]] = {}
    submitted = pipeline_inputs or {}
    fallbacks = control_option_fallbacks or {}

    for stage in iter_pipeline_stages(rules):
        stage_id = stage.get("id")
        if not isinstance(stage_id, str) or not stage_id:
            continue
        stage_inputs = submitted.get(stage_id)
        if not isinstance(stage_inputs, dict):
            stage_inputs = {}

        stage_values: dict[str, Any] = {}
        for control in get_stage_controls(stage):
            key = control.get("key")
            if not isinstance(key, str) or not key:
                continue
            stage_values[key] = resolve_stage_control_value(
                control,
                workflow=workflow,
                stage_inputs=stage_inputs,
                resolved_controls=resolved,
                fallback_options=fallbacks.get((stage_id, key)),
            )
        resolved[stage_id] = stage_values

    return resolved


__all__ = [
    "compare_control_value",
    "find_pipeline_stage",
    "find_stage_control",
    "get_stage_controls",
    "iter_pipeline_stages",
    "resolve_control_options",
    "resolve_pipeline_control_values",
    "resolve_stage_control_value",
]
