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
    load_rules_for_workflow,
    normalize_rules,
    sidecar_path_for_workflow,
)
from services.workflow_rules.object_info import enrich_rules_with_object_info
from services.workflow_rules.validation import (
    WorkflowValidationError,
    evaluate_input_validation,
    find_unsatisfied_input_conditions,
)

__all__ = [
    "WorkflowPrompt",
    "WorkflowRuleWarning",
    "WorkflowRules",
    "WorkflowValidationError",
    "apply_rules_to_workflow",
    "collect_mask_crop_pairs",
    "default_rules",
    "enrich_rules_with_object_info",
    "evaluate_input_validation",
    "find_unsatisfied_input_conditions",
    "load_rules_for_workflow",
    "normalize_rules",
    "sidecar_path_for_workflow",
]
