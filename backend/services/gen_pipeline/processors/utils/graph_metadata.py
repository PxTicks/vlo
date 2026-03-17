from __future__ import annotations

from copy import deepcopy
from typing import Any

from services.workflow_rules.object_info import get_widget_value_index_map


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _parse_link_value(value: Any) -> tuple[str, int] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    source_node_id, output_index = value
    if not isinstance(source_node_id, (str, int)) or not isinstance(output_index, int):
        return None
    return str(source_node_id), output_index


def _is_scalar_widget_value(value: Any) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def _build_graph_nodes_by_id(
    graph_data: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    nodes = graph_data.get("nodes")
    if not isinstance(nodes, list):
        return result

    for node in nodes:
        if not _is_record(node):
            continue
        node_id = node.get("id")
        if isinstance(node_id, (str, int)):
            result[str(node_id)] = node

    return result


def _build_graph_input_index(
    graph_node: dict[str, Any],
) -> dict[str, tuple[int, dict[str, Any]]]:
    result: dict[str, tuple[int, dict[str, Any]]] = {}
    inputs = graph_node.get("inputs")
    if not isinstance(inputs, list):
        return result

    for input_index, input_entry in enumerate(inputs):
        if not _is_record(input_entry):
            continue
        name = input_entry.get("name")
        if isinstance(name, str) and name not in result:
            result[name] = (input_index, input_entry)

        widget = input_entry.get("widget")
        if _is_record(widget):
            widget_name = widget.get("name")
            if isinstance(widget_name, str) and widget_name not in result:
                result[widget_name] = (input_index, input_entry)

    return result


def _get_widget_name(input_entry: dict[str, Any]) -> str | None:
    widget = input_entry.get("widget")
    if not _is_record(widget):
        return None
    widget_name = widget.get("name")
    return widget_name if isinstance(widget_name, str) else None


def _resolve_widget_index_map(
    graph_data: dict[str, Any],
    node_id: str,
    class_type: str | None,
) -> dict[str, int]:
    result: dict[str, int] = {}

    widget_idx_map = graph_data.get("widget_idx_map")
    if _is_record(widget_idx_map):
        raw_node_map = widget_idx_map.get(node_id)
        if _is_record(raw_node_map):
            for param, idx in raw_node_map.items():
                if isinstance(param, str) and isinstance(idx, int) and idx >= 0:
                    result[param] = idx

    if isinstance(class_type, str):
        for param, idx in get_widget_value_index_map(class_type).items():
            result.setdefault(param, idx)

    return result


def _ensure_widget_slot(
    graph_node: dict[str, Any],
    widget_index: int,
) -> list[Any] | None:
    widgets_values = graph_node.get("widgets_values")
    if not isinstance(widgets_values, list):
        return None

    while len(widgets_values) <= widget_index:
        widgets_values.append(None)
    return widgets_values


def _find_output_position(
    graph_node: dict[str, Any],
    output_slot: int,
) -> int | None:
    outputs = graph_node.get("outputs")
    if not isinstance(outputs, list):
        return None

    for output_index, output_entry in enumerate(outputs):
        if not _is_record(output_entry):
            continue
        if output_entry.get("slot_index") == output_slot:
            return output_index

    if 0 <= output_slot < len(outputs):
        return output_slot
    return None


def _remove_output_link(graph_node: dict[str, Any], link_id: int) -> None:
    outputs = graph_node.get("outputs")
    if not isinstance(outputs, list):
        return

    for output_entry in outputs:
        if not _is_record(output_entry):
            continue
        links = output_entry.get("links")
        if isinstance(links, list):
            output_entry["links"] = [
                existing_link_id
                for existing_link_id in links
                if existing_link_id != link_id
            ] or None


def _ensure_output_link(
    graph_node: dict[str, Any],
    output_slot: int,
    link_id: int,
) -> None:
    output_position = _find_output_position(graph_node, output_slot)
    if output_position is None:
        return

    outputs = graph_node.get("outputs")
    if not isinstance(outputs, list):
        return
    output_entry = outputs[output_position]
    if not _is_record(output_entry):
        return

    links = output_entry.get("links")
    if not isinstance(links, list):
        output_entry["links"] = [link_id]
        return
    if link_id not in links:
        links.append(link_id)


def _find_link_index(links: list[Any], link_id: int) -> int | None:
    for index, link_entry in enumerate(links):
        if (
            isinstance(link_entry, list)
            and len(link_entry) >= 1
            and link_entry[0] == link_id
        ):
            return index
    return None


def _remove_link(
    graph_data: dict[str, Any],
    graph_nodes_by_id: dict[str, dict[str, Any]],
    link_id: int,
) -> None:
    links = graph_data.get("links")
    if not isinstance(links, list):
        return

    link_index = _find_link_index(links, link_id)
    if link_index is None:
        return

    link_entry = links.pop(link_index)
    if isinstance(link_entry, list) and len(link_entry) >= 2:
        source_node = graph_nodes_by_id.get(str(link_entry[1]))
        if source_node is not None:
            _remove_output_link(source_node, link_id)


def _next_link_id(graph_data: dict[str, Any]) -> int:
    raw_last_link_id = graph_data.get("last_link_id")
    if isinstance(raw_last_link_id, int):
        next_link_id = raw_last_link_id + 1
    else:
        links = graph_data.get("links")
        max_link_id = 0
        if isinstance(links, list):
            for link_entry in links:
                if (
                    isinstance(link_entry, list)
                    and len(link_entry) >= 1
                    and isinstance(link_entry[0], int)
                ):
                    max_link_id = max(max_link_id, link_entry[0])
        next_link_id = max_link_id + 1

    graph_data["last_link_id"] = next_link_id
    return next_link_id


def _sync_link_input(
    graph_data: dict[str, Any],
    graph_nodes_by_id: dict[str, dict[str, Any]],
    dst_node: dict[str, Any],
    input_index: int,
    input_entry: dict[str, Any],
    source_node_id: str,
    output_index: int,
) -> None:
    source_node = graph_nodes_by_id.get(source_node_id)
    if source_node is None:
        return

    links = graph_data.get("links")
    if not isinstance(links, list):
        links = []
        graph_data["links"] = links

    current_link_id = input_entry.get("link")
    if not isinstance(current_link_id, int):
        current_link_id = _next_link_id(graph_data)

    existing_link_index = _find_link_index(links, current_link_id)
    if existing_link_index is not None:
        existing_link = links[existing_link_index]
        if isinstance(existing_link, list) and len(existing_link) >= 2:
            old_source_node = graph_nodes_by_id.get(str(existing_link[1]))
            if old_source_node is not None:
                _remove_output_link(old_source_node, current_link_id)
        if isinstance(existing_link, list):
            while len(existing_link) < 6:
                existing_link.append(None)
            existing_link[1] = source_node.get("id")
            existing_link[2] = output_index
            existing_link[3] = dst_node.get("id")
            existing_link[4] = input_index
            existing_link[5] = input_entry.get("type")
    else:
        links.append(
            [
                current_link_id,
                source_node.get("id"),
                output_index,
                dst_node.get("id"),
                input_index,
                input_entry.get("type"),
            ]
        )

    input_entry["link"] = current_link_id
    _ensure_output_link(source_node, output_index, current_link_id)


def project_prompt_to_graph_data(
    workflow: dict[str, Any],
    graph_data: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Project final prompt values back onto the visual workflow where possible."""
    if graph_data is None:
        return None
    if not _is_record(graph_data):
        return graph_data
    if not isinstance(graph_data.get("nodes"), list):
        return graph_data

    projected_graph = deepcopy(graph_data)
    graph_nodes_by_id = _build_graph_nodes_by_id(projected_graph)
    if not graph_nodes_by_id:
        return projected_graph

    for node_id, prompt_node in workflow.items():
        if not _is_record(prompt_node):
            continue

        graph_node = graph_nodes_by_id.get(str(node_id))
        if graph_node is None:
            continue

        prompt_inputs = prompt_node.get("inputs")
        if not _is_record(prompt_inputs):
            continue

        class_type = prompt_node.get("class_type")
        graph_input_index = _build_graph_input_index(graph_node)
        widget_index_map = _resolve_widget_index_map(
            projected_graph,
            str(node_id),
            class_type if isinstance(class_type, str) else None,
        )

        for param, value in prompt_inputs.items():
            if not isinstance(param, str):
                continue

            link_value = _parse_link_value(value)
            input_match = graph_input_index.get(param)
            if link_value is not None:
                if input_match is None:
                    continue
                input_index, input_entry = input_match
                _sync_link_input(
                    projected_graph,
                    graph_nodes_by_id,
                    graph_node,
                    input_index,
                    input_entry,
                    link_value[0],
                    link_value[1],
                )
                continue

            widget_index = widget_index_map.get(param)
            if widget_index is None or not _is_scalar_widget_value(value):
                continue

            if input_match is not None:
                _, input_entry = input_match
                widget_name = _get_widget_name(input_entry)
                if widget_name != param:
                    continue
                current_link_id = input_entry.get("link")
                if isinstance(current_link_id, int):
                    _remove_link(projected_graph, graph_nodes_by_id, current_link_id)
                    input_entry["link"] = None

            widgets_values = _ensure_widget_slot(graph_node, widget_index)
            if widgets_values is None:
                continue
            widgets_values[widget_index] = value

    return projected_graph


__all__ = ["project_prompt_to_graph_data"]
