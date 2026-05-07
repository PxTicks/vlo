from __future__ import annotations

import math
from typing import Any

from services.workflow_rules.condition_eval import (
    compare_values,
    resolve_input_metadata_field,
)
from services.workflow_rules.normalize import WorkflowRules
from services.workflow_rules.schema.models import (
    DEFAULT_PIPELINE_STAGE_AFTER_BY_KIND,
)


PipelineControlResolutionWarning = dict[str, Any]


def _warning(
    code: str,
    message: str,
    *,
    stage_id: str | None = None,
    control_key: str | None = None,
    details: dict[str, Any] | None = None,
) -> PipelineControlResolutionWarning:
    warning: PipelineControlResolutionWarning = {
        "code": code,
        "message": message,
    }
    if stage_id is not None:
        warning["stage_id"] = stage_id
    if control_key is not None:
        warning["control_key"] = control_key
    if details:
        warning["details"] = details
    return warning


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
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    return None


def _resolve_stage_reference_ids(
    ref: Any,
    stages: list[dict[str, Any]],
) -> list[str]:
    if not isinstance(ref, str):
        return []

    stripped = ref.strip()
    if not stripped:
        return []

    stage_ids = [
        stage.get("id")
        for stage in stages
        if isinstance(stage.get("id"), str) and stage.get("id")
    ]
    if stripped in stage_ids:
        return [stripped]

    return [
        stage["id"]
        for stage in stages
        if isinstance(stage.get("id"), str)
        and stage.get("kind") == stripped
    ]


def iter_pipeline_stages(rules: WorkflowRules | None) -> list[dict[str, Any]]:
    if not isinstance(rules, dict):
        return []
    pipeline = rules.get("pipeline")
    if not isinstance(pipeline, list):
        return []

    stages = [stage for stage in pipeline if isinstance(stage, dict)]
    stage_lookup = {
        stage["id"]: stage
        for stage in stages
        if isinstance(stage.get("id"), str) and stage.get("id")
    }
    if not stage_lookup:
        return stages

    dependencies: dict[str, set[str]] = {stage_id: set() for stage_id in stage_lookup}
    for stage in stages:
        stage_id = stage.get("id")
        if not isinstance(stage_id, str) or not stage_id:
            continue

        after_refs = stage.get("after")
        if isinstance(after_refs, list):
            for after_ref in after_refs:
                for dependency_id in _resolve_stage_reference_ids(after_ref, stages):
                    if dependency_id != stage_id:
                        dependencies[stage_id].add(dependency_id)

        for required_kind in DEFAULT_PIPELINE_STAGE_AFTER_BY_KIND.get(
            str(stage.get("kind")),
            (),
        ):
            for dependency_stage in stages:
                dependency_id = dependency_stage.get("id")
                if (
                    dependency_stage.get("kind") == required_kind
                    and isinstance(dependency_id, str)
                    and dependency_id
                    and dependency_id != stage_id
                ):
                    dependencies[stage_id].add(dependency_id)

    ordered: list[dict[str, Any]] = []
    remaining = set(stage_lookup)
    while remaining:
        ready_ids = [
            stage.get("id")
            for stage in stages
            if isinstance(stage.get("id"), str)
            and stage.get("id") in remaining
            and dependencies.get(stage["id"], set()).issubset(set(ordered_stage["id"] for ordered_stage in ordered))
        ]
        if not ready_ids:
            # Rules validation should prevent this; keep authored order as a safe fallback.
            return stages

        next_stage_id = str(ready_ids[0])
        ordered.append(stage_lookup[next_stage_id])
        remaining.remove(next_stage_id)

    return ordered


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


def compare_control_value(current: Any, operator: str, expected: Any) -> bool:
    return compare_values(current, operator, expected)


def _control_is_client_authored(control: dict[str, Any]) -> bool:
    # Authorship is stated explicitly on every control (see `source` field on
    # PipelineControl). Widgets always imply client authorship via the schema
    # validator; non-widget controls must declare `source` explicitly.
    source = control.get("source")
    if source == "client":
        return True
    if source == "backend":
        return False
    # Fallback for raw dicts that bypass the model (tests, legacy): honour the
    # widget shortcut so callers constructing minimal rules still work.
    return control.get("expose") == "widget"


