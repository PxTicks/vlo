"""Declarative node discovery and policy resolution.

Provides constraint-based matching against object_info JSON entries and a
rules table that maps discovered node types to display/processing policies.
"""

from typing import Any, TypedDict

from services.workflow_rules.node_introspection import iter_all_params


# ---------------------------------------------------------------------------
# Universal node-class matcher: declarative constraint-based discovery
# ---------------------------------------------------------------------------


class ParamConstraint(TypedDict, total=False):
    """Constraints on an individual param.

    When used in ``has_matching_param``, at least one param must satisfy
    **all** specified sub-constraints (ANDed).
    """

    flags: dict[str, object]
    """Param opts must contain all these key-value pairs."""

    type_spec_is_list: bool
    """``isinstance(type_spec, list)``."""

    type_spec_string: str
    """``isinstance(type_spec, str) and type_spec.upper() == value``."""

    type_spec_not_string: str
    """``not (isinstance(type_spec, str) and type_spec.upper() == value)``."""


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

    has_matching_param: ParamConstraint
    """At least one param must satisfy all sub-constraints."""


def _match_param(
    type_spec: Any,
    opts: dict[str, Any],
    pc: ParamConstraint,
) -> bool:
    """Check whether a single param satisfies all sub-constraints."""
    if "flags" in pc:
        if not all(opts.get(k) == v for k, v in pc["flags"].items()):
            return False

    if "type_spec_is_list" in pc:
        if isinstance(type_spec, list) != pc["type_spec_is_list"]:
            return False

    if "type_spec_string" in pc:
        if not (isinstance(type_spec, str) and type_spec.upper() == pc["type_spec_string"]):
            return False

    if "type_spec_not_string" in pc:
        if isinstance(type_spec, str) and type_spec.upper() == pc["type_spec_not_string"]:
            return False

    return True


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

    needs_class_info = (
        "has_params" in constraint
        or "has_param_flag" in constraint
        or "has_matching_param" in constraint
    )
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

    if "has_matching_param" in constraint:
        pc = constraint["has_matching_param"]
        if not any(
            _match_param(type_spec, opts, pc)
            for _, type_spec, opts in iter_all_params(class_info)
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

    has_image_input: bool
    """Node has at least one image-upload input."""

    has_video_input: bool
    """Node has at least one video-upload input."""

    has_text_input: bool
    """Node has at least one text-prompt input."""


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
    {
        "constraint": {
            "has_matching_param": {
                "flags": {"image_upload": True},
                "type_spec_is_list": True,
            },
        },
        "policy": {"has_image_input": True},
    },
    {
        "constraint": {
            "has_matching_param": {"flags": {"video_upload": True}},
        },
        "policy": {"has_video_input": True},
    },
    {
        "constraint": {
            "has_matching_param": {
                "flags": {"dynamicPrompts": True},
                "type_spec_string": "STRING",
            },
        },
        "policy": {"has_text_input": True},
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


def has_any_input(policy: NodePolicy) -> bool:
    """Return True if the policy indicates any input (image, video, or text)."""
    return bool(
        policy.get("has_image_input")
        or policy.get("has_video_input")
        or policy.get("has_text_input")
    )


__all__ = [
    "DEFAULT_NODE_POLICY_RULES",
    "NodeConstraint",
    "NodePolicy",
    "NodePolicyRule",
    "ParamConstraint",
    "WIDGETS_MODE_ALL",
    "WIDGETS_MODE_CONTROL_AFTER_GENERATE",
    "has_any_input",
    "match_node_class",
    "resolve_node_policy",
]
