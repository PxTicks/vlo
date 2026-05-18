from __future__ import annotations

from typing import Any

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.processors.utils.coerce import coerce_float
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
    return coerce_float(inputs.get(param))


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
    denoise = coerce_float(raw_value)

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

    # If the slider pushes start_step at or past the workflow's baseline split,
    # the first sampler runs zero steps. The first sampler is conventionally
    # the only one with add_noise=enable, so noise would never be introduced
    # unless the second sampler takes over.
    add_noise_ref = rule.get("second_sampler_add_noise")
    if isinstance(add_noise_ref, dict):
        add_noise_node_id = add_noise_ref.get("node_id")
        add_noise_param = add_noise_ref.get("param")
        if not isinstance(add_noise_node_id, str) or not isinstance(
            add_noise_param, str
        ):
            return (
                None,
                None,
                "second_sampler_add_noise must include node_id and param.",
            )
        first_sampler_skipped = start_step_int >= base_split_step_int
        _apply_override(
            overrides,
            add_noise_node_id,
            add_noise_param,
            "enable" if first_sampler_skipped else "disable",
        )

    return overrides, denoise_steps / total_steps_int, None


def _expand_single_sampler_denoise(
    workflow: dict[str, Any],
    rule: dict[str, Any],
    raw_value: Any,
) -> tuple[dict[str, dict[str, Any]] | None, float | None, str | None]:
    total_steps = _read_param_ref_number(workflow, rule.get("total_steps"))
    start_step_ref = rule.get("start_step")
    denoise = coerce_float(raw_value)

    if denoise is None:
        return None, None, "Derived widget value must be numeric."
    if total_steps is None or total_steps <= 0:
        return None, None, "total_steps must resolve to a positive number."
    if not isinstance(start_step_ref, dict):
        return None, None, "start_step must reference a workflow node parameter."

    total_steps_int = max(1, int(round(total_steps)))
    if denoise < -1e-9 or denoise > 1 + 1e-9:
        return None, None, "Denoise must be between 0 and 1."

    bounded_denoise = max(0.0, min(1.0, denoise))
    denoise_steps = int(round(bounded_denoise * total_steps_int))
    denoise_steps = max(0, min(total_steps_int, denoise_steps))
    start_step_int = total_steps_int - denoise_steps

    start_node_id = start_step_ref.get("node_id")
    start_param = start_step_ref.get("param")
    if not isinstance(start_node_id, str) or not isinstance(start_param, str):
        return None, None, "start_step must reference a workflow node parameter."

    overrides: dict[str, dict[str, Any]] = {}
    _apply_override(overrides, start_node_id, start_param, start_step_int)
    return overrides, denoise_steps / total_steps_int, None


_VIDEO_AUDIO_RETAKE_OPTIONS: tuple[str, ...] = ("Video & Audio", "Video", "Audio")


def _expand_video_audio_retake(
    workflow: dict[str, Any],  # noqa: ARG001 (kept for signature symmetry)
    rule: dict[str, Any],
    raw_value: Any,
) -> tuple[dict[str, dict[str, Any]] | None, str | None, str | None]:
    """Map a retake-mode enum selection onto two boolean bypass widgets.

    Returns (widget_overrides, applied_enum_value, error_message).
    """

    if isinstance(raw_value, str):
        mode = raw_value
    else:
        mode = str(raw_value) if raw_value is not None else ""
    if mode not in _VIDEO_AUDIO_RETAKE_OPTIONS:
        return (
            None,
            None,
            f"Retake mode must be one of: {', '.join(_VIDEO_AUDIO_RETAKE_OPTIONS)}.",
        )

    # "Video & Audio" bypasses neither; "Video" bypasses audio retake; "Audio"
    # bypasses video retake. A bypassed side replaces its real mask with a
    # SolidMask, so no retake occurs on that side.
    video_bypass = mode == "Audio"
    audio_bypass = mode == "Video"

    video_ref = rule.get("video_bypass")
    audio_ref = rule.get("audio_bypass")
    for ref_name, ref in (("video_bypass", video_ref), ("audio_bypass", audio_ref)):
        if not isinstance(ref, dict):
            return None, None, f"{ref_name} must reference a workflow node parameter."
        if not isinstance(ref.get("node_id"), str) or not isinstance(
            ref.get("param"), str
        ):
            return None, None, f"{ref_name} must include node_id and param."

    overrides: dict[str, dict[str, Any]] = {}
    _apply_override(overrides, video_ref["node_id"], video_ref["param"], video_bypass)
    _apply_override(overrides, audio_ref["node_id"], audio_ref["param"], audio_bypass)

    return overrides, mode, None


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
            applied_value: Any
            if kind == "dual_sampler_denoise":
                overrides, applied_value, error_message = _expand_dual_sampler_denoise(
                    ctx.workflow,
                    rule,
                    raw_value,
                )
            elif kind == "single_sampler_denoise":
                (
                    overrides,
                    applied_value,
                    error_message,
                ) = _expand_single_sampler_denoise(
                    ctx.workflow,
                    rule,
                    raw_value,
                )
            elif kind == "video_audio_retake":
                overrides, applied_value, error_message = _expand_video_audio_retake(
                    ctx.workflow,
                    rule,
                    raw_value,
                )
            else:
                failures.append(
                    _failure(
                        derived_widget_id,
                        "Derived widget kind is not supported.",
                    )
                )
                continue
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
