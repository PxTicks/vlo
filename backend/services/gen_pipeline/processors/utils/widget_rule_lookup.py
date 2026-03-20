from __future__ import annotations

from typing import Any


class WidgetRuleLookup:
    """Safe accessor for the nested widget rules hierarchy.

    Encapsulates the ``rules["nodes"][node_id]["widgets"][param]``
    navigation chain with type checks at each level.
    """

    def __init__(self, rules: dict[str, Any]) -> None:
        raw = rules.get("nodes")
        self._nodes: dict[str, Any] = raw if isinstance(raw, dict) else {}

    def get_node_rule(self, node_id: str) -> dict[str, Any] | None:
        """Return the rule dict for a node, or None."""
        node_rule = self._nodes.get(node_id)
        return node_rule if isinstance(node_rule, dict) else None

    def get_widget_defs(self, node_id: str) -> dict[str, Any] | None:
        """Return the widgets dict for a node, or None."""
        node_rule = self.get_node_rule(node_id)
        if node_rule is None:
            return None
        widget_defs = node_rule.get("widgets")
        return widget_defs if isinstance(widget_defs, dict) else None

    def get_widget_rule(self, node_id: str, param: str) -> dict[str, Any] | None:
        """Return the rule dict for a specific widget param, or None."""
        widget_defs = self.get_widget_defs(node_id)
        if widget_defs is None:
            return None
        widget_rule = widget_defs.get(param)
        return widget_rule if isinstance(widget_rule, dict) else None