def _validate_control_value(
    value: Any,
    control: dict[str, Any],
    *,
    fallback_options: list[Any] | None = None,
) -> tuple[bool, Any]:
    allowed_options = resolve_control_options(control, fallback_options=fallback_options)
    if allowed_options and value not in allowed_options:
        return False, value

    value_type = control.get("value_type")
    if value_type == "boolean":
        parsed = _coerce_boolean(value)
        if parsed is None:
            return False, value
        return True, parsed

    if value_type == "int":
        if isinstance(value, bool):
            return False, value
        if isinstance(value, int):
            parsed_value = value
        elif isinstance(value, float):
            if not value.is_integer():
                return False, value
            parsed_value = int(value)
        elif isinstance(value, str) and value.strip():
            try:
                parsed_value = int(value.strip())
            except ValueError:
                return False, value
        else:
            return False, value
        minimum = control.get("min")
        maximum = control.get("max")
        if isinstance(minimum, (int, float)) and parsed_value < minimum:
            return False, value
        if isinstance(maximum, (int, float)) and parsed_value > maximum:
            return False, value
        return True, parsed_value

    if value_type == "float":
        parsed_value = _coerce_numeric(value)
        if parsed_value is None:
            return False, value
        minimum = control.get("min")
        maximum = control.get("max")
        if isinstance(minimum, (int, float)) and parsed_value < minimum:
            return False, value
        if isinstance(maximum, (int, float)) and parsed_value > maximum:
            return False, value
        return True, parsed_value

    if value_type == "string":
        if not isinstance(value, str):
            return False, value
        return True, value

    if value_type == "enum":
        if allowed_options:
            return (value in allowed_options), value
        return True, value

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = control.get("min")
        maximum = control.get("max")
        if isinstance(minimum, (int, float)) and float(value) < minimum:
            return False, value
        if isinstance(maximum, (int, float)) and float(value) > maximum:
            return False, value
    return True, value


