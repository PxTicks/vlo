"""Workflow rules helpers.

Provides rule normalization/loading, object_info enrichment, graph rewriting,
and mask-crop pair collection.
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
    PipelineControl,
    ResolvedWorkflowRules,
    WorkflowAspectRatioStage,
    WorkflowMaskProcessingStage,
    WorkflowOutputAssemblyStage,
    WorkflowPipelineStage,
    WorkflowRuleWarningModel,
    WorkflowRulesResponse,
)
from services.workflow_rules.validation import (
    WorkflowValidationError,
    evaluate_input_validation,
    find_unsatisfied_input_conditions,
    matches_input_presence_condition,
)

__all__ = [
    "WorkflowPrompt",
    "WorkflowRuleWarning",
    "WorkflowRuleWarningModel",
    "WorkflowRules",
    "WorkflowRulesResponse",
    "WorkflowValidationError",
    "PipelineControl",
    "ResolvedWorkflowRules",
    "WorkflowAspectRatioStage",
    "WorkflowMaskProcessingStage",
    "WorkflowOutputAssemblyStage",
    "WorkflowPipelineStage",
    "apply_rules_to_workflow",
    "collect_mask_crop_pairs",
    "default_rules",
    "default_rules_model",
    "enrich_rules_with_object_info",
    "evaluate_input_validation",
    "find_unsatisfied_input_conditions",
    "load_rules_model_for_workflow",
    "load_rules_for_workflow",
    "matches_input_presence_condition",
    "normalize_rules_model",
    "normalize_rules",
    "sidecar_path_for_workflow",
]
