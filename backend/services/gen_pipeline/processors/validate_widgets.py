from __future__ import annotations

from typing import Any

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.processors.utils.coerce import (
    coerce_bool,
    coerce_float,
    coerce_int,
    match_enum_value,
)
from services.gen_pipeline.processors.utils.widget_rule_lookup import WidgetRuleLookup
from services.gen_pipeline.processors.utils.warning import pipeline_warning
from services.gen_pipeline.types import Processor, ProcessorMeta
from services.workflow_rules import WorkflowValidationError


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
        coerced = coerce_int(value)
        if coerced is None:
            return None, "Value must be an integer."
        bounds_error = _check_numeric_bounds(coerced, widget_rule)
        if bounds_error:
            return None, bounds_error
        return coerced, None

    if value_type == "float":
        coerced = coerce_float(value)
        if coerced is None:
            return None, "Value must be a number."
        bounds_error = _check_numeric_bounds(coerced, widget_rule)
        if bounds_error:
            return None, bounds_error
        return coerced, None

    if value_type == "boolean":
        true_value = widget_rule.get("true_value")
        false_value = widget_rule.get("false_value")
        if true_value is not None or false_value is not None:
            if true_value is not None and (
                value == true_value or str(value) == str(true_value)
            ):
                return true_value, None
            if false_value is not None and (
                value == false_value or str(value) == str(false_value)
            ):
                return false_value, None
        coerced = coerce_bool(value)
        if coerced is None:
            return None, "Value must be true or false."
        if coerced:
            return (true_value if true_value is not None else coerced), None
        return (false_value if false_value is not None else coerced), None

    if value_type == "enum":
        matched = match_enum_value(value, widget_rule.get("options"))
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


def _get_workflow_inputs(
    workflow: dict[str, Any],
    node_id: str,
) -> dict[str, Any] | None:
    node = workflow.get(node_id)
    if not isinstance(node, dict):
        return None
    inputs = node.get("inputs")
    return inputs if isinstance(inputs, dict) else None


class _ValidateWidgetsProcessor:
    meta = ProcessorMeta(
        name="validate_widgets",
        reads=("workflow", "rules", "widget_overrides", "widget_modes"),
        writes=("widget_overrides",),
        description="Validates and normalizes submitted widget values before they mutate the workflow",
    )

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return bool(ctx.widget_overrides) or bool(ctx.widget_modes)

    async def execute(self, ctx: BackendPipelineContext) -> None:
        failures: list[dict[str, Any]] = []
        normalized_overrides: dict[str, dict[str, Any]] = {}
        lookup = WidgetRuleLookup(ctx.rules)

        for node_id, overrides in ctx.widget_overrides.items():
            if not isinstance(overrides, dict):
                continue
            node_inputs = _get_workflow_inputs(ctx.workflow, node_id)
            for param, value in overrides.items():
                widget_rule = lookup.get_widget_rule(node_id, param)
                if widget_rule is None:
                    if node_inputs is None:
                        ctx.warnings.append(
                            pipeline_warning(
                                "widget_override_missing_node",
                                "Widget override target node was not found in the submitted workflow; ignoring override.",
                                node_id=node_id,
                                details={"param": param},
                            )
                        )
                        continue
                    if param not in node_inputs:
                        ctx.warnings.append(
                            pipeline_warning(
                                "widget_override_missing_param",
                                "Widget override target input was not found in the submitted workflow; ignoring override.",
                                node_id=node_id,
                                details={"param": param},
                            )
                        )
                        continue

                    current_value = node_inputs.get(param)
                    if isinstance(current_value, list) and len(current_value) == 2:
                        ctx.warnings.append(
                            pipeline_warning(
                                "widget_override_link_target",
                                "Widget override target is currently driven by a graph link; ignoring override.",
                                node_id=node_id,
                                details={"param": param},
                            )
                        )
                        continue

                    normalized_overrides.setdefault(node_id, {})[param] = value
                    ctx.warnings.append(
                        pipeline_warning(
                            "widget_override_missing_rule",
                            "Widget override is not defined by workflow rules; applying the submitted value directly.",
                            node_id=node_id,
                            details={"param": param},
                        )
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
            for param, mode in param_modes.items():
                if mode != "randomize":
                    continue
                widget_rule = lookup.get_widget_rule(node_id, param)
                if widget_rule is None:
                    ctx.warnings.append(
                        pipeline_warning(
                            "widget_randomize_missing_rule",
                            "Widget randomize mode requested but widget rule was not found; ignoring randomize mode.",
                            node_id=node_id,
                            details={"param": param},
                        )
                    )
                    continue
                if widget_rule.get("frontend_only") is True:
                    ctx.warnings.append(
                        pipeline_warning(
                            "widget_randomize_frontend_only",
                            "Frontend-only widgets cannot be randomized by the backend; ignoring randomize mode.",
                            node_id=node_id,
                            details={"param": param},
                        )
                    )
                    continue
                if not bool(widget_rule.get("control_after_generate")):
                    ctx.warnings.append(
                        pipeline_warning(
                            "widget_randomize_not_supported",
                            "Randomize mode is only supported for control-after-generate widgets; ignoring randomize mode.",
                            node_id=node_id,
                            details={"param": param},
                        )
                    )
                    continue
                if not isinstance(widget_rule.get("min"), (int, float)) or not isinstance(
                    widget_rule.get("max"), (int, float)
                ):
                    ctx.warnings.append(
                        pipeline_warning(
                            "widget_randomize_invalid_bounds",
                            "Randomize mode requires numeric min/max bounds; ignoring randomize mode.",
                            node_id=node_id,
                            details={"param": param},
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
