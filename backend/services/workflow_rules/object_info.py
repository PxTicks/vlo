"""Object-info enrichment for workflow rules.

Loads ``object_info.json``, extracts node metadata from workflows, and
enriches sidecar rules with auto-discovered widget entries and AR target
nodes.  Discovery logic lives in ``node_discovery``; param-level parsing
(inputs and widgets) lives in ``node_parsing``.
"""

import json
import logging
from pathlib import Path
from typing import Any

from services.workflow_rules.derived_mask_video_treatment import (
    DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM,
    DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT,
    DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_LABEL,
    LEGACY_DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM,
    create_derived_mask_source_video_treatment_widget_rule,
    normalize_derived_mask_source_video_treatment,
    normalize_derived_mask_source_video_treatment_list,
    resolve_derived_mask_source_video_treatment_default,
    resolve_derived_mask_source_video_treatment_widget_options,
)
from services.workflow_rules.node_discovery import (
    NodePolicy,
    WIDGETS_MODE_ALL,
    WIDGETS_MODE_CONTROL_AFTER_GENERATE,
    has_any_input,
    resolve_node_policy,
)
from services.workflow_rules.node_parsing import (
    build_input_node_map as _build_input_node_map_core,
    build_widget_entries_for_class,
    get_widget_value_index_map as _get_widget_value_index_map_core,
    merge_widget_entries_with_object_info,
    resolve_widget_param_metadata,
)
from services.workflow_rules.normalize import WorkflowRules
from services.workflow_rules.pipeline import find_pipeline_stage, find_stage_control
from services.workflow_rules.schema import ResolvedWorkflowRules
from services.workflow_rules.schema import dump_resolved_rules


log = logging.getLogger(__name__)

_ALWAYS_DISCOVERED_WIDGET_PARAMS = frozenset({"seed", "noise_seed"})

OBJECT_INFO_PATH = (
    Path(__file__).parent.parent.parent / "assets" / ".config" / "object_info.json"
)

_object_info_cache: dict[str, Any] | None = None


def set_object_info_cache(object_info: dict[str, Any] | None) -> None:
    global _object_info_cache
    _object_info_cache = object_info


