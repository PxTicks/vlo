from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from services.workflow_rules.derived_mask_video_treatment import (
    parse_derived_mask_source_video_treatment,
)
from services.workflow_rules.schema import (
    ResolvedWorkflowRules,
    WorkflowRuleWarningModel,
    default_resolved_rules_model,
    dump_resolved_rules,
    dump_warning_models,
    validation_warnings_from_error,
)


WorkflowRuleWarning = dict[str, Any]
WorkflowRules = dict[str, Any]
WorkflowPrompt = dict[str, Any]


def _warning(
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
) -> WorkflowRuleWarning:
    warning: WorkflowRuleWarning = {
        "code": code,
        "message": message,
    }
    if details:
        warning["details"] = details
    return warning


def _to_bool(value: Any, fallback: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    return fallback


def _to_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("-"):
            return None
        if stripped.isdigit():
            return int(stripped)
    return None


def default_rules() -> WorkflowRules:
    return dump_resolved_rules(default_resolved_rules_model())


def default_rules_model() -> ResolvedWorkflowRules:
    return default_resolved_rules_model()


def _normalize_source_video_treatment_value(
    value: Any,
    *,
    path: list[str],
    warnings: list[WorkflowRuleWarningModel],
) -> Any:
    if not isinstance(value, str):
        return value

    normalized = parse_derived_mask_source_video_treatment(value)
    if normalized is None:
        warnings.append(
            WorkflowRuleWarningModel(
                code="invalid_source_video_treatment_value",
                message=(
                    "Mask source-video treatment value is invalid and may fall back at runtime"
                ),
                details={"path": path, "value": value},
            )
        )
        return value

    if normalized != value:
        warnings.append(
            WorkflowRuleWarningModel(
                code="normalized_source_video_treatment_value",
                message="Normalized legacy source-video treatment alias in workflow rules",
                details={"path": path, "from": value, "to": normalized},
            )
        )
    return normalized


def _normalize_source_video_treatment_list(
    value: Any,
    *,
    path: list[str],
    warnings: list[WorkflowRuleWarningModel],
) -> Any:
    if not isinstance(value, list):
        return value

    normalized_items: list[Any] = []
    for index, item in enumerate(value):
        normalized = _normalize_source_video_treatment_value(
            item,
            path=[*path, str(index)],
            warnings=warnings,
        )
        if normalized in normalized_items:
            continue
        normalized_items.append(normalized)
    return normalized_items


def _normalize_pipeline_control_aliases(
    raw_rules: Any,
) -> tuple[Any, list[WorkflowRuleWarningModel]]:
    if not isinstance(raw_rules, dict):
        return raw_rules, []

    normalized_rules = deepcopy(raw_rules)
    warnings: list[WorkflowRuleWarningModel] = []
    pipeline = normalized_rules.get("pipeline")
    if not isinstance(pipeline, list):
        return normalized_rules, warnings

    for stage_index, stage in enumerate(pipeline):
        if not isinstance(stage, dict) or stage.get("kind") != "mask_processing":
            continue

        controls = stage.get("controls")
        if not isinstance(controls, list):
            continue

        for control_index, control in enumerate(controls):
            if not isinstance(control, dict):
                continue
            if control.get("key") != "source_video_treatment":
                continue

            control_path = ["pipeline", str(stage_index), "controls", str(control_index)]

            if "default" in control:
                control["default"] = _normalize_source_video_treatment_value(
                    control.get("default"),
                    path=[*control_path, "default"],
                    warnings=warnings,
                )

            for list_key in ("options", "include_options", "exclude_options"):
                if list_key in control:
                    control[list_key] = _normalize_source_video_treatment_list(
                        control.get(list_key),
                        path=[*control_path, list_key],
                        warnings=warnings,
                    )

            default_rules = control.get("default_rules")
            if not isinstance(default_rules, list):
                continue
            for default_rule_index, default_rule in enumerate(default_rules):
                if not isinstance(default_rule, dict) or "value" not in default_rule:
                    continue
                default_rule["value"] = _normalize_source_video_treatment_value(
                    default_rule.get("value"),
                    path=[
                        *control_path,
                        "default_rules",
                        str(default_rule_index),
                        "value",
                    ],
                    warnings=warnings,
                )

    return normalized_rules, warnings


def sidecar_path_for_workflow(workflows_dir: Path, workflow_filename: str) -> Path:
    workflow_path = Path(workflow_filename)
    if workflow_path.suffix.lower() == ".json":
        sidecar_name = f"{workflow_path.stem}.rules.json"
    else:
        sidecar_name = f"{workflow_path.name}.rules.json"
    return workflows_dir / sidecar_name


def normalize_rules_model(
    raw: Any,
) -> tuple[ResolvedWorkflowRules, list[WorkflowRuleWarningModel]]:
    if raw is None:
        return default_resolved_rules_model(), []

    if isinstance(raw, ResolvedWorkflowRules):
        return raw, []

    if not isinstance(raw, dict):
        return (
            default_resolved_rules_model(),
            [
                WorkflowRuleWarningModel(
                    code="invalid_rules",
                    message="Workflow rules must be an object",
                )
            ],
        )

    normalized_raw, normalization_warnings = _normalize_pipeline_control_aliases(raw)

    try:
        return ResolvedWorkflowRules.model_validate(normalized_raw), normalization_warnings
    except ValidationError as exc:
        return (
            default_resolved_rules_model(),
            [
                *normalization_warnings,
                *validation_warnings_from_error(
                    exc,
                    code="invalid_workflow_rules",
                    message_prefix="Workflow rules are invalid",
                ),
            ],
        )


def normalize_rules(raw: Any) -> tuple[WorkflowRules, list[WorkflowRuleWarning]]:
    rules_model, warning_models = normalize_rules_model(raw)
    return dump_resolved_rules(rules_model), dump_warning_models(warning_models)


def _resolve_sidecar_path(
    workflows_dir: Path,
    workflow_filename: str,
    fallback_dirs: list[Path] | None = None,
) -> Path | None:
    primary = sidecar_path_for_workflow(workflows_dir, workflow_filename)
    if primary.exists():
        return primary

    for fallback_dir in fallback_dirs or []:
        candidate = sidecar_path_for_workflow(fallback_dir, workflow_filename)
        if candidate.exists():
            return candidate

    return None


def load_rules_model_for_workflow(
    workflows_dir: Path,
    workflow_filename: str,
    *,
    fallback_dirs: list[Path] | None = None,
) -> tuple[ResolvedWorkflowRules, list[WorkflowRuleWarningModel]]:
    sidecar_path = _resolve_sidecar_path(
        workflows_dir,
        workflow_filename,
        fallback_dirs=fallback_dirs,
    )
    if sidecar_path is None:
        return default_resolved_rules_model(), []

    try:
        raw_text = sidecar_path.read_text(encoding="utf-8")
    except OSError as exc:
        return (
            default_resolved_rules_model(),
            [
                WorkflowRuleWarningModel(
                    code="rules_read_failed",
                    message=f"Failed to read workflow rules: {exc}",
                    details={"path": str(sidecar_path)},
                )
            ],
        )

    try:
        raw_rules = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        return (
            default_resolved_rules_model(),
            [
                WorkflowRuleWarningModel(
                    code="invalid_rules_json",
                    message=f"Workflow rules JSON is invalid: {exc.msg}",
                    details={"path": str(sidecar_path)},
                )
            ],
        )

    rules_model, warnings = normalize_rules_model(raw_rules)
    return rules_model, warnings


def load_rules_for_workflow(
    workflows_dir: Path,
    workflow_filename: str,
    *,
    fallback_dirs: list[Path] | None = None,
) -> tuple[WorkflowRules, list[WorkflowRuleWarning]]:
    rules_model, warning_models = load_rules_model_for_workflow(
        workflows_dir,
        workflow_filename,
        fallback_dirs=fallback_dirs,
    )
    return dump_resolved_rules(rules_model), dump_warning_models(warning_models)


__all__ = [
    "WorkflowPrompt",
    "WorkflowRuleWarning",
    "WorkflowRules",
    "default_rules",
    "default_rules_model",
    "load_rules_model_for_workflow",
    "load_rules_for_workflow",
    "normalize_rules",
    "normalize_rules_model",
    "sidecar_path_for_workflow",
]
