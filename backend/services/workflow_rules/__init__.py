"""Workflow rules helpers.

Provides rule normalization/loading, object_info enrichment, graph rewriting,
and mask-crop pair collection while preserving the legacy
``services.workflow_rules`` import surface.
"""

from services.workflow_rules.graph_rewrite import (
    apply_rules_to_workflow,
)
from services.workflow_rules.mask_pairs import collect_mask_crop_pairs
from services.workflow_rules.normalize import (
    WorkflowPrompt,
    WorkflowRuleWarning,
    WorkflowRules,
    default_rules,
    default_rules_model,
    load_rules_model_for_workflow,
    load_rules_for_workflow,
    normalize_rules_model,
    normalize_rules,
    sidecar_path_for_workflow,
)
from services.workflow_rules.object_info import enrich_rules_with_object_info
from services.workflow_rules.schema import (
    AuthoredWorkflowRulesV1,
    AuthoredWorkflowRulesV2,
    ResolvedWorkflowRules,
    WorkflowRuleWarningModel,
    WorkflowRulesResponse,
    migrate_authored_v1_to_v2,
)
from services.workflow_rules.validation import (
    WorkflowValidationError,
    evaluate_input_validation,
    find_unsatisfied_input_conditions,
)

__all__ = [
    "WorkflowPrompt",
    "WorkflowRuleWarning",
    "WorkflowRuleWarningModel",
    "WorkflowRules",
    "WorkflowRulesResponse",
    "WorkflowValidationError",
    "AuthoredWorkflowRulesV1",
    "AuthoredWorkflowRulesV2",
    "ResolvedWorkflowRules",
    "apply_rules_to_workflow",
    "collect_mask_crop_pairs",
    "default_rules",
    "default_rules_model",
    "enrich_rules_with_object_info",
    "evaluate_input_validation",
    "find_unsatisfied_input_conditions",
    "load_rules_model_for_workflow",
    "load_rules_for_workflow",
    "migrate_authored_v1_to_v2",
    "normalize_rules_model",
    "normalize_rules",
    "sidecar_path_for_workflow",
]
