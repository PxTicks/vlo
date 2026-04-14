from collections import deque
from copy import deepcopy
from typing import Any

from pydantic import ValidationError

from services.workflow_rules.normalize import (
    WorkflowPrompt,
    WorkflowRuleWarning,
    WorkflowRules,
    _to_bool,
    _to_int,
    _warning,
    normalize_rules,
)
from services.workflow_rules.object_info import get_required_input_params_for_class
from services.workflow_rules.schema import ResolvedWorkflowRules, dump_resolved_rules


def _is_output_link_to(value: Any, target_node_id: str, target_output_index: int) -> bool:
    if not isinstance(value, list) or len(value) != 2:
        return False
    linked_node, linked_output = value
    linked_output_index = _to_int(linked_output)
    if linked_output_index is None:
        return False
    return str(linked_node) == target_node_id and linked_output_index == target_output_index


def _rewrite_output_links(
    workflow: WorkflowPrompt,
    target_node_id: str,
    target_output_index: int,
    replacement_node_id: str,
    replacement_output_index: int,
) -> int:
    rewrites = 0
    for node_data in workflow.values():
        if not isinstance(node_data, dict):
            continue
        inputs = node_data.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for input_key, input_value in list(inputs.items()):
            if _is_output_link_to(input_value, target_node_id, target_output_index):
                inputs[input_key] = [replacement_node_id, replacement_output_index]
                rewrites += 1
    return rewrites


def _disconnect_output_links_from_node(
    workflow: WorkflowPrompt,
    target_node_id: str,
) -> set[str]:
    affected_consumers: set[str] = set()
    for node_id, node_data in workflow.items():
        if not isinstance(node_data, dict):
            continue
        inputs = node_data.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for input_key, input_value in list(inputs.items()):
            if (
                isinstance(input_value, list)
                and len(input_value) == 2
                and str(input_value[0]) == target_node_id
            ):
                inputs.pop(input_key, None)
                affected_consumers.add(str(node_id))
    return affected_consumers


def _collect_nodes_with_missing_required_inputs(
    workflow: WorkflowPrompt,
    seed_node_ids: set[str],
    reachable_from_provided_inputs: set[str],
) -> set[str]:
    removable: set[str] = set()
    required_inputs_cache: dict[str, set[str]] = {}
    queue: deque[str] = deque(sorted(seed_node_ids))

    while queue:
        node_id = queue.popleft()
        if node_id in removable:
            continue

        node_data = workflow.get(node_id)
        if not isinstance(node_data, dict):
            continue
        if node_id in reachable_from_provided_inputs:
            continue

        class_type = node_data.get("class_type")
        if not isinstance(class_type, str) or not class_type.strip():
            continue

        required_inputs = required_inputs_cache.get(class_type)
        if required_inputs is None:
            required_inputs = get_required_input_params_for_class(class_type)
            required_inputs_cache[class_type] = required_inputs
        if not required_inputs:
            continue

        inputs = node_data.get("inputs")
        if not isinstance(inputs, dict):
            inputs = {}

        if all(param_name in inputs for param_name in required_inputs):
            continue

        removable.add(node_id)
        queue.extend(sorted(_disconnect_output_links_from_node(workflow, node_id)))

    return removable


def _extract_dependencies(
    workflow: WorkflowPrompt,
) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    parents: dict[str, set[str]] = {}
    consumers: dict[str, set[str]] = {}
    for node_id in workflow.keys():
        node_key = str(node_id)
        parents.setdefault(node_key, set())
        consumers.setdefault(node_key, set())

    for node_id, node_data in workflow.items():
        current_node_id = str(node_id)
        if not isinstance(node_data, dict):
            continue
        inputs = node_data.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for input_value in inputs.values():
            if not isinstance(input_value, list) or len(input_value) != 2:
                continue
            parent_node = str(input_value[0])
            parent_output = _to_int(input_value[1])
            if parent_output is None:
                continue
            parents.setdefault(current_node_id, set()).add(parent_node)
            consumers.setdefault(parent_node, set()).add(current_node_id)
            parents.setdefault(parent_node, set())
            consumers.setdefault(current_node_id, set())
    return parents, consumers