def resolve_pipeline_control_values_with_warnings(
    rules: WorkflowRules | None,
    workflow: dict[str, Any],
    pipeline_inputs: dict[str, dict[str, Any]] | None,
    *,
    control_option_fallbacks: dict[tuple[str, str], list[Any]] | None = None,
    input_metadata: dict[str, Any] | None = None,
) -> tuple[dict[str, dict[str, Any]], list[PipelineControlResolutionWarning]]:
    resolved: dict[str, dict[str, Any]] = {}
    submitted = pipeline_inputs or {}
    fallbacks = control_option_fallbacks or {}
    metadata = input_metadata or {}
    warnings: list[PipelineControlResolutionWarning] = []
    emitted_warning_keys: set[tuple[Any, ...]] = set()

    stages = iter_pipeline_stages(rules)
    control_lookup: dict[tuple[str, str], dict[str, Any]] = {}
    for stage in stages:
        stage_id = stage.get("id")
        if not isinstance(stage_id, str) or not stage_id:
            continue
        for control in get_stage_controls(stage):
            key = control.get("key")
            if isinstance(key, str) and key:
                control_lookup[(stage_id, key)] = control

    resolving: set[tuple[str, str]] = set()

    def emit_once(
        key: tuple[Any, ...],
        warning: PipelineControlResolutionWarning,
    ) -> None:
        if key in emitted_warning_keys:
            return
        emitted_warning_keys.add(key)
        warnings.append(warning)

    def resolve_reference_value(ref: Any) -> Any:
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
            target_stage_id = ref.get("stage_id")
            target_key = ref.get("key")
            if not isinstance(target_stage_id, str) or not isinstance(target_key, str):
                return None
            if (target_stage_id, target_key) not in control_lookup:
                emit_once(
                    ("missing_ref", target_stage_id, target_key),
                    _warning(
                        "pipeline_control_reference_missing",
                        "Pipeline control reference points to a missing control",
                        stage_id=target_stage_id,
                        control_key=target_key,
                    ),
                )
                return None
            return resolve_control_value(target_stage_id, target_key)

        if ref_kind == "input_metadata":
            return resolve_input_metadata_field(
                metadata,
                ref.get("input"),
                ref.get("field"),
            )

        return None

    def resolve_control_value(stage_id: str, key: str) -> Any:
        stage_values = resolved.setdefault(stage_id, {})
        if key in stage_values:
            return stage_values[key]

        control_id = (stage_id, key)
        control = control_lookup.get(control_id)
        if control is None:
            return None

        if control_id in resolving:
            emit_once(
                ("cycle", stage_id, key),
                _warning(
                    "pipeline_control_reference_cycle",
                    "Pipeline controls contain a reference cycle",
                    stage_id=stage_id,
                    control_key=key,
                ),
            )
            return None

        resolving.add(control_id)
        fallback_options = fallbacks.get(control_id)
        stage_inputs = submitted.get(stage_id)
        if not isinstance(stage_inputs, dict):
            stage_inputs = {}

        value: Any = None
        submitted_present = key in stage_inputs
        if submitted_present and _control_is_client_authored(control):
            is_valid, submitted_value = _validate_control_value(
                stage_inputs[key],
                control,
                fallback_options=fallback_options,
            )
            if is_valid:
                value = submitted_value
            else:
                emit_once(
                    ("invalid_submission", stage_id, key, repr(stage_inputs[key])),
                    _warning(
                        "invalid_pipeline_control_submission",
                        "Ignoring invalid submitted pipeline control value",
                        stage_id=stage_id,
                        control_key=key,
                        details={"value": stage_inputs[key]},
                    ),
                )
        elif submitted_present:
            emit_once(
                ("ignored_submission", stage_id, key),
                _warning(
                    "ignored_pipeline_control_submission",
                    "Ignoring submitted value for a non-client-settable pipeline control",
                    stage_id=stage_id,
                    control_key=key,
                ),
            )

        if value is None and isinstance(control.get("bind"), dict):
            bound_value = resolve_reference_value(control["bind"])
            is_valid, normalized_value = _validate_control_value(
                bound_value,
                control,
                fallback_options=fallback_options,
            )
            if is_valid:
                value = normalized_value
            elif bound_value is not None:
                emit_once(
                    ("invalid_bound_value", stage_id, key, repr(bound_value)),
                    _warning(
                        "invalid_pipeline_control_value",
                        "Resolved pipeline control binding produced an invalid value",
                        stage_id=stage_id,
                        control_key=key,
                        details={"source": "bind", "value": bound_value},
                    ),
                )

        if value is None:
            for default_rule in control.get("default_rules") or []:
                if not isinstance(default_rule, dict):
                    continue
                when = default_rule.get("when")
                if not isinstance(when, dict):
                    continue
                if not compare_control_value(
                    resolve_reference_value(when.get("ref")),
                    str(when.get("operator", "eq")),
                    when.get("value"),
                ):
                    continue
                rule_value = default_rule.get("value")
                is_valid, normalized_value = _validate_control_value(
                    rule_value,
                    control,
                    fallback_options=fallback_options,
                )
                if is_valid:
                    value = normalized_value
                    break
                emit_once(
                    ("invalid_default_rule_value", stage_id, key, repr(rule_value)),
                    _warning(
                        "invalid_pipeline_control_value",
                        "Pipeline control default rule produced an invalid value",
                        stage_id=stage_id,
                        control_key=key,
                        details={"source": "default_rule", "value": rule_value},
                    ),
                )

        if value is None and "default" in control:
            default_value = control.get("default")
            is_valid, normalized_value = _validate_control_value(
                default_value,
                control,
                fallback_options=fallback_options,
            )
            if is_valid:
                value = normalized_value
            elif default_value is not None:
                emit_once(
                    ("invalid_default_value", stage_id, key, repr(default_value)),
                    _warning(
                        "invalid_pipeline_control_value",
                        "Pipeline control default is invalid",
                        stage_id=stage_id,
                        control_key=key,
                        details={"source": "default", "value": default_value},
                    ),
                )

        if value is None:
            allowed_options = resolve_control_options(
                control,
                fallback_options=fallback_options,
            )
            if allowed_options:
                value = allowed_options[0]

        stage_values[key] = value
        resolving.remove(control_id)
        return value

    for stage in stages:
        stage_id = stage.get("id")
        if not isinstance(stage_id, str) or not stage_id:
            continue
        stage_values = resolved.setdefault(stage_id, {})
        for control in get_stage_controls(stage):
            key = control.get("key")
            if not isinstance(key, str) or not key:
                continue
            stage_values[key] = resolve_control_value(stage_id, key)

    return resolved, warnings


def resolve_pipeline_control_values(
    rules: WorkflowRules | None,
    workflow: dict[str, Any],
    pipeline_inputs: dict[str, dict[str, Any]] | None,
    *,
    control_option_fallbacks: dict[tuple[str, str], list[Any]] | None = None,
    input_metadata: dict[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    resolved, _warnings = resolve_pipeline_control_values_with_warnings(
        rules,
        workflow,
        pipeline_inputs,
        control_option_fallbacks=control_option_fallbacks,
        input_metadata=input_metadata,
    )
    return resolved


__all__ = [
    "PipelineControlResolutionWarning",
    "compare_control_value",
    "find_pipeline_stage",
    "find_stage_control",
    "get_stage_controls",
    "iter_pipeline_stages",
    "resolve_control_options",
    "resolve_pipeline_control_values",
    "resolve_pipeline_control_values_with_warnings",
]
