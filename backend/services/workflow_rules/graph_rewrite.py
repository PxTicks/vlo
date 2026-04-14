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
from services.workflow_rules.object_info import (
    get_required_input_params_for_class,
    get_widget_value_index_map,
    is_output_node_class,
)
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


def _is_scalar_graph_widget_value(value: Any) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def _get_graph_variable_name(graph_node: dict[str, Any]) -> str | None:
    if graph_node.get("type") not in {"GetNode", "SetNode"}:
        return None

    raw_widgets = graph_node.get("widgets_values")
    if not isinstance(raw_widgets, list) or not raw_widgets:
        return None

    raw_name = raw_widgets[0]
    if not isinstance(raw_name, str) or not raw_name.strip():
        return None
    return raw_name.strip()


def _workflow_has_output_nodes(workflow: WorkflowPrompt) -> bool:
    for node_data in workflow.values():
        if not isinstance(node_data, dict):
            continue
        class_type = node_data.get("class_type")
        if isinstance(class_type, str) and is_output_node_class(class_type):
            return True
    return False


def _build_prompt_node_from_graph_node(
    graph_node: dict[str, Any],
    graph_links_by_id: dict[int, list[Any]],
) -> dict[str, Any] | None:
    class_type = graph_node.get("type")
    if not isinstance(class_type, str) or not class_type.strip():
        return None

    inputs: dict[str, Any] = {}
    raw_inputs = graph_node.get("inputs")
    if isinstance(raw_inputs, list):
        for input_entry in raw_inputs:
            if not isinstance(input_entry, dict):
                continue

            input_name = input_entry.get("name")
            if not isinstance(input_name, str) or not input_name.strip():
                continue

            link_id = input_entry.get("link")
            if not isinstance(link_id, int):
                continue

            link_entry = graph_links_by_id.get(link_id)
            if not isinstance(link_entry, list) or len(link_entry) < 5:
                continue

            output_index = _to_int(link_entry[2])
            if output_index is None:
                continue

            source_node_id = str(link_entry[1]).strip()
            if not source_node_id:
                continue

            inputs[input_name] = [source_node_id, output_index]

    raw_widgets = graph_node.get("widgets_values")
    if isinstance(raw_widgets, dict):
        for param, value in raw_widgets.items():
            if (
                isinstance(param, str)
                and param not in inputs
                and _is_scalar_graph_widget_value(value)
            ):
                inputs[param] = value
    elif isinstance(raw_widgets, list):
        widget_index_map = get_widget_value_index_map(class_type)
        for param, widget_index in widget_index_map.items():
            if param in inputs:
                continue
            if not (0 <= widget_index < len(raw_widgets)):
                continue

            value = raw_widgets[widget_index]
            if _is_scalar_graph_widget_value(value):
                inputs[param] = value

    prompt_node: dict[str, Any] = {
        "class_type": class_type,
        "inputs": inputs,
    }

    title = graph_node.get("title")
    if isinstance(title, str) and title.strip():
        prompt_node["_meta"] = {"title": title}

    return prompt_node


