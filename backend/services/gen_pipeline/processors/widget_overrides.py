from __future__ import annotations

import random
from typing import Any

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.types import Processor, ProcessorMeta


UINT64_MAX = (1 << 64) - 1


def _coerce_number(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            if "." in stripped or "e" in stripped.lower():
                return float(stripped)
            return int(stripped)
        except ValueError:
            return None
    return None


def _randomize_from_bounds(
    min_value: Any,
    max_value: Any,
) -> int | float | None:
    min_num = _coerce_number(min_value)
    max_num = _coerce_number(max_value)
    if min_num is None or max_num is None:
        return None

    min_is_int = isinstance(min_num, int) or (
        isinstance(min_num, float) and min_num.is_integer()
    )
    max_is_int = isinstance(max_num, int) or (
        isinstance(max_num, float) and max_num.is_integer()
    )
    if min_is_int and max_is_int:
        low = int(min_num)
        high = int(max_num)
        if low > high:
            return None
        if low >= 0 and high > UINT64_MAX:
            high = UINT64_MAX
        return random.randint(low, high)

    low_f = float(min_num)
    high_f = float(max_num)
    if low_f > high_f:
        return None
    return random.uniform(low_f, high_f)


def _apply_widget_modes(ctx: BackendPipelineContext) -> None:
    if not ctx.widget_modes:
        return

    nodes_rules = ctx.rules.get("nodes", {})
    if not isinstance(nodes_rules, dict):
        return

    for node_id, param_modes in ctx.widget_modes.items():
        if not isinstance(param_modes, dict):
            continue
        node = ctx.workflow.get(node_id)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue

        node_rule = nodes_rules.get(node_id, {})
        widget_defs = node_rule.get("widgets") if isinstance(node_rule, dict) else None

        for param, mode in param_modes.items():
            if mode != "randomize":
                continue
            if not isinstance(widget_defs, dict):
                ctx.warnings.append(
                    {
                        "code": "widget_randomize_missing_rule",
                        "message": "Widget randomize mode requested but widget rule was not found",
                        "node_id": node_id,
                        "details": {"param": param},
                    }
                )
                continue

            widget_rule = widget_defs.get(param)
            if not isinstance(widget_rule, dict):
                ctx.warnings.append(
                    {
                        "code": "widget_randomize_missing_rule",
                        "message": "Widget randomize mode requested but widget rule was not found",
                        "node_id": node_id,
                        "details": {"param": param},
                    }
                )
                continue

            if not bool(widget_rule.get("control_after_generate")):
                continue

            randomized = _randomize_from_bounds(
                widget_rule.get("min"),
                widget_rule.get("max"),
            )
            if randomized is None:
                ctx.warnings.append(
                    {
                        "code": "widget_randomize_invalid_bounds",
                        "message": "Widget randomize mode requested but min/max bounds are invalid",
                        "node_id": node_id,
                        "details": {
                            "param": param,
                            "min": widget_rule.get("min"),
                            "max": widget_rule.get("max"),
                        },
                    }
                )
                continue

            inputs[param] = randomized


def _collect_applied_widget_values(
    workflow: dict[str, Any],
    widget_overrides: dict[str, dict[str, Any]],
    widget_modes: dict[str, dict[str, str]],
) -> dict[str, str]:
    tracked: dict[str, set[str]] = {}
    for node_id, params in widget_overrides.items():
        tracked.setdefault(node_id, set()).update(params.keys())
    for node_id, param_modes in widget_modes.items():
        tracked.setdefault(node_id, set()).update(param_modes.keys())

    result: dict[str, str] = {}
    for node_id, params in tracked.items():
        node = workflow.get(node_id)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for param in params:
            value = inputs.get(param)
            if value is None:
                continue
            result[f"{node_id}:{param}"] = str(value)
    return result


class _WidgetOverridesProcessor:
    meta = ProcessorMeta(
        name="widget_overrides",
        reads=("workflow", "widget_overrides", "widget_modes", "rules"),
        writes=("workflow", "warnings", "applied_widget_values"),
        description="Applies widget overrides and randomize modes, then records the final widget values",
    )

    def is_active(self, ctx: BackendPipelineContext) -> bool:
        return bool(ctx.widget_overrides) or bool(ctx.widget_modes)

    async def execute(self, ctx: BackendPipelineContext) -> None:
        for node_id, overrides in ctx.widget_overrides.items():
            node = ctx.workflow.get(node_id)
            if not isinstance(node, dict):
                continue
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                continue
            for param, value in overrides.items():
                inputs[param] = value

        _apply_widget_modes(ctx)
        ctx.applied_widget_values = {
            **ctx.applied_widget_values,
            **_collect_applied_widget_values(
                ctx.workflow,
                ctx.widget_overrides,
                ctx.widget_modes,
            ),
        }


widget_overrides_processor: Processor = _WidgetOverridesProcessor()


__all__ = ["widget_overrides_processor"]
