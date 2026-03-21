"""Declarative node discovery and policy resolution.

Provides constraint-based matching against object_info JSON entries and a
rules table that maps discovered node types to display/processing policies.
"""

from collections.abc import Iterator
from typing import Any, TypedDict


# ---------------------------------------------------------------------------
# Param iteration helper
# ---------------------------------------------------------------------------


def iter_all_params(
    class_info: dict[str, Any],
) -> Iterator[tuple[str, Any, dict[str, Any]]]:
    """Yield ``(param_name, type_spec, opts)`` for every input param."""
    input_spec = class_info.get("input")
    if not isinstance(input_spec, dict):
        return
    for section_key in ("required", "optional"):
        section = input_spec.get(section_key)
        if not isinstance(section, dict):
            continue
        for param_name, param_def in section.items():
            if not isinstance(param_def, (list, tuple)) or len(param_def) < 1:
                continue
            type_spec = param_def[0]
            opts = param_def[1] if len(param_def) >= 2 and isinstance(param_def[1], dict) else {}
            yield param_name, type_spec, opts


# ---------------------------------------------------------------------------
# Universal node-class matcher: declarative constraint-based discovery
# ---------------------------------------------------------------------------


class NodeConstraint(TypedDict, total=False):
    """Declarative constraints for matching a node class against object_info.

    All specified constraints are ANDed — every one must hold for a match.
    """

    class_names: frozenset[str]
    """Exact ``class_type`` membership."""

    name_contains: str
    """Case-insensitive substring match on ``class_type``."""

    has_params: list[str]
    """All listed param names must exist in the node's inputs."""

    has_param_flag: dict[str, object]
    """At least one param's opts dict must contain all these key-value pairs."""


def match_node_class(
    class_type: str,
    class_info: dict[str, Any] | None,
    constraint: NodeConstraint,
) -> bool:
    """Evaluate a declarative constraint dict against a node class."""
    if "class_names" in constraint:
        if class_type not in constraint["class_names"]:
            return False

    if "name_contains" in constraint:
        if constraint["name_contains"].lower() not in class_type.lower():
            return False

    needs_class_info = "has_params" in constraint or "has_param_flag" in constraint
    if not needs_class_info:
        return True
    if not isinstance(class_info, dict):
        return False

    if "has_params" in constraint:
        all_params = {name for name, _, _ in iter_all_params(class_info)}
        if not all(p in all_params for p in constraint["has_params"]):
            return False

    if "has_param_flag" in constraint:
        required_flags = constraint["has_param_flag"]
        if not any(
            all(opts.get(k) == v for k, v in required_flags.items())
            for _, _, opts in iter_all_params(class_info)
        ):
            return False

    return True


# ---------------------------------------------------------------------------
# Node policy: maps discovered node types to display/processing actions.
# Priority: sidecar .rules.json > policy rules > hardcoded defaults.
# ---------------------------------------------------------------------------

WIDGETS_MODE_ALL = "all"
WIDGETS_MODE_CONTROL_AFTER_GENERATE = "control_after_generate"


class NodePolicy(TypedDict, total=False):
    """Policy actions to apply when a node matches a constraint."""

    widgets_mode: str
    """``"all"`` or ``"control_after_generate"``."""

    ar_target: bool
    """Auto-add to ``aspect_ratio_processing.target_nodes``."""

    ar_width_param: str
    """Param name for width (default ``"width"``)."""

    ar_height_param: str
    """Param name for height (default ``"height"``)."""


class NodePolicyRule(TypedDict):
    """A discovery constraint paired with the policy to apply on match."""

    constraint: NodeConstraint
    policy: NodePolicy


DEFAULT_NODE_POLICY_RULES: list[NodePolicyRule] = [
    {
        "constraint": {"class_names": frozenset({"KSampler", "KSamplerAdvanced"})},
        "policy": {"widgets_mode": WIDGETS_MODE_ALL},
    },
    {
        "constraint": {"name_contains": "resize", "has_params": ["width", "height"]},
        "policy": {
            "ar_target": True,
            "ar_width_param": "width",
            "ar_height_param": "height",
        },
    },
]


def resolve_node_policy(
    class_type: str,
    class_info: dict[str, Any] | None,
    rules: list[NodePolicyRule] | None = None,
) -> NodePolicy:
    """Evaluate policy rules against a node class; return merged policy.

    Later-matching rules override earlier ones for the same field.
    """
    if rules is None:
        rules = DEFAULT_NODE_POLICY_RULES
    merged: NodePolicy = {}
    for rule in rules:
        if match_node_class(class_type, class_info, rule["constraint"]):
            merged.update(rule["policy"])
    return merged


__all__ = [
    "DEFAULT_NODE_POLICY_RULES",
    "NodeConstraint",
    "NodePolicy",
    "NodePolicyRule",
    "WIDGETS_MODE_ALL",
    "WIDGETS_MODE_CONTROL_AFTER_GENERATE",
    "iter_all_params",
    "match_node_class",
    "resolve_node_policy",
]