def _recover_output_reachable_prompt_from_graph_data(
    graph_data: dict[str, Any] | None,
) -> WorkflowPrompt:
    if not isinstance(graph_data, dict):
        return {}

    raw_nodes = graph_data.get("nodes")
    raw_links = graph_data.get("links")
    if not isinstance(raw_nodes, list) or not isinstance(raw_links, list):
        return {}

    graph_nodes_by_id: dict[str, dict[str, Any]] = {}
    graph_links_by_id: dict[int, list[Any]] = {}
    graph_parents: dict[str, set[str]] = {}
    set_nodes_by_name: dict[str, set[str]] = {}

    for raw_node in raw_nodes:
        if not isinstance(raw_node, dict):
            continue
        node_id = str(raw_node.get("id")).strip()
        if not node_id:
            continue

        graph_nodes_by_id[node_id] = raw_node
        graph_parents.setdefault(node_id, set())

        variable_name = _get_graph_variable_name(raw_node)
        if variable_name is not None and raw_node.get("type") == "SetNode":
            set_nodes_by_name.setdefault(variable_name, set()).add(node_id)

    for raw_link in raw_links:
        if (
            not isinstance(raw_link, list)
            or len(raw_link) < 5
            or not isinstance(raw_link[0], int)
        ):
            continue

        link_id = raw_link[0]
        source_node_id = str(raw_link[1]).strip()
        consumer_node_id = str(raw_link[3]).strip()
        if not source_node_id or not consumer_node_id:
            continue

        graph_links_by_id[link_id] = raw_link
        graph_parents.setdefault(consumer_node_id, set()).add(source_node_id)
        graph_parents.setdefault(source_node_id, set())

    queue: deque[str] = deque(
        sorted(
            node_id
            for node_id, raw_node in graph_nodes_by_id.items()
            if isinstance(raw_node.get("type"), str)
            and is_output_node_class(raw_node["type"])
        )
    )
    if not queue:
        return {}

    keep_node_ids: set[str] = set()
    while queue:
        node_id = queue.popleft()
        if node_id in keep_node_ids:
            continue

        keep_node_ids.add(node_id)
        queue.extend(sorted(graph_parents.get(node_id, set())))

        graph_node = graph_nodes_by_id.get(node_id)
        if not isinstance(graph_node, dict):
            continue

        variable_name = _get_graph_variable_name(graph_node)
        if variable_name is None or graph_node.get("type") != "GetNode":
            continue

        queue.extend(sorted(set_nodes_by_name.get(variable_name, set())))

    recovered_prompt: WorkflowPrompt = {}
    for node_id in sorted(keep_node_ids):
        graph_node = graph_nodes_by_id.get(node_id)
        if not isinstance(graph_node, dict):
            continue

        prompt_node = _build_prompt_node_from_graph_node(
            graph_node,
            graph_links_by_id,
        )
        if prompt_node is not None:
            recovered_prompt[node_id] = prompt_node

    return recovered_prompt


def _merge_recovered_prompt(
    workflow: WorkflowPrompt,
    recovered_prompt: WorkflowPrompt,
) -> WorkflowPrompt:
    merged_workflow: WorkflowPrompt = deepcopy(recovered_prompt)

    for node_id, node_data in workflow.items():
        normalized_node_id = str(node_id)
        if not isinstance(node_data, dict):
            merged_workflow[normalized_node_id] = deepcopy(node_data)
            continue

        existing_node = merged_workflow.get(normalized_node_id)
        next_node = deepcopy(existing_node) if isinstance(existing_node, dict) else {}

        for key, value in node_data.items():
            if key == "inputs" and isinstance(value, dict):
                existing_inputs = next_node.get("inputs")
                if not isinstance(existing_inputs, dict):
                    existing_inputs = {}
                existing_inputs.update(deepcopy(value))
                next_node["inputs"] = existing_inputs
                continue

            next_node[key] = deepcopy(value)

        merged_workflow[normalized_node_id] = next_node

    return merged_workflow


