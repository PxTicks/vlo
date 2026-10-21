from typing import Literal

from services.workflow_rules.normalize import WorkflowRules
from services.workflow_rules.pipeline import find_pipeline_stage


MaskCroppingMode = Literal["crop", "full"]


def _crop_targets(
    rules: WorkflowRules | None,
    mode_override: MaskCroppingMode | None,
    resolved_pipeline_controls: dict[str, dict[str, object]] | None,
) -> list[dict[str, object]]:
    """Visual mask-processing targets, or none when cropping is off."""
    if not isinstance(rules, dict):
        return []

    if mode_override == "full":
        return []

    mask_stage = find_pipeline_stage(rules, kind="mask_processing")
    if not isinstance(mask_stage, dict):
        return []

    if mode_override is None:
        mask_stage_id = mask_stage.get("id")
        if isinstance(mask_stage_id, str):
            stage_controls = (resolved_pipeline_controls or {}).get(mask_stage_id)
            if isinstance(stage_controls, dict):
                resolved_mode = stage_controls.get("crop_mode")
                if resolved_mode == "full":
                    return []

        controls = mask_stage.get("controls")
        if isinstance(controls, list):
            for control in controls:
                if (
                    isinstance(control, dict)
                    and control.get("key") == "crop_mode"
                    and control.get("default") == "full"
                ):
                    return []

    targets = mask_stage.get("targets")
    if not isinstance(targets, list):
        return []
    return [
        target
        for target in targets
        if isinstance(target, dict) and target.get("purpose", "video") == "video"
    ]


def _node_id(ref: object) -> str | None:
    if not isinstance(ref, dict):
        return None
    node_id = ref.get("node_id")
    if not isinstance(node_id, str) or not node_id.strip():
        return None
    return node_id.strip()


def collect_mask_crop_pairs(
    rules: WorkflowRules | None,
    mode_override: MaskCroppingMode | None = None,
    resolved_pipeline_controls: dict[str, dict[str, object]] | None = None,
) -> list[tuple[str, str]]:
    """Return ``(source_node_id, mask_node_id)`` pairs for mask-crop preprocessing.

    Mask-processing stage targets are the source of truth. The workflow sidecar
    can set the `crop_mode` control default to ``full`` to skip preprocessing
    when no request override is provided. Runtime callers should prefer passing
    `resolved_pipeline_controls` or an explicit `mode_override`; default
    inspection is kept for sidecar introspection and tests.

    Targets whose mask is the source's own alpha have no mask node; see
    :func:`collect_alpha_mask_crop_sources`.
    """
    pairs: list[tuple[str, str]] = []
    seen_pairs: set[tuple[str, str]] = set()
    for target in _crop_targets(rules, mode_override, resolved_pipeline_controls):
        if target.get("mask_source", "input") != "input":
            continue
        source_id = _node_id(target.get("source"))
        mask_node_id = _node_id(target.get("mask"))
        if source_id is None or mask_node_id is None:
            continue
        pair = (source_id, mask_node_id)
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        pairs.append(pair)

    return pairs


def collect_alpha_mask_crop_sources(
    rules: WorkflowRules | None,
    mode_override: MaskCroppingMode | None = None,
    resolved_pipeline_controls: dict[str, dict[str, object]] | None = None,
) -> list[str]:
    """Source node ids whose image carries its own mask in the alpha channel.

    Same crop-mode gating as :func:`collect_mask_crop_pairs`.
    """
    sources: list[str] = []
    for target in _crop_targets(rules, mode_override, resolved_pipeline_controls):
        if target.get("mask_source") != "source_alpha":
            continue
        source_id = _node_id(target.get("source"))
        if source_id is not None and source_id not in sources:
            sources.append(source_id)
    return sources


__all__ = [
    "MaskCroppingMode",
    "collect_alpha_mask_crop_sources",
    "collect_mask_crop_pairs",
]
