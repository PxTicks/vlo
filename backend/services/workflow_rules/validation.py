from __future__ import annotations

from typing import Any


class WorkflowValidationError(ValueError):
    """Raised when a workflow validation step fails before dispatch."""

    def __init__(
        self,
        message: str,
        *,
        failures: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(message)
        self.failures = failures or []


def _normalize_provided_input_ids(
    provided_input_ids: set[str] | None,
) -> set[str]:
    return {
        str(input_id).strip()
        for input_id in (provided_input_ids or set())
        if str(input_id).strip()
    }


def resolve_input_validation_rules(
    rules: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    if not isinstance(rules, dict):
        return []

    validation = rules.get("validation")
    if isinstance(validation, dict):
        raw_rules = validation.get("inputs")
        if isinstance(raw_rules, list):
            normalized = [
                rule for rule in raw_rules if isinstance(rule, dict) and isinstance(rule.get("kind"), str)
            ]
            if normalized:
                return normalized

    raw_conditions = rules.get("input_conditions")
    if not isinstance(raw_conditions, list):
        return []

    resolved: list[dict[str, Any]] = []
    for raw_condition in raw_conditions:
        if not isinstance(raw_condition, dict):
            continue
        if raw_condition.get("kind") != "at_least_one":
            continue
        raw_inputs = raw_condition.get("inputs")
        if not isinstance(raw_inputs, list):
            continue
        inputs = [
            str(input_id).strip()
            for input_id in raw_inputs
            if str(input_id).strip()
        ]
        if not inputs:
            continue

        rule: dict[str, Any] = {
            "kind": "at_least_n",
            "inputs": inputs,
            "min": 1,
        }
        raw_message = raw_condition.get("message")
        if isinstance(raw_message, str) and raw_message.strip():
            rule["message"] = raw_message.strip()
        resolved.append(rule)

    return resolved


def _message_for_validation_rule(rule: dict[str, Any]) -> str:
    raw_message = rule.get("message")
    if isinstance(raw_message, str) and raw_message.strip():
        return raw_message.strip()

    kind = rule.get("kind")
    if kind == "required":
        return f"Input '{rule.get('input')}' is required."

    if kind == "at_least_n":
        min_count = int(rule.get("min", 1))
        inputs = ", ".join(rule.get("inputs", []))
        if min_count == 1:
            return f"Provide at least one of the following inputs: {inputs}"
        return f"Provide at least {min_count} of the following inputs: {inputs}"

    if kind == "optional":
        return ""

    return "Workflow input validation failed."


def evaluate_input_validation(
    rules: dict[str, Any] | None,
    provided_input_ids: set[str] | None,
) -> list[dict[str, Any]]:
    normalized_provided = _normalize_provided_input_ids(provided_input_ids)
    failures: list[dict[str, Any]] = []

    for rule in resolve_input_validation_rules(rules):
        kind = rule.get("kind")
        if kind == "optional":
            continue

        if kind == "required":
            input_id = rule.get("input")
            if not isinstance(input_id, str) or input_id in normalized_provided:
                continue
            failures.append(
                {
                    "kind": "required",
                    "input": input_id,
                    "message": _message_for_validation_rule(rule),
                }
            )
            continue

        if kind == "at_least_n":
            raw_inputs = rule.get("inputs")
            raw_min = rule.get("min")
            if not isinstance(raw_inputs, list) or not isinstance(raw_min, int):
                continue
            inputs = [
                str(input_id).strip()
                for input_id in raw_inputs
                if str(input_id).strip()
            ]
            if not inputs:
                continue
            satisfied_count = sum(
                1 for input_id in inputs if input_id in normalized_provided
            )
            if satisfied_count >= raw_min:
                continue
            failures.append(
                {
                    "kind": "at_least_n",
                    "inputs": inputs,
                    "min": raw_min,
                    "provided": satisfied_count,
                    "message": _message_for_validation_rule(rule),
                }
            )

    return failures


def find_unsatisfied_input_conditions(
    rules: dict[str, Any] | None,
    provided_input_ids: set[str] | None,
) -> list[str]:
    return [
        failure["message"]
        for failure in evaluate_input_validation(rules, provided_input_ids)
        if isinstance(failure.get("message"), str) and failure["message"].strip()
    ]


__all__ = [
    "WorkflowValidationError",
    "evaluate_input_validation",
    "find_unsatisfied_input_conditions",
    "resolve_input_validation_rules",
]