def _build_graph_consumer_index(
    graph_data: dict[str, Any] | None,
) -> dict[tuple[str, int], list[tuple[str, str]]]:
    if not isinstance(graph_data, dict):
        return {}

    raw_nodes = graph_data.get("nodes")
    raw_links = graph_data.get("links")
    if not isinstance(raw_nodes, list) or not isinstance(raw_links, list):
        return {}

    nodes_by_id: dict[str, dict[str, Any]] = {}
    for raw_node in raw_nodes:
        if not isinstance(raw_node, dict):
            continue
        node_id = str(raw_node.get("id")).strip()
        if not node_id:
            continue
        nodes_by_id[node_id] = raw_node

    consumer_index: dict[tuple[str, int], list[tuple[str, str]]] = {}
    for raw_link in raw_links:
        if not isinstance(raw_link, list) or len(raw_link) < 5:
            continue

        output_index = _to_int(raw_link[2])
        input_index = _to_int(raw_link[4])
        if output_index is None or input_index is None:
            continue

        source_node_id = str(raw_link[1]).strip()
        consumer_node_id = str(raw_link[3]).strip()
        if not source_node_id or not consumer_node_id:
            continue

        consumer_node = nodes_by_id.get(consumer_node_id)
        if not isinstance(consumer_node, dict):
            continue

        raw_inputs = consumer_node.get("inputs")
        if not isinstance(raw_inputs, list) or input_index >= len(raw_inputs):
            continue

        input_entry = raw_inputs[input_index]
        if not isinstance(input_entry, dict):
            continue

        input_name = input_entry.get("name")
        if not isinstance(input_name, str) or not input_name.strip():
            continue

        consumer_index.setdefault((source_node_id, output_index), []).append(
            (consumer_node_id, input_name)
        )

    return consumer_index


def _rewrite_output_links_from_graph_data(
    workflow: WorkflowPrompt,
    graph_consumer_index: dict[tuple[str, int], list[tuple[str, str]]],
    target_node_id: str,
    target_output_index: int,
    replacement_node_id: str,
    replacement_output_index: int,
) -> int:
    rewrites = 0
    for consumer_node_id, input_name in graph_consumer_index.get(
        (target_node_id, target_output_index), []
    ):
        node_data = workflow.get(consumer_node_id)
        if not isinstance(node_data, dict):
            continue

        inputs = node_data.get("inputs")
        if not isinstance(inputs, dict):
            inputs = {}
            node_data["inputs"] = inputs

        current_value = inputs.get(input_name)
        if isinstance(current_value, list) and len(current_value) == 2:
            if _is_output_link_to(current_value, replacement_node_id, replacement_output_index):
                continue
            if not _is_output_link_to(current_value, target_node_id, target_output_index):
                continue

        inputs[input_name] = [replacement_node_id, replacement_output_index]
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
    provided_input_node_ids: set[str],
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
        if node_id in provided_input_node_ids:
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
    graph_data: dict[str, Any] | None = None,
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

    if not _workflow_has_output_nodes(next_workflow):
        recovered_prompt = _recover_output_reachable_prompt_from_graph_data(graph_data)
        if recovered_prompt:
            # Rehydrate the authored output-connected graph when graphToPrompt()
            # drops terminal branches before backend rules can repair them.
            next_workflow = _merge_recovered_prompt(next_workflow, recovered_prompt)

    normalized_provided_inputs = _normalize_provided_input_ids(provided_input_ids)
    graph_consumer_index = _build_graph_consumer_index(graph_data)

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
                target_missing = target_node_id not in next_workflow
                has_graph_consumers = bool(
                    graph_consumer_index.get((target_node_id, output_index))
                )
                has_prompt_consumers = bool(
                    _find_references_to_node(next_workflow, target_node_id)
                )
                if target_missing and not has_graph_consumers and not has_prompt_consumers:
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
                    rewrites += _rewrite_output_links_from_graph_data(
                        next_workflow,
                        graph_consumer_index,
                        target_node_id=target_node_id,
                        target_output_index=output_index,
                        replacement_node_id=source_node_id,
                        replacement_output_index=source_output_index,
                    )
                    if rewrites == 0:
                        warning_code = (
                            "injection_target_missing"
                            if target_node_id not in next_workflow
                            else "injection_no_consumers"
                        )
                        warning_message = (
                            "Injection target node not found in workflow; skipping"
                            if target_node_id not in next_workflow
                            else "No downstream links matched this injection target"
                        )
                        warnings.append(
                            _warning(
                                warning_code,
                                warning_message,
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

    provided_input_node_ids = {
        input_id for input_id in normalized_provided_inputs if ":" not in input_id
    }
    ignored_nodes.update(
        _collect_nodes_with_missing_required_inputs(
            next_workflow,
            downstream_prune_roots,
            provided_input_node_ids,
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
