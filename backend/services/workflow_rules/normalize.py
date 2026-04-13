from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import ValidationError

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

    try:
        return ResolvedWorkflowRules.model_validate(raw), []
    except ValidationError as exc:
        return (
            default_resolved_rules_model(),
            validation_warnings_from_error(
                exc,
                code="invalid_workflow_rules",
                message_prefix="Workflow rules are invalid",
            ),
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
