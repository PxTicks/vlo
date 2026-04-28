from typing import Literal

from services.workflow_rules.normalize import WorkflowRules
from services.workflow_rules.pipeline import find_pipeline_stage


MaskCroppingMode = Literal["crop", "full"]


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
    """
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

    pairs: list[tuple[str, str]] = []
    seen_pairs: set[tuple[str, str]] = set()
    for target in targets:
        if not isinstance(target, dict):
            continue
        purpose = target.get("purpose", "video")
        if purpose != "video":
            continue
        source = target.get("source")
        mask = target.get("mask")
        if not isinstance(source, dict) or not isinstance(mask, dict):
            continue
        source_id = source.get("node_id")
        mask_node_id = mask.get("node_id")
        if not isinstance(source_id, str) or not source_id.strip():
            continue
        if not isinstance(mask_node_id, str) or not mask_node_id.strip():
            continue
        pair = (source_id.strip(), mask_node_id.strip())
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        pairs.append(pair)

    return pairs


__all__ = ["MaskCroppingMode", "collect_mask_crop_pairs"]