def _collect_reachable_descendants(
    workflow: WorkflowPrompt,
    seed_node_ids: set[str],
) -> set[str]:
    if not seed_node_ids:
        return set()

    _, consumers = _extract_dependencies(workflow)
    reachable: set[str] = {node_id for node_id in seed_node_ids if node_id in workflow}
    queue: deque[str] = deque(sorted(reachable))

    while queue:
        node_id = queue.popleft()
        for consumer_id in sorted(consumers.get(node_id, set())):
            if consumer_id in reachable or consumer_id not in workflow:
                continue
            reachable.add(consumer_id)
            queue.append(consumer_id)

    return reachable


def _find_references_to_node(
    workflow: WorkflowPrompt, target_node_id: str
) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for node_id, node_data in workflow.items():
        if not isinstance(node_data, dict):
            continue
        inputs = node_data.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for input_name, input_value in inputs.items():
            if (
                isinstance(input_value, list)
                and len(input_value) == 2
                and str(input_value[0]) == target_node_id
            ):
                refs.append({"node_id": str(node_id), "input": input_name})
    return refs


def _normalize_provided_input_ids(
    provided_input_ids: set[str] | None,
) -> set[str]:
    return {
        str(input_id).strip()
        for input_id in (provided_input_ids or set())
        if str(input_id).strip()
    }


def _matches_input_presence_condition(
    raw_condition: Any,
    provided_input_ids: set[str],
) -> bool:
    if not isinstance(raw_condition, dict):
        return False

    if raw_condition.get("kind") != "input_presence":
        return False

    raw_inputs = raw_condition.get("inputs")
    if not isinstance(raw_inputs, list):
        return False

    inputs = [
        str(input_id).strip()
        for input_id in raw_inputs
        if str(input_id).strip()
    ]
    if not inputs:
        return False

    match_mode = raw_condition.get("match")
    if not isinstance(match_mode, str):
        match_mode = "all_present"

    if match_mode == "all_present":
        return all(input_id in provided_input_ids for input_id in inputs)
    if match_mode == "all_missing":
        return all(input_id not in provided_input_ids for input_id in inputs)
    if match_mode == "any_present":
        return any(input_id in provided_input_ids for input_id in inputs)
    if match_mode == "any_missing":
        return any(input_id not in provided_input_ids for input_id in inputs)
    return False


def _resolve_conditional_bool(
    default_value: bool,
    raw_overrides: Any,
    provided_input_ids: set[str],
) -> bool:
    if not isinstance(raw_overrides, list):
        return default_value

    for raw_override in raw_overrides:
        if not isinstance(raw_override, dict):
            continue
        if not _matches_input_presence_condition(
            raw_override.get("when"), provided_input_ids
        ):
            continue
        return _to_bool(raw_override.get("value"), default_value)

    return default_value


def _apply_widget_default_overrides(
    workflow: WorkflowPrompt,
    node_rules: dict[str, Any],
    provided_input_ids: set[str],
) -> None:
    for node_id, node_rule in node_rules.items():
        if not isinstance(node_rule, dict):
            continue

        widgets = node_rule.get("widgets")
        if not isinstance(widgets, dict):
            continue

        workflow_node = workflow.get(node_id)
        if not isinstance(workflow_node, dict):
            continue

        inputs = workflow_node.get("inputs")
        if not isinstance(inputs, dict):
            continue

        for param, widget_rule in widgets.items():
            if not isinstance(param, str) or not param:
                continue
            if not isinstance(widget_rule, dict):
                continue
            if param not in inputs:
                continue

            current_value = inputs.get(param)
            if isinstance(current_value, list) and len(current_value) == 2:
                continue

            raw_overrides = widget_rule.get("default_overrides")
            if not isinstance(raw_overrides, list):
                continue

            for raw_override in raw_overrides:
                if not isinstance(raw_override, dict):
                    continue
                if not _matches_input_presence_condition(
                    raw_override.get("when"), provided_input_ids
                ):
                    continue
                inputs[param] = raw_override.get("value")
                break


