from __future__ import annotations

from typing import Any

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.types import Processor, ProcessorMeta
from services.workflow_rules import WorkflowValidationError


def _coerce_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("-"):
            digits = stripped[1:]
            if digits.isdigit():
                return int(stripped)
        elif stripped.isdigit():
            return int(stripped)
    return None


def _coerce_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return float(stripped)
        except ValueError:
            return None
    return None


def _coerce_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized == "true":
            return True
        if normalized == "false":
            return False
    return None


def _match_enum_value(
    value: Any,
    options: list[Any] | None,
) -> Any | None:
    if not isinstance(options, list) or not options:
        return None
    for option in options:
        if option == value:
            return option
        if str(option) == str(value):
            return option
    return None


def _check_numeric_bounds(
    value: int | float,
    widget_rule: dict[str, Any],
) -> str | None:
    min_value = widget_rule.get("min")
    max_value = widget_rule.get("max")
    if isinstance(min_value, (int, float)) and value < min_value:
        return f"Value must be at least {min_value}."
    if isinstance(max_value, (int, float)) and value > max_value:
        return f"Value must be at most {max_value}."
    return None


def _normalize_widget_value(
    value: Any,
    widget_rule: dict[str, Any],
) -> tuple[Any | None, str | None]:
    value_type = widget_rule.get("value_type")
    if value_type == "int":
        coerced = _coerce_int(value)
        if coerced is None:
            return None, "Value must be an integer."
        bounds_error = _check_numeric_bounds(coerced, widget_rule)
        if bounds_error:
            return None, bounds_error
        return coerced, None

    if value_type == "float":
        coerced = _coerce_float(value)
        if coerced is None:
            return None, "Value must be a number."
        bounds_error = _check_numeric_bounds(coerced, widget_rule)
        if bounds_error:
            return None, bounds_error
        return coerced, None

    if value_type == "boolean":
        coerced = _coerce_bool(value)
        if coerced is None:
            return None, "Value must be true or false."
        return coerced, None

    if value_type == "enum":
        matched = _match_enum_value(value, widget_rule.get("options"))
        if matched is None:
            return None, "Value must match one of the allowed options."
        return matched, None

    if value_type == "string":
        if isinstance(value, str):
            return value, None
        return None, "Value must be a string."

    return value, None


def _failure(
    node_id: str,
    param: str,
    message: str,
    *,
    kind: str = "widget",
) -> dict[str, Any]:
    return {
        "kind": kind,
        "node_id": node_id,
        "param": param,
        "message": message,
    }


class _ValidateWidgetsProcessor:
    meta = ProcessorMeta(
        name="validate_widgets",
        reads=("rules", "widget_overrides", "widget_modes"),
        writes=("widget_overrides",),
        description="Validates and normalizes submitted widget values before they mutate the workflow",
    )

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return bool(ctx.widget_overrides) or bool(ctx.widget_modes)

    async def execute(self, ctx: BackendPipelineContext) -> None:
        failures: list[dict[str, Any]] = []
        normalized_overrides: dict[str, dict[str, Any]] = {}
        nodes_rules = ctx.rules.get("nodes")
        if not isinstance(nodes_rules, dict):
            nodes_rules = {}

        for node_id, overrides in ctx.widget_overrides.items():
            if not isinstance(overrides, dict):
                continue
            node_rule = nodes_rules.get(node_id)
            widget_defs = node_rule.get("widgets") if isinstance(node_rule, dict) else None
            for param, value in overrides.items():
                widget_rule = widget_defs.get(param) if isinstance(widget_defs, dict) else None
                if not isinstance(widget_rule, dict):
                    failures.append(
                        _failure(node_id, param, "Widget is not defined by workflow rules.")
                    )
                    continue
                if widget_rule.get("frontend_only") is True:
                    failures.append(
                        _failure(node_id, param, "Frontend-only widgets cannot be submitted.")
                    )
                    continue
                normalized_value, error_message = _normalize_widget_value(value, widget_rule)
                if error_message:
                    failures.append(_failure(node_id, param, error_message))
                    continue
                normalized_overrides.setdefault(node_id, {})[param] = normalized_value

        for node_id, param_modes in ctx.widget_modes.items():
            if not isinstance(param_modes, dict):
                continue
            node_rule = nodes_rules.get(node_id)
            widget_defs = node_rule.get("widgets") if isinstance(node_rule, dict) else None
            for param, mode in param_modes.items():
                if mode != "randomize":
                    continue
                widget_rule = widget_defs.get(param) if isinstance(widget_defs, dict) else None
                if not isinstance(widget_rule, dict):
                    failures.append(
                        _failure(
                            node_id,
                            param,
                            "Randomize mode requires a widget rule.",
                            kind="widget_mode",
                        )
                    )
                    continue
                if widget_rule.get("frontend_only") is True:
                    failures.append(
                        _failure(
                            node_id,
                            param,
                            "Frontend-only widgets cannot be randomized by the backend.",
                            kind="widget_mode",
                        )
                    )
                    continue
                if not bool(widget_rule.get("control_after_generate")):
                    failures.append(
                        _failure(
                            node_id,
                            param,
                            "Randomize mode is only supported for control-after-generate widgets.",
                            kind="widget_mode",
                        )
                    )
                    continue
                if not isinstance(widget_rule.get("min"), (int, float)) or not isinstance(
                    widget_rule.get("max"), (int, float)
                ):
                    failures.append(
                        _failure(
                            node_id,
                            param,
                            "Randomize mode requires numeric min/max bounds.",
                            kind="widget_mode",
                        )
                    )

        if failures:
            raise WorkflowValidationError(
                failures[0]["message"],
                failures=failures,
            )

        ctx.widget_overrides = normalized_overrides


validate_widgets_processor: Processor = _ValidateWidgetsProcessor()


__all__ = ["validate_widgets_processor"]
