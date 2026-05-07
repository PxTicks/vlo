"""Shared evaluator for workflow-rule conditions.

A condition expression is a recursive tree that combines:
 - ``always`` / ``input_presence`` / ``compare`` leaves
 - ``all_of`` / ``any_of`` / ``not`` combinators

The dict-based representations accepted here match the unified schema after
parse-time normalisation. Legacy ``widget_boolean`` and
``frontend_control_boolean`` shapes are rewritten into ``compare`` by
``ResolvedWorkflowRules`` before any evaluator sees them.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ConditionState:
    """State bag passed to the evaluator.

    Missing state for a reference kind resolves to ``None`` and makes
    ``compare`` conditions return False.
    """

    provided_input_ids: frozenset[str] = frozenset()
    workflow: dict[str, Any] | None = None
    pipeline_control_values: dict[str, dict[str, Any]] = field(default_factory=dict)
    frontend_control_values: dict[str, Any] = field(default_factory=dict)
    derived_widget_values: dict[str, Any] = field(default_factory=dict)
    input_metadata: dict[str, Any] = field(default_factory=dict)


def resolve_input_metadata_field(
    input_metadata: dict[str, Any],
    input_id: Any,
    field_name: Any,
) -> Any:
    if not isinstance(input_id, str) or not isinstance(field_name, str):
        return None

    current = input_metadata.get(input_id)
    if not isinstance(current, dict):
        return None

    for segment in field_name.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(segment)
    return current


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


def _coerce_boolean(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized == "true":
            return True
        if normalized == "false":
            return False
    return None


def resolve_state_reference(ref: Any, state: ConditionState) -> Any:
    if not isinstance(ref, dict):
        return None

    kind = ref.get("kind")
    if kind == "workflow_param":
        node_id = ref.get("node_id")
        param = ref.get("param")
        if (
            state.workflow is None
            or not isinstance(node_id, str)
            or not isinstance(param, str)
        ):
            return None
        node = state.workflow.get(node_id)
        if not isinstance(node, dict):
            return None
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            return None
        return inputs.get(param)

    if kind == "pipeline_control":
        stage_id = ref.get("stage_id")
        key = ref.get("key")
        if not isinstance(stage_id, str) or not isinstance(key, str):
            return None
        stage_values = state.pipeline_control_values.get(stage_id)
        if not isinstance(stage_values, dict):
            return None
        return stage_values.get(key)

    if kind == "frontend_control":
        control_id = ref.get("control_id")
        if not isinstance(control_id, str):
            return None
        return state.frontend_control_values.get(control_id)

    if kind == "derived_widget":
        derived_id = ref.get("derived_widget_id")
        if not isinstance(derived_id, str):
            return None
        return state.derived_widget_values.get(derived_id)

    if kind == "input_metadata":
        return resolve_input_metadata_field(
            state.input_metadata,
            ref.get("input"),
            ref.get("field"),
        )

    return None


def compare_values(current: Any, operator: str, expected: Any) -> bool:
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

    current_boolean = _coerce_boolean(current)
    expected_boolean = _coerce_boolean(expected)
    if current_boolean is not None and expected_boolean is not None:
        matches = current_boolean is expected_boolean
    else:
        current_number = _coerce_numeric(current)
        expected_number = _coerce_numeric(expected)
        if current_number is not None and expected_number is not None:
            matches = math.isclose(
                current_number,
                expected_number,
                rel_tol=0.0,
                abs_tol=1e-9,
            )
        elif isinstance(current, str) and isinstance(expected, str):
            matches = current.strip().lower() == expected.strip().lower()
        else:
            matches = current == expected

    if operator == "neq":
        return not matches
    return matches


def _evaluate_input_presence(condition: dict[str, Any], state: ConditionState) -> bool:
    raw_inputs = condition.get("inputs")
    if not isinstance(raw_inputs, list):
        return False

    inputs = [
        str(input_id).strip()
        for input_id in raw_inputs
        if str(input_id).strip()
    ]
    if not inputs:
        return False

    match_mode = condition.get("match")
    if not isinstance(match_mode, str):
        match_mode = "all_present"

    provided = state.provided_input_ids
    if match_mode == "all_present":
        return all(input_id in provided for input_id in inputs)
    if match_mode == "all_missing":
        return all(input_id not in provided for input_id in inputs)
    if match_mode == "any_present":
        return any(input_id in provided for input_id in inputs)
    if match_mode == "any_missing":
        return any(input_id not in provided for input_id in inputs)
    return False


def _evaluate_compare(condition: dict[str, Any], state: ConditionState) -> bool:
    ref = condition.get("ref")
    current_value = resolve_state_reference(ref, state)
    operator = condition.get("operator", "eq")
    if not isinstance(operator, str):
        operator = "eq"
    return compare_values(current_value, operator, condition.get("value"))


def evaluate_condition(condition: Any, state: ConditionState) -> bool:
    if not isinstance(condition, dict):
        return False

    kind = condition.get("kind")
    if kind == "always":
        value = condition.get("value", True)
        return bool(value)
    if kind == "input_presence":
        return _evaluate_input_presence(condition, state)
    if kind == "compare":
        return _evaluate_compare(condition, state)
    if kind == "all_of":
        conditions = condition.get("conditions")
        if not isinstance(conditions, list):
            return False
        return all(evaluate_condition(item, state) for item in conditions)
    if kind == "any_of":
        conditions = condition.get("conditions")
        if not isinstance(conditions, list):
            return False
        return any(evaluate_condition(item, state) for item in conditions)
    if kind == "not":
        inner = condition.get("condition")
        return not evaluate_condition(inner, state)
    return False


__all__ = [
    "ConditionState",
    "compare_values",
    "evaluate_condition",
    "resolve_input_metadata_field",
    "resolve_state_reference",
]
