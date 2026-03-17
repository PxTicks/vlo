from typing import Literal

from services.workflow_rules.normalize import WorkflowRules


MaskCroppingMode = Literal["crop", "full"]


def collect_mask_crop_pairs(
    rules: WorkflowRules | None,
    mode_override: MaskCroppingMode | None = None,
) -> list[tuple[str, str]]:
    """Return ``(source_node_id, mask_node_id)`` pairs for mask-crop preprocessing.

    Derived-mask relations remain the default source of truth. The workflow
    sidecar can set ``mask_cropping.mode`` to ``full`` to skip preprocessing.
    """
    if not isinstance(rules, dict):
        return []

    if mode_override == "full":
        return []

    mask_cropping = rules.get("mask_cropping", {})
    if (
        mode_override is None
        and isinstance(mask_cropping, dict)
        and mask_cropping.get("mode") == "full"
    ):
        return []

    nodes_rules = rules.get("nodes", {})
    if not isinstance(nodes_rules, dict):
        return []

    pairs: list[tuple[str, str]] = []
    seen_pairs: set[tuple[str, str]] = set()
    for node_id, node_rule in nodes_rules.items():
        if not isinstance(node_rule, dict):
            continue
        source_id: str | None = None
        for mask_key in ("binary_derived_mask_of", "soft_derived_mask_of"):
            raw_source_id = node_rule.get(mask_key)
            if isinstance(raw_source_id, str) and raw_source_id.strip():
                source_id = raw_source_id.strip()
                break
        if source_id is None:
            continue
        pair = (source_id, str(node_id))
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        pairs.append(pair)

    return pairs


__all__ = ["MaskCroppingMode", "collect_mask_crop_pairs"]