def find_unsatisfied_input_conditions(
    rules: WorkflowRules | None,
    provided_input_ids: set[str] | None,
) -> list[str]:
    if not isinstance(rules, dict):
        return []

    normalized_provided = _normalize_provided_input_ids(provided_input_ids)
    raw_conditions = rules.get("input_conditions")
    if not isinstance(raw_conditions, list):
        return []

    unsatisfied: list[str] = []
    for raw_condition in raw_conditions:
        if not isinstance(raw_condition, dict):
            continue

        kind = raw_condition.get("kind")
        raw_inputs = raw_condition.get("inputs")
        if kind != "at_least_one" or not isinstance(raw_inputs, list):
            continue

        inputs = [
            str(input_id).strip()
            for input_id in raw_inputs
            if str(input_id).strip()
        ]
        if not inputs:
            continue

        if any(input_id in normalized_provided for input_id in inputs):
            continue

        raw_message = raw_condition.get("message")
        if isinstance(raw_message, str) and raw_message.strip():
            unsatisfied.append(raw_message.strip())
            continue

        unsatisfied.append(
            "At least one of the following inputs must be provided: "
            + ", ".join(inputs)
        )

    return unsatisfied


def apply_rules_to_workflow(
    workflow: WorkflowPrompt,
    rules: WorkflowRules | None,
    provided_input_ids: set[str] | None = None,
    *,
    rules_already_resolved: bool = False,
) -> tuple[WorkflowPrompt, list[WorkflowRuleWarning]]:
    if not isinstance(workflow, dict):
        return workflow, [
            _warning(
                "invalid_workflow_prompt",
                "Workflow prompt must be an object; manual rules were skipped",
            )
        ]

    warnings: list[WorkflowRuleWarning] = []
    if rules_already_resolved:
        try:
            resolved_rules = (
                rules
                if isinstance(rules, ResolvedWorkflowRules)
                else ResolvedWorkflowRules.model_validate(rules or {})
            )
            normalized_rules = dump_resolved_rules(resolved_rules)
        except ValidationError as exc:
            return deepcopy(workflow), [
                _warning(
                    "invalid_resolved_rules_payload",
                    "Resolved workflow rules payload is invalid; manual rules were skipped",
                    details={"errors": exc.errors()},
                )
            ]
    else:
        normalized_rules, normalize_warnings = normalize_rules(rules)
        warnings.extend(normalize_warnings)
    next_workflow = deepcopy(workflow)
    normalized_provided_inputs = _normalize_provided_input_ids(provided_input_ids)

    output_injections = normalized_rules.get("output_injections", {})
    if isinstance(output_injections, dict):
        for target_node_id in sorted(output_injections.keys()):
            target_outputs = output_injections.get(target_node_id, {})
            if not isinstance(target_outputs, dict):
                continue

            for output_index_key in sorted(
                target_outputs.keys(), key=lambda key: _to_int(key) or 0
            ):
                injection_rule = target_outputs.get(output_index_key, {})
                if not isinstance(injection_rule, dict):
                    continue
                raw_when = injection_rule.get("when")
                if raw_when is not None and not _matches_input_presence_condition(
                    raw_when, normalized_provided_inputs
                ):
                    continue
                output_index = _to_int(output_index_key)
                if output_index is None:
                    continue
                if target_node_id not in next_workflow:
                    warnings.append(
                        _warning(
                            "injection_target_missing",
                            "Injection target node not found in workflow; skipping",
                            node_id=target_node_id,
                            output_index=output_index,
                        )
                    )
                    continue

                source = injection_rule.get("source")
                if not isinstance(source, dict):
                    warnings.append(
                        _warning(
                            "injection_source_missing",
                            "Injection source is missing; skipping",
                            node_id=target_node_id,
                            output_index=output_index,
                        )
                    )
                    continue

                source_kind = source.get("kind")
                if source_kind == "node_output":
                    source_node_id = source.get("node_id")
                    source_output_index = _to_int(source.get("output_index"))
                    if not isinstance(source_node_id, str) or source_output_index is None:
                        warnings.append(
                            _warning(
                                "invalid_node_output_source",
                                "node_output source is invalid; skipping",
                                node_id=target_node_id,
                                output_index=output_index,
                            )
                        )
                        continue

                    if source_node_id not in next_workflow:
                        warnings.append(
                            _warning(
                                "injection_source_missing",
                                "Injection source node not found in workflow; skipping",
                                node_id=target_node_id,
                                output_index=output_index,
                                details={"source_node_id": source_node_id},
                            )
                        )
                        continue

                    rewrites = _rewrite_output_links(
                        next_workflow,
                        target_node_id=target_node_id,
                        target_output_index=output_index,
                        replacement_node_id=source_node_id,
                        replacement_output_index=source_output_index,
                    )
                    if rewrites == 0:
                        warnings.append(
                            _warning(
                                "injection_no_consumers",
                                "No downstream links matched this injection target",
                                node_id=target_node_id,
                                output_index=output_index,
                            )
                        )
                else:
                    warnings.append(
                        _warning(
                            "unsupported_source_kind",
                            "Unsupported injection source kind; using default routing",
                            node_id=target_node_id,
                            output_index=output_index,
                            details={"kind": source_kind},
                        )
                    )

    node_rules = normalized_rules.get("nodes", {})
    ignored_nodes: set[str] = set()
    downstream_prune_roots: set[str] = set()
    if isinstance(node_rules, dict):
        _apply_widget_default_overrides(
            next_workflow,
            node_rules,
            normalized_provided_inputs,
        )

        for node_id, node_rule in node_rules.items():
            if not isinstance(node_rule, dict):
                continue
            should_ignore = _resolve_conditional_bool(
                _to_bool(node_rule.get("ignore"), False),
                node_rule.get("ignore_overrides"),
                normalized_provided_inputs,
            )
            if should_ignore:
                ignored_nodes.add(str(node_id))
        for node_id, node_rule in node_rules.items():
            if not isinstance(node_rule, dict):
                continue
            present = node_rule.get("present")
            if not isinstance(present, dict):
                continue
            if present.get("required", True) is not False:
                continue
            normalized_node_id = str(node_id)
            if normalized_node_id in normalized_provided_inputs:
                continue
            if normalized_node_id not in next_workflow:
                warnings.append(
                    _warning(
                        "optional_input_node_missing",
                        "Optional input node not found in workflow; skipping bypass",
                        node_id=normalized_node_id,
                    )
                )
                continue

            downstream_prune_roots.update(
                _disconnect_output_links_from_node(next_workflow, normalized_node_id)
            )
            ignored_nodes.add(normalized_node_id)

    reachable_from_provided_inputs = _collect_reachable_descendants(
        next_workflow,
        {
            input_id
            for input_id in normalized_provided_inputs
            if ":" not in input_id
        },
    )
    ignored_nodes.update(
        _collect_nodes_with_missing_required_inputs(
            next_workflow,
            set(next_workflow.keys()) | downstream_prune_roots,
            reachable_from_provided_inputs,
        )
    )

    removable_roots: set[str] = set()
    for node_id in sorted(ignored_nodes):
        if node_id not in next_workflow:
            warnings.append(
                _warning(
                    "ignored_node_missing",
                    "Ignored node not found in workflow; skipping",
                    node_id=node_id,
                )
            )
            continue

        references = _find_references_to_node(next_workflow, node_id)
        if references:
            warnings.append(
                _warning(
                    "ignored_node_still_referenced",
                    "Ignored node is still referenced after rewrites; keeping default path",
                    node_id=node_id,
                    details={"references": references[:10]},
                )
            )
            continue

        removable_roots.add(node_id)

    if not removable_roots:
        return next_workflow, warnings

    parents, consumers = _extract_dependencies(next_workflow)
    remove_set: set[str] = set(removable_roots)
    queue: deque[str] = deque()
    for root in removable_roots:
        queue.extend(sorted(parents.get(root, set())))

    while queue:
        candidate = queue.popleft()
        if candidate in remove_set:
            continue
        candidate_consumers = consumers.get(candidate, set())
        if any(consumer not in remove_set for consumer in candidate_consumers):
            continue
        remove_set.add(candidate)
        queue.extend(sorted(parents.get(candidate, set())))

    for node_id in remove_set:
        next_workflow.pop(node_id, None)

    return next_workflow, warnings


__all__ = ["apply_rules_to_workflow", "find_unsatisfied_input_conditions"]
