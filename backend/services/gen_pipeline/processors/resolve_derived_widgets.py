from __future__ import annotations

from typing import Any

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.types import Processor, ProcessorMeta
from services.workflow_rules import WorkflowValidationError


DERIVED_WIDGET_NODE_ID_PREFIX = "derived:"
DERIVED_WIDGET_VALUE_PARAM = "__value"


def _failure(derived_widget_id: str, message: str) -> dict[str, Any]:
    return {
        "kind": "derived_widget",
        "derived_widget_id": derived_widget_id,
        "message": message,
    }


def _coerce_number(value: Any) -> float | None:
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


def _read_param_ref_number(
    workflow: dict[str, Any],
    ref: Any,
) -> float | None:
    if not isinstance(ref, dict):
        return None
    node_id = ref.get("node_id")
    param = ref.get("param")
    if not isinstance(node_id, str) or not isinstance(param, str):
        return None
    node = workflow.get(node_id)
    if not isinstance(node, dict):
        return None
    inputs = node.get("inputs")
    if not isinstance(inputs, dict):
        return None
    return _coerce_number(inputs.get(param))


def _apply_override(
    widget_overrides: dict[str, dict[str, Any]],
    node_id: str,
    param: str,
    value: Any,
) -> None:
    widget_overrides.setdefault(node_id, {})[param] = value


def _expand_dual_sampler_denoise(
    workflow: dict[str, Any],
    rule: dict[str, Any],
    raw_value: Any,
) -> tuple[dict[str, dict[str, Any]] | None, float | None, str | None]:
    total_steps = _read_param_ref_number(workflow, rule.get("total_steps"))
    start_step_ref = rule.get("start_step")
    start_step = _read_param_ref_number(workflow, start_step_ref)
    base_split_step = _read_param_ref_number(workflow, rule.get("base_split_step"))
    denoise = _coerce_number(raw_value)

    if denoise is None:
        return None, None, "Derived widget value must be numeric."
    if total_steps is None or total_steps <= 0:
        return None, None, "total_steps must resolve to a positive number."
    if start_step is None:
        return None, None, "start_step must resolve to a numeric workflow value."
    if base_split_step is None:
        return None, None, "base_split_step must resolve to a numeric workflow value."
    if not isinstance(start_step_ref, dict):
        return None, None, "start_step must reference a workflow node parameter."

    total_steps_int = max(1, int(round(total_steps)))
    min_denoise = 1 / total_steps_int
    if denoise < (min_denoise - 1e-9) or denoise > 1 + 1e-9:
        return (
            None,
            None,
            f"Denoise must be between {min_denoise:g} and 1.",
        )

    # 1. Convert the UI denoise fraction into an integer denoise-step count.
    denoise_steps = int(round(max(min_denoise, min(1.0, denoise)) * total_steps_int))
    denoise_steps = max(1, min(total_steps_int, denoise_steps))

    # 2. Derive the raw start/split widgets while preserving the workflow's
    #    baseline split as the minimum safe handoff point between samplers.
    start_step_int = total_steps_int - denoise_steps
    base_split_step_int = max(0, int(round(base_split_step)))
    split_step_int = max(base_split_step_int, start_step_int)
    split_step_int = min(total_steps_int, split_step_int)

    start_node_id = start_step_ref.get("node_id")
    start_param = start_step_ref.get("param")
    if not isinstance(start_node_id, str) or not isinstance(start_param, str):
        return None, None, "start_step must reference a workflow node parameter."

    overrides: dict[str, dict[str, Any]] = {}
    _apply_override(overrides, start_node_id, start_param, start_step_int)

    split_step_targets = rule.get("split_step_targets")
    if not isinstance(split_step_targets, list) or len(split_step_targets) == 0:
        return None, None, "split_step_targets must contain at least one target."

    for target in split_step_targets:
        if not isinstance(target, dict):
            return None, None, "split_step_targets entries must be objects."
        target_node_id = target.get("node_id")
        target_param = target.get("param")
        if not isinstance(target_node_id, str) or not isinstance(target_param, str):
            return (
                None,
                None,
                "split_step_targets entries must include node_id and param.",
            )
        _apply_override(overrides, target_node_id, target_param, split_step_int)

    return overrides, denoise_steps / total_steps_int, None


class _ResolveDerivedWidgetsProcessor:
    meta = ProcessorMeta(
        name="resolve_derived_widgets",
        reads=("workflow", "rules", "derived_widget_values", "widget_overrides"),
        writes=("widget_overrides", "applied_widget_values"),
        description="Expands derived widget values into raw widget overrides before widget validation",
    )

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return bool(ctx.derived_widget_values)

    async def execute(self, ctx: BackendPipelineContext) -> None:
        failures: list[dict[str, Any]] = []
        raw_rules = ctx.rules.get("derived_widgets")
        derived_rules = raw_rules if isinstance(raw_rules, list) else []
        rules_by_id = {
            rule["id"]: rule
            for rule in derived_rules
            if isinstance(rule, dict) and isinstance(rule.get("id"), str)
        }

        for derived_widget_id, raw_value in ctx.derived_widget_values.items():
            rule = rules_by_id.get(derived_widget_id)
            if not isinstance(rule, dict):
                failures.append(
                    _failure(
                        derived_widget_id,
                        "Derived widget is not defined by workflow rules.",
                    )
                )
                continue

            kind = rule.get("kind")
            if kind != "dual_sampler_denoise":
                failures.append(
                    _failure(
                        derived_widget_id,
                        "Derived widget kind is not supported.",
                    )
                )
                continue

            overrides, applied_value, error_message = _expand_dual_sampler_denoise(
                ctx.workflow,
                rule,
                raw_value,
            )
            if error_message:
                failures.append(_failure(derived_widget_id, error_message))
                continue
            if overrides is None or applied_value is None:
                failures.append(
                    _failure(
                        derived_widget_id,
                        "Derived widget could not be expanded.",
                    )
                )
                continue

            for node_id, params in overrides.items():
                for param, value in params.items():
                    _apply_override(ctx.widget_overrides, node_id, param, value)

            ctx.applied_widget_values[
                f"{DERIVED_WIDGET_NODE_ID_PREFIX}{derived_widget_id}:{DERIVED_WIDGET_VALUE_PARAM}"
            ] = str(applied_value)

        if failures:
            raise WorkflowValidationError(
                failures[0]["message"],
                failures=failures,
            )


resolve_derived_widgets_processor: Processor = _ResolveDerivedWidgetsProcessor()


__all__ = ["resolve_derived_widgets_processor"]
