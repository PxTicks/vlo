import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.workflow_rules.condition_eval import (
    ConditionState,
    compare_values,
    evaluate_condition,
    resolve_state_reference,
)
from services.workflow_rules.schema import ResolvedWorkflowRules


def test_condition_combinators_mix_leaves():
    state = ConditionState(
        provided_input_ids=frozenset({"image"}),
        frontend_control_values={"enabled": True},
    )

    assert evaluate_condition(
        {
            "kind": "all_of",
            "conditions": [
                {"kind": "input_presence", "inputs": ["image"]},
                {
                    "kind": "compare",
                    "ref": {"kind": "frontend_control", "control_id": "enabled"},
                    "value": True,
                },
            ],
        },
        state,
    )
    assert evaluate_condition(
        {
            "kind": "any_of",
            "conditions": [
                {"kind": "input_presence", "inputs": ["missing"]},
                {"kind": "always"},
            ],
        },
        state,
    )
    assert evaluate_condition(
        {
            "kind": "not",
            "condition": {"kind": "input_presence", "inputs": ["missing"]},
        },
        state,
    )


def test_state_reference_kinds_resolve_from_their_state_bags():
    state = ConditionState(
        workflow={"10": {"inputs": {"denoise": 0.5}}},
        pipeline_control_values={"mask_processing": {"enabled": False}},
        frontend_control_values={"prompt_enhancer_enabled": True},
        derived_widget_values={"single_sampler_denoise": 0.75},
        input_metadata={
            "89": {
                "sourceKind": "timeline_selection",
                "timelineSelection": {
                    "durationSeconds": 6,
                },
            }
        },
    )

    assert (
        resolve_state_reference(
            {"kind": "workflow_param", "node_id": "10", "param": "denoise"},
            state,
        )
        == 0.5
    )
    assert (
        resolve_state_reference(
            {
                "kind": "pipeline_control",
                "stage_id": "mask_processing",
                "key": "enabled",
            },
            state,
        )
        is False
    )
    assert (
        resolve_state_reference(
            {
                "kind": "frontend_control",
                "control_id": "prompt_enhancer_enabled",
            },
            state,
        )
        is True
    )
    assert (
        resolve_state_reference(
            {
                "kind": "derived_widget",
                "derived_widget_id": "single_sampler_denoise",
            },
            state,
        )
        == 0.75
    )
    assert (
        resolve_state_reference(
            {
                "kind": "input_metadata",
                "input": "89",
                "field": "timelineSelection.durationSeconds",
            },
            state,
        )
        == 6
    )
    assert (
        evaluate_condition(
            {
                "kind": "compare",
                "ref": {"kind": "derived_widget", "derived_widget_id": "missing"},
                "value": 0.75,
            },
            state,
        )
        is False
    )
    assert evaluate_condition(
        {
            "kind": "compare",
            "ref": {
                "kind": "input_metadata",
                "input": "89",
                "field": "timelineSelection.durationSeconds",
            },
            "operator": "gt",
            "value": 5,
        },
        state,
    )


def test_compare_operators_numeric_coercion_and_tolerance():
    assert compare_values("0.5", "eq", 0.5)
    assert compare_values(0.1 + 0.2, "eq", 0.3)
    assert compare_values("true", "eq", True)
    assert compare_values("false", "neq", True)
    assert compare_values("0.5", "neq", "0.6")
    assert compare_values("0.5", "lt", 1)
    assert compare_values("0.5", "lte", 0.5)
    assert compare_values("2", "gt", 1)
    assert compare_values("2", "gte", 2)
    assert not compare_values("not-a-number", "lt", 1)
    assert compare_values(" Enabled ", "eq", "enabled")


def test_legacy_boolean_conditions_normalize_to_compare():
    rules = ResolvedWorkflowRules.model_validate(
        {
            "version": 3,
            "rewrites": [
                {
                    "when": {
                        "kind": "widget_boolean",
                        "node_id": "10",
                        "widget": "switch",
                        "value": False,
                    }
                },
                {
                    "when": {
                        "kind": "frontend_control_boolean",
                        "control_id": "prompt_enhancer_enabled",
                        "value": True,
                    }
                },
            ],
        }
    )

    widget_when = rules.rewrites[0].when
    assert widget_when.kind == "compare"
    assert widget_when.ref.kind == "workflow_param"
    assert widget_when.ref.node_id == "10"
    assert widget_when.ref.param == "switch"
    assert widget_when.operator == "eq"
    assert widget_when.value is False

    control_when = rules.rewrites[1].when
    assert control_when.kind == "compare"
    assert control_when.ref.kind == "frontend_control"
    assert control_when.ref.control_id == "prompt_enhancer_enabled"
    assert control_when.operator == "eq"
    assert control_when.value is True