def _load_object_info() -> dict[str, Any]:
    global _object_info_cache
    if _object_info_cache is not None:
        return _object_info_cache
    try:
        raw = json.loads(OBJECT_INFO_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            _object_info_cache = raw
            log.info("Loaded object_info (%d node classes)", len(raw))
            return raw
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("Failed to load object_info from %s: %s", OBJECT_INFO_PATH, exc)
    _object_info_cache = {}
    return _object_info_cache


# ---------------------------------------------------------------------------
# Workflow node extraction
# ---------------------------------------------------------------------------


class _NodeInfo:
    __slots__ = (
        "class_type",
        "title",
        "widgets_values",
        "widget_groups",
        "linked_input_params",
    )

    def __init__(
        self,
        class_type: str,
        title: str,
        widgets_values: list[Any] | None,
        widget_groups: dict[str, dict[str, Any]] | None = None,
        linked_input_params: set[str] | None = None,
    ):
        self.class_type = class_type
        self.title = title
        self.widgets_values = widgets_values
        self.widget_groups = widget_groups
        self.linked_input_params = linked_input_params or set()


def _extract_api_linked_input_params(node_data: dict[str, Any]) -> set[str]:
    inputs = node_data.get("inputs")
    if not isinstance(inputs, dict):
        return set()

    linked: set[str] = set()
    for param_name, input_value in inputs.items():
        if (
            isinstance(param_name, str)
            and isinstance(input_value, list)
            and len(input_value) == 2
        ):
            linked.add(param_name)
    return linked


def _extract_graph_linked_input_params(node: dict[str, Any]) -> set[str]:
    raw_inputs = node.get("inputs")
    if not isinstance(raw_inputs, list):
        return set()

    linked: set[str] = set()
    for input_entry in raw_inputs:
        if not isinstance(input_entry, dict):
            continue
        param_name = input_entry.get("name")
        if not isinstance(param_name, str) or not param_name.strip():
            continue
        if input_entry.get("link") is not None:
            linked.add(param_name)
    return linked


def _extract_proxy_widget_groups(
    graph_node: dict[str, Any],
    group_id: str,
    group_title: str,
) -> dict[str, dict[str, dict[str, Any]]]:
    properties = graph_node.get("properties")
    if not isinstance(properties, dict):
        return {}

    proxy_widgets = properties.get("proxyWidgets")
    if not isinstance(proxy_widgets, list):
        return {}

    grouped: dict[str, dict[str, dict[str, Any]]] = {}
    for order, proxy_entry in enumerate(proxy_widgets):
        if not isinstance(proxy_entry, (list, tuple)) or len(proxy_entry) < 2:
            continue

        target_node_id = str(proxy_entry[0]).strip()
        target_param = proxy_entry[1]
        if not target_node_id or not isinstance(target_param, str):
            continue

        target_param_name = target_param.strip()
        if not target_param_name:
            continue

        grouped.setdefault(target_node_id, {})[target_param_name] = {
            "group_id": group_id,
            "group_title": group_title,
            "group_order": order,
        }

    return grouped


def _extract_node_info(workflow_data: dict[str, Any]) -> dict[str, _NodeInfo]:
    """Extract a node_id -> _NodeInfo mapping from a workflow file.

    Supports both formats:
    - API format: flat dict keyed by node ID with ``class_type``
    - Graph format: ``nodes`` array with ``id``/``type``, plus subgraphs
      in ``definitions.subgraphs[].nodes``
    """
    result: dict[str, _NodeInfo] = {}

    if all(
        isinstance(v, dict) and "class_type" in v
        for v in workflow_data.values()
        if isinstance(v, dict)
    ):
        for node_id, node_data in workflow_data.items():
            if isinstance(node_data, dict):
                class_type = node_data.get("class_type")
                if isinstance(class_type, str):
                    meta = node_data.get("_meta", {})
                    title = (
                        meta.get("title", class_type)
                        if isinstance(meta, dict)
                        else class_type
                    )
                    result[str(node_id)] = _NodeInfo(
                        class_type,
                        title,
                        None,
                        linked_input_params=_extract_api_linked_input_params(
                            node_data,
                        ),
                    )
        if result:
            return result

    def _collect_from_node_list(
        nodes: Any,
        prefix: str = "",
        widget_groups_by_node: dict[str, dict[str, dict[str, Any]]] | None = None,
    ) -> None:
        if not isinstance(nodes, list):
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            node_id = node.get("id")
            node_type = node.get("type")
            if node_id is not None and isinstance(node_type, str):
                key = f"{prefix}{node_id}" if prefix else str(node_id)
                title = node.get("title") or node_type
                widgets_values = node.get("widgets_values")
                widget_groups = None
                if widget_groups_by_node is not None:
                    widget_groups = widget_groups_by_node.get(str(node_id))
                result[key] = _NodeInfo(
                    node_type,
                    title,
                    widgets_values if isinstance(widgets_values, list) else None,
                    widget_groups=widget_groups,
                    linked_input_params=_extract_graph_linked_input_params(node),
                )

    _collect_from_node_list(workflow_data.get("nodes"))

    defs = workflow_data.get("definitions")
    if isinstance(defs, dict):
        subgraphs = defs.get("subgraphs")
        if isinstance(subgraphs, list):
            sg_by_id: dict[str, dict[str, Any]] = {}
            for sg in subgraphs:
                if isinstance(sg, dict) and isinstance(sg.get("id"), str):
                    sg_by_id[sg["id"]] = sg

            top_nodes = workflow_data.get("nodes")
            if isinstance(top_nodes, list):
                for node in top_nodes:
                    if not isinstance(node, dict):
                        continue
                    node_type = node.get("type")
                    parent_id = node.get("id")
                    if (
                        isinstance(node_type, str)
                        and node_type in sg_by_id
                        and parent_id is not None
                    ):
                        sg_def = sg_by_id[node_type]
                        group_title_raw = node.get("title") or sg_def.get("name") or node_type
                        group_title = (
                            group_title_raw
                            if isinstance(group_title_raw, str) and group_title_raw.strip()
                            else node_type
                        )
                        proxy_widget_groups = _extract_proxy_widget_groups(
                            node,
                            group_id=str(parent_id),
                            group_title=group_title,
                        )
                        _collect_from_node_list(
                            sg_def.get("nodes"),
                            prefix=f"{parent_id}:",
                            widget_groups_by_node=proxy_widget_groups,
                        )

    return result


# ---------------------------------------------------------------------------
# Enrichment orchestration
# ---------------------------------------------------------------------------


def _apply_length_widget_policy(
    node_rule: dict[str, Any],
    node_info: _NodeInfo,
    node_policy: NodePolicy,
    object_info: dict[str, Any],
) -> None:
    widget_param = node_policy.get("length_widget_param")
    if not isinstance(widget_param, str) or not widget_param.strip():
        return
    if widget_param in node_info.linked_input_params:
        return

    current_widgets = node_rule.get("widgets")
    if not isinstance(current_widgets, dict):
        current_widgets = {}
        node_rule["widgets"] = current_widgets
    if widget_param in current_widgets:
        return

    metadata = resolve_widget_param_metadata(
        node_info.class_type,
        object_info,
        {widget_param},
    ).get(widget_param)
    if not isinstance(metadata, dict):
        return

    current_widgets[widget_param] = {
        "label": node_policy.get("length_widget_label", "Length"),
        "control_after_generate": False,
        **metadata,
    }


def _collect_visual_derived_mask_source_node_ids(
    rules: WorkflowRules,
) -> set[str]:
    mask_stage = find_pipeline_stage(rules, kind="mask_processing")
    if not isinstance(mask_stage, dict):
        return set()

    source_node_ids: set[str] = set()
    targets = mask_stage.get("targets")
    if not isinstance(targets, list):
        return source_node_ids

    for target in targets:
        if not isinstance(target, dict):
            continue
        if target.get("purpose") == "audio_timing":
            continue
        source = target.get("source")
        if not isinstance(source, dict):
            continue
        raw_source_id = source.get("node_id")
        if isinstance(raw_source_id, str) and raw_source_id.strip():
            source_node_ids.add(raw_source_id.strip())
    return source_node_ids


def _get_workflow_input_value(
    workflow: dict[str, Any],
    node_id: str,
    param: str,
) -> Any:
    node = workflow.get(node_id)
    if not isinstance(node, dict):
        return None
    inputs = node.get("inputs")
    if not isinstance(inputs, dict):
        return None
    return inputs.get(param)


def _resolve_mask_processing_source_video_treatment_config(
    rules: WorkflowRules,
) -> tuple[str, str, bool, list[str] | None, list[dict[str, Any]] | None]:
    default = DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT
    label = DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_LABEL
    expose_as_widget = True
    option_values: list[str] | None = None
    default_overrides: list[dict[str, Any]] | None = None

    mask_stage = find_pipeline_stage(rules, kind="mask_processing")
    if not isinstance(mask_stage, dict):
        return default, label, expose_as_widget, option_values, default_overrides

    source_video_treatment = find_stage_control(mask_stage, "source_video_treatment")
    if not isinstance(source_video_treatment, dict):
        return default, label, expose_as_widget, option_values, default_overrides

    default = normalize_derived_mask_source_video_treatment(
        source_video_treatment.get("default")
    )

    raw_label = source_video_treatment.get("label")
    if isinstance(raw_label, str) and raw_label.strip():
        label = raw_label.strip()

    raw_expose_as_widget = source_video_treatment.get("expose")
    if raw_expose_as_widget in {"widget", "none"}:
        expose_as_widget = raw_expose_as_widget == "widget"

    include_options = normalize_derived_mask_source_video_treatment_list(
        source_video_treatment.get("include_options")
    )
    exclude_options = normalize_derived_mask_source_video_treatment_list(
        source_video_treatment.get("exclude_options")
    )
    option_values = resolve_derived_mask_source_video_treatment_widget_options(
        include_options=include_options or None,
        exclude_options=exclude_options or None,
    )

    raw_default_overrides = source_video_treatment.get("default_rules")
    if isinstance(raw_default_overrides, list):
        translated_overrides: list[dict[str, Any]] = []
        for override in raw_default_overrides:
            if not isinstance(override, dict):
                continue
            when = override.get("when")
            if not isinstance(when, dict):
                continue
            ref = when.get("ref")
            if not isinstance(ref, dict) or ref.get("kind") != "workflow_param":
                continue
            translated_overrides.append(
                {
                    "when": {
                        "node_id": ref.get("node_id"),
                        "param": ref.get("param"),
                        "operator": when.get("operator", "eq"),
                        "value": when.get("value"),
                    },
                    "value": override.get("value"),
                }
            )
        default_overrides = translated_overrides or None

    return default, label, expose_as_widget, option_values, default_overrides


def _apply_derived_mask_source_video_treatment_widget(
    node_rule: dict[str, Any],
    *,
    default: str,
    label: str,
    option_values: list[str] | None,
) -> None:
    current_widgets = node_rule.get("widgets")
    if not isinstance(current_widgets, dict):
        current_widgets = {}
        node_rule["widgets"] = current_widgets

    if (
        LEGACY_DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM in current_widgets
        and DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM not in current_widgets
    ):
        current_widgets[DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM] = (
            current_widgets.pop(LEGACY_DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM)
        )
    else:
        current_widgets.pop(
            LEGACY_DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM,
            None,
        )

    if DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM in current_widgets:
        return

    current_widgets[DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM] = (
        create_derived_mask_source_video_treatment_widget_rule(
            default=default,
            label=label,
            option_values=option_values,
        )
    )


def _resolve_default_policy_widgets(
    node_info: _NodeInfo,
    node_policy: NodePolicy,
    object_info: dict[str, Any],
) -> dict[str, dict[str, Any]] | None:
    preferred_params = node_policy.get("default_widget_params")
    if not isinstance(preferred_params, list) or not preferred_params:
        return None

    all_widgets = build_widget_entries_for_class(
        node_info.class_type,
        object_info,
        node_title=node_info.title,
        widgets_values=node_info.widgets_values,
        widget_groups=node_info.widget_groups,
        include_all_widgets=True,
    )
    if not isinstance(all_widgets, dict):
        return None

    selected_widgets: dict[str, dict[str, Any]] = {}
    for param_name in preferred_params:
        if not isinstance(param_name, str) or not param_name.strip():
            continue
        widget_entry = all_widgets.get(param_name)
        if isinstance(widget_entry, dict):
            selected_widgets[param_name] = widget_entry

    for param_name, widget_entry in all_widgets.items():
        if not isinstance(widget_entry, dict):
            continue

        normalized_param = param_name.strip().lower()
        should_force_include = normalized_param in _ALWAYS_DISCOVERED_WIDGET_PARAMS or (
            widget_entry.get("control_after_generate") is True
            and widget_entry.get("default_randomize") is True
        )
        if should_force_include:
            selected_widgets.setdefault(param_name, widget_entry)

    return selected_widgets or None


def _collect_validation_targets(rule: dict[str, Any]) -> set[str]:
    kind = rule.get("kind")
    if kind in {"required", "optional"}:
        target = rule.get("input")
        if isinstance(target, str) and target.strip():
            return {target.strip()}
        return set()

    if kind == "at_least_n":
        raw_inputs = rule.get("inputs")
        if not isinstance(raw_inputs, list):
            return set()
        return {
            str(target).strip()
            for target in raw_inputs
            if isinstance(target, str) and target.strip()
        }

    return set()


def _is_validation_target_covered(
    target: str,
    existing_targets: set[str],
) -> bool:
    if target in existing_targets:
        return True

    node_id, _, _ = target.partition(":")
    return bool(node_id and node_id != target and node_id in existing_targets)


def _apply_default_required_input_validation(
    rules: WorkflowRules,
    node_infos: dict[str, _NodeInfo],
    node_policies: dict[str, NodePolicy],
    object_info: dict[str, Any],
) -> None:
    validation = rules.get("validation")
    if not isinstance(validation, dict):
        validation = {}
        rules["validation"] = validation

    validation_inputs = validation.get("inputs")
    if not isinstance(validation_inputs, list):
        validation_inputs = []
        validation["inputs"] = validation_inputs

    input_node_map = _build_input_node_map_core(object_info)
    existing_targets: set[str] = set()
    for rule in validation_inputs:
        if isinstance(rule, dict):
            existing_targets.update(_collect_validation_targets(rule))

    nodes = rules.get("nodes")
    if not isinstance(nodes, dict):
        return

    derived_mask_node_ids: set[str] = set()
    mask_stage = find_pipeline_stage(rules, kind="mask_processing")
    if isinstance(mask_stage, dict):
        targets = mask_stage.get("targets")
        if isinstance(targets, list):
            for target in targets:
                if not isinstance(target, dict):
                    continue
                mask = target.get("mask")
                if not isinstance(mask, dict):
                    continue
                node_id = mask.get("node_id")
                if isinstance(node_id, str) and node_id.strip():
                    derived_mask_node_ids.add(node_id.strip())

    for node_id, info in node_infos.items():
        node_policy = node_policies.get(node_id, {})
        if not has_any_input(node_policy):
            continue

        node_rule = nodes.get(node_id)
        if not isinstance(node_rule, dict):
            continue
        if node_rule.get("ignore"):
            continue
        if node_id in derived_mask_node_ids:
            continue

        present = node_rule.get("present")
        if isinstance(present, dict):
            if present.get("enabled") is False:
                continue
            if present.get("required") is False:
                continue

        discovered_inputs = input_node_map.get(info.class_type)
        if not isinstance(discovered_inputs, list) or not discovered_inputs:
            continue

        use_param_specific_targets = len(discovered_inputs) > 1
        for discovered_input in discovered_inputs:
            input_type = discovered_input.get("input_type")
            if input_type == "text":
                continue

            param = discovered_input.get("param")
            if not isinstance(param, str) or not param.strip():
                continue

            target = f"{node_id}:{param}" if use_param_specific_targets else node_id
            if _is_validation_target_covered(target, existing_targets):
                continue

            label = discovered_input.get("label")
            validation_inputs.append(
                {
                    "kind": "required",
                    "input": target,
                    **(
                        {"message": f"{label} is required."}
                        if isinstance(label, str) and label.strip()
                        else {}
                    ),
                }
            )
            existing_targets.add(target)


def enrich_rules_with_object_info(
    rules: WorkflowRules | ResolvedWorkflowRules,
    workflow_data: dict[str, Any],
) -> WorkflowRules | ResolvedWorkflowRules:
    """Resolve widget metadata via object_info.

    object_info is treated as the primary source of truth for widget data.
    - Without explicit node widget rules, this auto-discovers widgets.
    - With explicit rules, this augments known widget params with object_info
      datatype metadata when available.
    - With ``widgets_mode = 'all'``, this exposes all editable widget params
      for the node and overlays any explicit per-widget overrides.

    Dict inputs are mutated in place and returned. Model inputs return a new
    resolved model with the enrichment applied.
    """
    object_info = _load_object_info()
    if not object_info:
        log.warning("[enrich] object_info is empty or failed to load")
        return rules

    node_infos = _extract_node_info(workflow_data)
    log.info("[enrich] Extracted %d node infos from workflow", len(node_infos))
    if not node_infos:
        log.warning(
            "[enrich] No node infos extracted — workflow format may be unrecognized"
        )
        return rules

    rules_model = rules if isinstance(rules, ResolvedWorkflowRules) else None
    rules_dict = dump_resolved_rules(rules_model) if rules_model is not None else rules
    nodes_rules = rules_dict.setdefault("nodes", {})
    default_widgets_mode = rules_model.default_widgets_mode if rules_model is not None else None
    discovered_count = 0
    visual_derived_mask_source_node_ids = _collect_visual_derived_mask_source_node_ids(
        rules_dict
    )
    (
        derived_mask_treatment_default,
        derived_mask_treatment_label,
        expose_derived_mask_treatment_widget,
        derived_mask_treatment_option_values,
        derived_mask_treatment_default_overrides,
    ) = _resolve_mask_processing_source_video_treatment_config(rules_dict)
    derived_mask_treatment_default = resolve_derived_mask_source_video_treatment_default(
        default=derived_mask_treatment_default,
        default_overrides=derived_mask_treatment_default_overrides,
        get_param_value=lambda node_id, param: _get_workflow_input_value(
            workflow_data,
            node_id,
            param,
        ),
    )

    # Resolve node policies once — maps discovery to display/processing actions.
    node_policies: dict[str, NodePolicy] = {}
    for node_id, info in node_infos.items():
        node_policies[node_id] = resolve_node_policy(
            info.class_type,
            object_info.get(info.class_type),
        )

    for node_id, info in node_infos.items():
        existing = nodes_rules.setdefault(node_id, {})
        if not isinstance(existing, dict):
            existing = {}
            nodes_rules[node_id] = existing

        if existing.get("ignore"):
            log.debug(
                "[enrich] Skipping node %s (%s): ignored",
                node_id,
                info.class_type,
            )
            continue

        widgets_mode = existing.get("widgets_mode")
        has_explicit_widgets_mode = isinstance(widgets_mode, str)
        if not has_explicit_widgets_mode:
            widgets_mode = node_policies[node_id].get(
                "widgets_mode",
                default_widgets_mode or WIDGETS_MODE_CONTROL_AFTER_GENERATE,
            )
        include_all_widgets = widgets_mode == WIDGETS_MODE_ALL

        discovered_widgets = build_widget_entries_for_class(
            info.class_type,
            object_info,
            node_title=info.title,
            widgets_values=info.widgets_values,
            widget_groups=info.widget_groups,
            include_all_widgets=include_all_widgets,
        )
        if not has_explicit_widgets_mode and default_widgets_mode is None:
            policy_widgets = _resolve_default_policy_widgets(
                info,
                node_policies[node_id],
                object_info,
            )
            if policy_widgets:
                discovered_widgets = policy_widgets

        existing_widgets = existing.get("widgets")
        if include_all_widgets and discovered_widgets:
            merged_widgets = dict(discovered_widgets)
            if isinstance(existing_widgets, dict):
                merged_widgets.update(existing_widgets)
            existing["widgets"] = merge_widget_entries_with_object_info(
                merged_widgets,
                discovered_widgets,
            )
        elif isinstance(existing_widgets, dict):
            merged_widgets = dict(discovered_widgets) if discovered_widgets else {}
            merged_widgets.update(existing_widgets)
            enrichment_source = dict(discovered_widgets) if discovered_widgets else {}
            unenriched = {
                name for name, entry in existing_widgets.items()
                if isinstance(entry, dict) and name not in enrichment_source
            }
            if unenriched:
                enrichment_source.update(
                    resolve_widget_param_metadata(info.class_type, object_info, unenriched)
                )
            if merged_widgets:
                existing["widgets"] = merge_widget_entries_with_object_info(
                    merged_widgets,
                    enrichment_source,
                )
        elif discovered_widgets:
            existing["widgets"] = discovered_widgets

        _apply_length_widget_policy(
            existing,
            info,
            node_policies[node_id],
            object_info,
        )

        present = existing.get("present")
        is_input_hidden = isinstance(present, dict) and present.get("enabled") is False
        if (
            node_id in visual_derived_mask_source_node_ids
            and not existing.get("ignore")
            and not is_input_hidden
            and expose_derived_mask_treatment_widget
        ):
            _apply_derived_mask_source_video_treatment_widget(
                existing,
                default=derived_mask_treatment_default,
                label=derived_mask_treatment_label,
                option_values=derived_mask_treatment_option_values,
            )

        if existing.get("widgets"):
            existing["node_title"] = info.title
            discovered_count += 1
            log.info(
                "[enrich] Node %s (%s, title=%r): resolved widgets %s (mode=%s)",
                node_id,
                info.class_type,
                info.title,
                list(existing["widgets"].keys()),
                widgets_mode,
            )

    log.info(
        "[enrich] Total nodes with auto-discovered widgets: %d", discovered_count
    )

    _apply_default_required_input_validation(
        rules_dict,
        node_infos,
        node_policies,
        object_info,
    )

    _apply_ar_target_policies(rules_dict, node_infos, node_policies)

    if rules_model is not None:
        return ResolvedWorkflowRules.model_validate(rules_dict)

    return rules_dict


def _apply_ar_target_policies(
    rules: WorkflowRules,
    node_infos: dict[str, _NodeInfo],
    node_policies: dict[str, NodePolicy],
) -> None:
    """Auto-add nodes with ``ar_target`` policy when no explicit targets exist.

    Sidecars that declare explicit aspect-ratio stage targets are treated as
    authoritative so auto-discovery does not silently retarget additional nodes.
    """
    ar_stage = find_pipeline_stage(rules, kind="aspect_ratio")
    if not isinstance(ar_stage, dict) or ar_stage.get("enabled") is False:
        return

    target_nodes = ar_stage.get("targets")
    if not isinstance(target_nodes, list):
        target_nodes = []
        ar_stage["targets"] = target_nodes
    elif len(target_nodes) > 0:
        return

    existing_ids = {
        entry.get("width", {}).get("node_id")
        for entry in target_nodes
        if isinstance(entry, dict)
    }

    discovered = 0
    for node_id, info in node_infos.items():
        if node_id in existing_ids:
            continue
        policy = node_policies.get(node_id, {})
        if not policy.get("ar_target"):
            continue

        target_nodes.append(
            {
                "width": {
                    "node_id": node_id,
                    "param": policy.get("ar_width_param", "width"),
                },
                "height": {
                    "node_id": node_id,
                    "param": policy.get("ar_height_param", "height"),
                },
            }
        )
        discovered += 1
        log.info(
            "[enrich] Auto-discovered AR target node %s (%s)",
            node_id,
            info.class_type,
        )

    if discovered:
        ar_stage["targets"] = target_nodes
        log.info(
            "[enrich] Total auto-discovered AR target nodes: %d", discovered
        )


# ---------------------------------------------------------------------------
# Public API wrappers (add lazy object_info loading)
# ---------------------------------------------------------------------------


def build_input_node_map(
    object_info: dict[str, Any] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Build a complete input node map from object_info + static fallbacks.

    Returns a dict of ``class_type -> [{input_type, param, label, description}, ...]``.
    """
    if object_info is None:
        object_info = _load_object_info()
    return _build_input_node_map_core(object_info)


def get_widget_value_index_map(
    class_type: str,
    object_info: dict[str, Any] | None = None,
) -> dict[str, int]:
    """Return the widget_values slot for each editable widget on a node class."""
    if object_info is None:
        object_info = _load_object_info()
    return _get_widget_value_index_map_core(class_type, object_info)


def get_required_input_params_for_class(
    class_type: str,
    object_info: dict[str, Any] | None = None,
) -> set[str]:
    """Return required input param names for a ComfyUI node class."""
    if object_info is None:
        object_info = _load_object_info()

    class_info = object_info.get(class_type)
    if not isinstance(class_info, dict):
        return set()

    input_spec = class_info.get("input")
    if not isinstance(input_spec, dict):
        return set()

    required_spec = input_spec.get("required")
    if not isinstance(required_spec, dict):
        return set()

    return {
        param_name.strip()
        for param_name in required_spec.keys()
        if isinstance(param_name, str) and param_name.strip()
    }


__all__ = [
    "OBJECT_INFO_PATH",
    "build_input_node_map",
    "enrich_rules_with_object_info",
    "get_required_input_params_for_class",
    "get_widget_value_index_map",
    "set_object_info_cache",
]
