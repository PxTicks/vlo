import json
from copy import deepcopy
from pathlib import Path
from typing import Any


WorkflowRuleWarning = dict[str, Any]
WorkflowRules = dict[str, Any]
WorkflowPrompt = dict[str, Any]

SUPPORTED_SLOT_INPUT_TYPES = {
    "text",
    "image",
    "video",
    "audio",
    "frame_batch",
}
SUPPORTED_POSTPROCESS_MODES = {
    "auto",
    "stitch_frames_with_audio",
    "none",
}
SUPPORTED_POSTPROCESS_PANEL_PREVIEWS = {
    "raw_outputs",
    "replace_outputs",
}
SUPPORTED_POSTPROCESS_ON_FAILURE = {
    "fallback_raw",
    "show_error",
}
SUPPORTED_MASK_CROPPING_MODES = {
    "crop",
    "full",
}
SUPPORTED_AR_POSTPROCESS_MODES = {
    "stretch_exact",
}
SUPPORTED_AR_POSTPROCESS_APPLY_TO = {
    "all_visual_outputs",
}
SUPPORTED_WIDGETS_MODE = {
    "control_after_generate",
    "all",
}
SUPPORTED_VALIDATION_INPUT_RULE_KINDS = {
    "required",
    "at_least_n",
    "optional",
}
SUPPORTED_INPUT_CONDITION_KINDS = {
    "at_least_one",
}
SUPPORTED_WIDGET_VALUE_TYPES = {
    "int",
    "float",
    "string",
    "boolean",
    "enum",
    "unknown",
}


def _warning(
    code: str,
    message: str,
    node_id: str | None = None,
    output_index: int | None = None,
    details: dict[str, Any] | None = None,
) -> WorkflowRuleWarning:
    warning: WorkflowRuleWarning = {
        "code": code,
        "message": message,
    }
    if node_id is not None:
        warning["node_id"] = node_id
    if output_index is not None:
        warning["output_index"] = output_index
    if details:
        warning["details"] = details
    return warning


def default_rules() -> WorkflowRules:
    return {
        "version": 1,
        "nodes": {},
        "validation": {
            "inputs": [],
        },
        "output_injections": {},
        "slots": {},
        "mask_cropping": {
            "mode": "crop",
        },
        "postprocessing": {
            "mode": "auto",
            "panel_preview": "raw_outputs",
            "on_failure": "fallback_raw",
        },
        "aspect_ratio_processing": {
            "enabled": False,
            "stride": 16,
            "search_steps": 2,
            "resolutions": [],
            "target_nodes": [],
            "postprocess": {
                "enabled": True,
                "mode": "stretch_exact",
                "apply_to": "all_visual_outputs",
            },
        },
    }


def _to_bool(value: Any, fallback: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    return fallback


def _to_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("-"):
            return None
        if stripped.isdigit():
            return int(stripped)
    return None


def _to_positive_int(value: Any) -> int | None:
    parsed = _to_int(value)
    if parsed is None or parsed <= 0:
        return None
    return parsed


def _to_non_negative_int(value: Any) -> int | None:
    parsed = _to_int(value)
    if parsed is None or parsed < 0:
        return None
    return parsed


def _is_safe_workflow_filename(filename: str) -> bool:
    return not (
        ".." in filename
        or "/" in filename
        or "\\" in filename
        or filename.strip() == ""
    )


def sidecar_path_for_workflow(workflows_dir: Path, workflow_filename: str) -> Path:
    stem = Path(workflow_filename).stem
    return workflows_dir / f"{stem}.rules.json"


def _normalize_validation_input_rule(
    raw_rule: Any,
    *,
    index: int,
    warnings: list[WorkflowRuleWarning],
) -> dict[str, Any] | None:
    if not isinstance(raw_rule, dict):
        warnings.append(
            _warning(
                "invalid_validation_input_rule",
                "validation.inputs[*] must be an object",
                details={"index": index},
            )
        )
        return None

    raw_kind = raw_rule.get("kind")
    if not isinstance(raw_kind, str):
        warnings.append(
            _warning(
                "invalid_validation_input_rule_kind",
                "validation.inputs[*].kind must be a string",
                details={"index": index},
            )
        )
        return None

    kind = raw_kind.strip()
    if kind not in SUPPORTED_VALIDATION_INPUT_RULE_KINDS:
        warnings.append(
            _warning(
                "invalid_validation_input_rule_kind",
                "Unsupported validation input rule kind",
                details={"index": index, "kind": raw_kind},
            )
        )
        return None

    normalized_rule: dict[str, Any] = {"kind": kind}
    raw_message = raw_rule.get("message")
    if isinstance(raw_message, str) and raw_message.strip():
        normalized_rule["message"] = raw_message.strip()

    if kind in {"required", "optional"}:
        raw_input = raw_rule.get("input")
        if not isinstance(raw_input, str) or raw_input.strip() == "":
            warnings.append(
                _warning(
                    "invalid_validation_input_rule_input",
                    "validation.inputs[*].input must be a non-empty string",
                    details={"index": index, "kind": kind},
                )
            )
            return None
        normalized_rule["input"] = raw_input.strip()
        return normalized_rule

    raw_inputs = raw_rule.get("inputs")
    if not isinstance(raw_inputs, list):
        warnings.append(
            _warning(
                "invalid_validation_input_rule_inputs",
                "validation.inputs[*].inputs must be an array of input IDs",
                details={"index": index, "kind": kind},
            )
        )
        return None

    inputs = [
        input_id.strip()
        for input_id in raw_inputs
        if isinstance(input_id, str) and input_id.strip()
    ]
    if not inputs:
        warnings.append(
            _warning(
                "invalid_validation_input_rule_inputs",
                "validation.inputs[*].inputs must include at least one input ID",
                details={"index": index, "kind": kind},
            )
        )
        return None

    min_count = _to_positive_int(raw_rule.get("min"))
    if min_count is None:
        warnings.append(
            _warning(
                "invalid_validation_input_rule_min",
                "validation.inputs[*].min must be a positive integer",
                details={"index": index, "kind": kind},
            )
        )
        return None

    if min_count > len(inputs):
        warnings.append(
            _warning(
                "invalid_validation_input_rule_min",
                "validation.inputs[*].min cannot exceed the number of inputs",
                details={
                    "index": index,
                    "kind": kind,
                    "min": min_count,
                    "inputs_count": len(inputs),
                },
            )
        )
        return None

    normalized_rule["inputs"] = inputs
    normalized_rule["min"] = min_count
    return normalized_rule


def _normalize_legacy_input_condition(
    raw_condition: Any,
    *,
    index: int,
    warnings: list[WorkflowRuleWarning],
) -> dict[str, Any] | None:
    if not isinstance(raw_condition, dict):
        warnings.append(
            _warning(
                "invalid_input_condition",
                "Each input_conditions entry must be an object",
                details={"index": index},
            )
        )
        return None

    raw_kind = raw_condition.get("kind")
    if not isinstance(raw_kind, str):
        warnings.append(
            _warning(
                "invalid_input_condition_kind",
                "input_conditions[*].kind must be a string",
                details={"index": index},
            )
        )
        return None

    kind = raw_kind.strip()
    if kind not in SUPPORTED_INPUT_CONDITION_KINDS:
        warnings.append(
            _warning(
                "invalid_input_condition_kind",
                "Unsupported input condition kind",
                details={"index": index, "kind": raw_kind},
            )
        )
        return None

    raw_inputs = raw_condition.get("inputs")
    if not isinstance(raw_inputs, list):
        warnings.append(
            _warning(
                "invalid_input_condition_inputs",
                "input_conditions[*].inputs must be an array of input IDs",
                details={"index": index, "kind": kind},
            )
        )
        return None

    inputs = [
        input_id.strip()
        for input_id in raw_inputs
        if isinstance(input_id, str) and input_id.strip()
    ]
    if not inputs:
        warnings.append(
            _warning(
                "invalid_input_condition_inputs",
                "input_conditions[*].inputs must include at least one input ID",
                details={"index": index, "kind": kind},
            )
        )
        return None

    normalized_rule: dict[str, Any] = {
        "kind": "at_least_n",
        "inputs": inputs,
        "min": 1,
    }
    raw_message = raw_condition.get("message")
    if isinstance(raw_message, str) and raw_message.strip():
        normalized_rule["message"] = raw_message.strip()
    return normalized_rule


def normalize_rules(raw: Any) -> tuple[WorkflowRules, list[WorkflowRuleWarning]]:
    warnings: list[WorkflowRuleWarning] = []
    rules = default_rules()

    if raw is None:
        return rules, warnings

    if not isinstance(raw, dict):
        warnings.append(
            _warning(
                "invalid_rules_root",
                "Workflow rules must be a JSON object",
            )
        )
        return rules, warnings

    # Top-level metadata (not part of default_rules, just passed through)
    raw_name = raw.get("name")
    if isinstance(raw_name, str) and raw_name.strip():
        rules["name"] = raw_name.strip()

    version = raw.get("version", 1)
    if isinstance(version, int):
        rules["version"] = version
    else:
        warnings.append(
            _warning(
                "invalid_version",
                "Rules version must be an integer; defaulting to 1",
            )
        )

    raw_nodes = raw.get("nodes", {})
    if not isinstance(raw_nodes, dict):
        warnings.append(
            _warning(
                "invalid_nodes",
                "Rules 'nodes' must be an object",
            )
        )
        raw_nodes = {}

    normalized_nodes: dict[str, dict[str, Any]] = {}
    for raw_node_id, raw_node_rule in raw_nodes.items():
        node_id = str(raw_node_id)
        if not isinstance(raw_node_rule, dict):
            warnings.append(
                _warning(
                    "invalid_node_rule",
                    "Node rule must be an object",
                    node_id=node_id,
                )
            )
            continue

        node_rule: dict[str, Any] = {"ignore": _to_bool(raw_node_rule.get("ignore"), False)}

        raw_widgets_mode = raw_node_rule.get("widgets_mode")
        if isinstance(raw_widgets_mode, str):
            widgets_mode = raw_widgets_mode.strip()
            if widgets_mode in SUPPORTED_WIDGETS_MODE:
                node_rule["widgets_mode"] = widgets_mode
            elif widgets_mode:
                warnings.append(
                    _warning(
                        "invalid_widgets_mode",
                        "nodes.*.widgets_mode must be 'control_after_generate' or 'all'",
                        node_id=node_id,
                        details={"widgets_mode": raw_widgets_mode},
                    )
                )
        elif "widgets_mode" in raw_node_rule:
            warnings.append(
                _warning(
                    "invalid_widgets_mode",
                    "nodes.*.widgets_mode must be 'control_after_generate' or 'all'",
                    node_id=node_id,
                    details={"widgets_mode": raw_widgets_mode},
                )
            )

        raw_present = raw_node_rule.get("present")
        if isinstance(raw_present, dict):
            present: dict[str, Any] = {}
            if "enabled" in raw_present:
                present["enabled"] = _to_bool(raw_present.get("enabled"), True)
            if "required" in raw_present:
                present["required"] = _to_bool(raw_present.get("required"), True)
            if isinstance(raw_present.get("label"), str):
                present["label"] = raw_present["label"]
            if isinstance(raw_present.get("param"), str):
                present["param"] = raw_present["param"]
            if isinstance(raw_present.get("class_type"), str):
                present["class_type"] = raw_present["class_type"]
            if isinstance(raw_present.get("input_type"), str):
                input_type = raw_present["input_type"].strip()
                present["input_type"] = input_type
                if input_type not in SUPPORTED_SLOT_INPUT_TYPES:
                    warnings.append(
                        _warning(
                            "unsupported_present_input_type",
                            "Unsupported present.input_type; UI may treat this as inferred",
                            node_id=node_id,
                            details={"input_type": input_type},
                        )
                    )
            if present:
                node_rule["present"] = present

        raw_widgets = raw_node_rule.get("widgets")
        if isinstance(raw_widgets, dict):
            normalized_widgets: dict[str, dict[str, Any]] = {}
            for widget_name, raw_widget in raw_widgets.items():
                if not isinstance(widget_name, str) or not widget_name.strip():
                    continue
                if not isinstance(raw_widget, dict):
                    warnings.append(
                        _warning(
                            "invalid_widget_rule",
                            f"Widget rule for '{widget_name}' must be an object",
                            node_id=node_id,
                        )
                    )
                    continue

                widget_rule: dict[str, Any] = {}
                if isinstance(raw_widget.get("label"), str):
                    widget_rule["label"] = raw_widget["label"]
                widget_rule["control_after_generate"] = _to_bool(
                    raw_widget.get("control_after_generate"), False
                )
                if "default_randomize" in raw_widget:
                    widget_rule["default_randomize"] = _to_bool(
                        raw_widget.get("default_randomize"), False
                    )
                if isinstance(raw_widget.get("frontend_only"), bool):
                    widget_rule["frontend_only"] = raw_widget["frontend_only"]
                if isinstance(raw_widget.get("group_id"), str):
                    group_id = raw_widget["group_id"].strip()
                    if group_id:
                        widget_rule["group_id"] = group_id
                if isinstance(raw_widget.get("group_title"), str):
                    group_title = raw_widget["group_title"].strip()
                    if group_title:
                        widget_rule["group_title"] = group_title
                group_order = raw_widget.get("group_order")
                if isinstance(group_order, int) and not isinstance(group_order, bool):
                    if group_order >= 0:
                        widget_rule["group_order"] = group_order
                for num_key in ("min", "max"):
                    val = raw_widget.get(num_key)
                    if isinstance(val, (int, float)) and not isinstance(val, bool):
                        widget_rule[num_key] = val
                if "default" in raw_widget:
                    widget_rule["default"] = raw_widget["default"]
                raw_value_type = raw_widget.get("value_type")
                if isinstance(raw_value_type, str):
                    value_type = raw_value_type.strip().lower()
                    if value_type in SUPPORTED_WIDGET_VALUE_TYPES:
                        widget_rule["value_type"] = value_type
                    elif value_type:
                        warnings.append(
                            _warning(
                                "invalid_widget_value_type",
                                "Widget value_type is invalid; expected int|float|string|boolean|enum|unknown",
                                node_id=node_id,
                                details={
                                    "widget": widget_name,
                                    "value_type": raw_value_type,
                                },
                            )
                        )
                elif "value_type" in raw_widget:
                    warnings.append(
                        _warning(
                            "invalid_widget_value_type",
                            "Widget value_type is invalid; expected int|float|string|boolean|enum|unknown",
                            node_id=node_id,
                            details={
                                "widget": widget_name,
                                "value_type": raw_value_type,
                            },
                        )
                    )
                raw_options = raw_widget.get("options")
                if isinstance(raw_options, list):
                    normalized_options = [
                        option
                        for option in raw_options
                        if isinstance(option, (str, int, float, bool))
                    ]
                    if normalized_options:
                        widget_rule["options"] = normalized_options
                elif "options" in raw_widget:
                    warnings.append(
                        _warning(
                            "invalid_widget_options",
                            "Widget options must be an array of primitive values",
                            node_id=node_id,
                            details={"widget": widget_name},
                        )
                    )
                normalized_widgets[widget_name.strip()] = widget_rule

            if normalized_widgets:
                node_rule["widgets"] = normalized_widgets

        raw_selection = raw_node_rule.get("selection")
        if isinstance(raw_selection, dict):
            selection: dict[str, Any] = {}

            export_fps = _to_positive_int(raw_selection.get("export_fps"))
            if export_fps is not None:
                selection["export_fps"] = export_fps
            elif "export_fps" in raw_selection:
                warnings.append(
                    _warning(
                        "invalid_node_selection_export_fps",
                        "Node selection.export_fps must be a positive integer",
                        node_id=node_id,
                    )
                )

            frame_step = _to_positive_int(raw_selection.get("frame_step"))
            if frame_step is not None:
                selection["frame_step"] = frame_step
            elif "frame_step" in raw_selection:
                warnings.append(
                    _warning(
                        "invalid_node_selection_frame_step",
                        "Node selection.frame_step must be a positive integer",
                        node_id=node_id,
                    )
                )

            max_frames = _to_positive_int(raw_selection.get("max_frames"))
            if max_frames is not None:
                selection["max_frames"] = max_frames
            elif "max_frames" in raw_selection:
                warnings.append(
                    _warning(
                        "invalid_node_selection_max_frames",
                        "Node selection.max_frames must be a positive integer",
                        node_id=node_id,
                    )
                )

            if selection:
                node_rule["selection"] = selection

        for mask_key in ("binary_derived_mask_of", "soft_derived_mask_of"):
            raw_val = raw_node_rule.get(mask_key)
            if isinstance(raw_val, str) and raw_val.strip():
                node_rule[mask_key] = raw_val.strip()

        normalized_nodes[node_id] = node_rule

    rules["nodes"] = normalized_nodes

    raw_slots = raw.get("slots", {})
    if not isinstance(raw_slots, dict):
        warnings.append(
            _warning(
                "invalid_slots",
                "Rules 'slots' must be an object",
            )
        )
        raw_slots = {}

    normalized_slots: dict[str, dict[str, Any]] = {}
    for raw_slot_id, raw_slot_rule in raw_slots.items():
        slot_id = str(raw_slot_id)
        if not isinstance(raw_slot_rule, dict):
            warnings.append(
                _warning(
                    "invalid_slot_rule",
                    "Slot rule must be an object",
                    details={"slot_id": slot_id},
                )
            )
            continue

        slot_rule: dict[str, Any] = {}
        if isinstance(raw_slot_rule.get("input_type"), str):
            slot_rule["input_type"] = raw_slot_rule["input_type"]
        if isinstance(raw_slot_rule.get("label"), str):
            slot_rule["label"] = raw_slot_rule["label"]
        if isinstance(raw_slot_rule.get("param"), str):
            slot_rule["param"] = raw_slot_rule["param"]
        if "experimental" in raw_slot_rule:
            slot_rule["experimental"] = _to_bool(
                raw_slot_rule.get("experimental"), False
            )

        export_fps = _to_positive_int(raw_slot_rule.get("export_fps"))
        if export_fps is not None:
            slot_rule["export_fps"] = export_fps
        elif "export_fps" in raw_slot_rule:
            warnings.append(
                _warning(
                    "invalid_slot_export_fps",
                    "Slot export_fps must be a positive integer",
                    details={"slot_id": slot_id},
                )
            )

        frame_step = _to_positive_int(raw_slot_rule.get("frame_step"))
        if frame_step is not None:
            slot_rule["frame_step"] = frame_step
        elif "frame_step" in raw_slot_rule:
            warnings.append(
                _warning(
                    "invalid_slot_frame_step",
                    "Slot frame_step must be a positive integer",
                    details={"slot_id": slot_id},
                )
            )

        max_frames = _to_positive_int(raw_slot_rule.get("max_frames"))
        if max_frames is not None:
            slot_rule["max_frames"] = max_frames
        elif "max_frames" in raw_slot_rule:
            warnings.append(
                _warning(
                    "invalid_slot_max_frames",
                    "Slot max_frames must be a positive integer",
                    details={"slot_id": slot_id},
                )
            )
        if slot_rule:
            normalized_slots[slot_id] = slot_rule

    rules["slots"] = normalized_slots

    normalized_validation_inputs: list[dict[str, Any]] = []
    raw_validation = raw.get("validation")
    if raw_validation is not None and not isinstance(raw_validation, dict):
        warnings.append(
            _warning(
                "invalid_validation",
                "Rules 'validation' must be an object",
            )
        )
    elif isinstance(raw_validation, dict):
        raw_validation_inputs = raw_validation.get("inputs", [])
        if isinstance(raw_validation_inputs, list):
            for index, raw_rule in enumerate(raw_validation_inputs):
                normalized_rule = _normalize_validation_input_rule(
                    raw_rule,
                    index=index,
                    warnings=warnings,
                )
                if normalized_rule is not None:
                    normalized_validation_inputs.append(normalized_rule)
        elif "inputs" in raw_validation:
            warnings.append(
                _warning(
                    "invalid_validation_inputs",
                    "validation.inputs must be an array",
                )
            )

    raw_input_conditions = raw.get("input_conditions", [])
    normalized_input_conditions: list[dict[str, Any]] = []
    if isinstance(raw_input_conditions, list):
        for index, raw_condition in enumerate(raw_input_conditions):
            normalized_condition = _normalize_legacy_input_condition(
                raw_condition,
                index=index,
                warnings=warnings,
            )
            if normalized_condition is not None:
                normalized_input_conditions.append(
                    {
                        "kind": "at_least_one",
                        "inputs": normalized_condition["inputs"],
                        **(
                            {"message": normalized_condition["message"]}
                            if "message" in normalized_condition
                            else {}
                        ),
                    }
                )
                if not normalized_validation_inputs:
                    normalized_validation_inputs.append(normalized_condition)
    elif "input_conditions" in raw:
        warnings.append(
            _warning(
                "invalid_input_conditions",
                "Rules 'input_conditions' must be an array",
            )
        )

    rules["validation"] = {"inputs": normalized_validation_inputs}
    if normalized_input_conditions:
        rules["input_conditions"] = normalized_input_conditions

    raw_mask_cropping = raw.get("mask_cropping", {})
    if raw_mask_cropping is None:
        raw_mask_cropping = {}
    if not isinstance(raw_mask_cropping, dict):
        warnings.append(
            _warning(
                "invalid_mask_cropping_rule",
                "Rules 'mask_cropping' must be an object",
            )
        )
        raw_mask_cropping = {}

    mask_cropping = deepcopy(default_rules()["mask_cropping"])
    raw_mode = raw_mask_cropping.get("mode")
    if isinstance(raw_mode, str):
        normalized_mode = raw_mode.strip()
        if normalized_mode in SUPPORTED_MASK_CROPPING_MODES:
            mask_cropping["mode"] = normalized_mode
        else:
            warnings.append(
                _warning(
                    "invalid_mask_cropping_mode",
                    "mask_cropping.mode must be 'crop' or 'full'; defaulting to crop",
                    details={"mode": raw_mode},
                )
            )
    elif "mode" in raw_mask_cropping:
        warnings.append(
            _warning(
                "invalid_mask_cropping_mode",
                "mask_cropping.mode must be 'crop' or 'full'; defaulting to crop",
                details={"mode": raw_mode},
            )
        )
    elif "enabled" in raw_mask_cropping:
        raw_enabled = raw_mask_cropping.get("enabled")
        if isinstance(raw_enabled, bool):
            mask_cropping["mode"] = "crop" if raw_enabled else "full"
        else:
            warnings.append(
                _warning(
                    "invalid_mask_cropping_enabled",
                    "mask_cropping.enabled must be a boolean; defaulting to crop",
                    details={"enabled": raw_enabled},
                )
            )

    rules["mask_cropping"] = mask_cropping

    raw_postprocessing = raw.get("postprocessing", {})
    if raw_postprocessing is None:
        raw_postprocessing = {}
    if not isinstance(raw_postprocessing, dict):
        warnings.append(
            _warning(
                "invalid_postprocessing_rule",
                "Rules 'postprocessing' must be an object",
            )
        )
        raw_postprocessing = {}

    postprocessing = deepcopy(default_rules()["postprocessing"])
    raw_mode = raw_postprocessing.get("mode")
    if isinstance(raw_mode, str):
        raw_mode = raw_mode.strip()
        if raw_mode in SUPPORTED_POSTPROCESS_MODES:
            postprocessing["mode"] = raw_mode
        else:
            warnings.append(
                _warning(
                    "invalid_postprocessing_mode",
                    "postprocessing.mode is invalid; defaulting to auto",
                    details={"mode": raw_mode},
                )
            )
    elif "mode" in raw_postprocessing:
        warnings.append(
            _warning(
                "invalid_postprocessing_mode",
                "postprocessing.mode is invalid; defaulting to auto",
                details={"mode": raw_mode},
            )
        )

    raw_panel_preview = raw_postprocessing.get("panel_preview")
    if isinstance(raw_panel_preview, str):
        raw_panel_preview = raw_panel_preview.strip()
        if raw_panel_preview in SUPPORTED_POSTPROCESS_PANEL_PREVIEWS:
            postprocessing["panel_preview"] = raw_panel_preview
        else:
            warnings.append(
                _warning(
                    "invalid_postprocessing_panel_preview",
                    "postprocessing.panel_preview is invalid; defaulting to raw_outputs",
                    details={"panel_preview": raw_panel_preview},
                )
            )
    elif "panel_preview" in raw_postprocessing:
        warnings.append(
            _warning(
                "invalid_postprocessing_panel_preview",
                "postprocessing.panel_preview is invalid; defaulting to raw_outputs",
                details={"panel_preview": raw_panel_preview},
            )
        )

    raw_on_failure = raw_postprocessing.get("on_failure")
    if isinstance(raw_on_failure, str):
        raw_on_failure = raw_on_failure.strip()
        if raw_on_failure in SUPPORTED_POSTPROCESS_ON_FAILURE:
            postprocessing["on_failure"] = raw_on_failure
        else:
            warnings.append(
                _warning(
                    "invalid_postprocessing_on_failure",
                    "postprocessing.on_failure is invalid; defaulting to fallback_raw",
                    details={"on_failure": raw_on_failure},
                )
            )
    elif "on_failure" in raw_postprocessing:
        warnings.append(
            _warning(
                "invalid_postprocessing_on_failure",
                "postprocessing.on_failure is invalid; defaulting to fallback_raw",
                details={"on_failure": raw_on_failure},
            )
        )

    raw_stitch_fps = _to_positive_int(raw_postprocessing.get("stitch_fps"))
    if raw_stitch_fps is not None:
        postprocessing["stitch_fps"] = raw_stitch_fps
    elif "stitch_fps" in raw_postprocessing:
        warnings.append(
            _warning(
                "invalid_postprocessing_stitch_fps",
                "postprocessing.stitch_fps is invalid; ignoring override",
                details={"stitch_fps": raw_postprocessing.get("stitch_fps")},
            )
        )

    rules["postprocessing"] = postprocessing

    raw_aspect_ratio_processing = raw.get("aspect_ratio_processing", {})
    if raw_aspect_ratio_processing is None:
        raw_aspect_ratio_processing = {}
    if not isinstance(raw_aspect_ratio_processing, dict):
        warnings.append(
            _warning(
                "invalid_aspect_ratio_processing_rule",
                "Rules 'aspect_ratio_processing' must be an object",
            )
        )
        raw_aspect_ratio_processing = {}

    aspect_ratio_processing = deepcopy(default_rules()["aspect_ratio_processing"])

    if "enabled" in raw_aspect_ratio_processing:
        aspect_ratio_processing["enabled"] = _to_bool(
            raw_aspect_ratio_processing.get("enabled"),
            False,
        )

    raw_stride = raw_aspect_ratio_processing.get("stride")
    stride = _to_positive_int(raw_stride)
    if stride is not None:
        aspect_ratio_processing["stride"] = stride
    elif "stride" in raw_aspect_ratio_processing:
        warnings.append(
            _warning(
                "invalid_aspect_ratio_processing_stride",
                "aspect_ratio_processing.stride must be a positive integer; defaulting to 16",
                details={"stride": raw_stride},
            )
        )

    raw_search_steps = raw_aspect_ratio_processing.get("search_steps")
    search_steps = _to_non_negative_int(raw_search_steps)
    if search_steps is not None:
        aspect_ratio_processing["search_steps"] = search_steps
    elif "search_steps" in raw_aspect_ratio_processing:
        warnings.append(
            _warning(
                "invalid_aspect_ratio_processing_search_steps",
                "aspect_ratio_processing.search_steps must be a non-negative integer; defaulting to 2",
                details={"search_steps": raw_search_steps},
            )
        )

    raw_resolutions = raw_aspect_ratio_processing.get("resolutions", [])
    if raw_resolutions is None:
        raw_resolutions = []
    normalized_resolutions: list[int] = []
    if isinstance(raw_resolutions, list):
        for index, raw_res in enumerate(raw_resolutions):
            parsed_res = _to_positive_int(raw_res)
            if parsed_res is not None:
                normalized_resolutions.append(parsed_res)
            else:
                warnings.append(
                    _warning(
                        "invalid_aspect_ratio_processing_resolution",
                        "aspect_ratio_processing.resolutions entries must be positive integers",
                        details={"index": index, "value": raw_res},
                    )
                )
    elif "resolutions" in raw_aspect_ratio_processing:
        warnings.append(
            _warning(
                "invalid_aspect_ratio_processing_resolutions",
                "aspect_ratio_processing.resolutions must be an array",
                details={"resolutions": raw_resolutions},
            )
        )
    aspect_ratio_processing["resolutions"] = normalized_resolutions

    raw_target_nodes = raw_aspect_ratio_processing.get("target_nodes", [])
    if raw_target_nodes is None:
        raw_target_nodes = []
    normalized_target_nodes: list[dict[str, str]] = []
    if isinstance(raw_target_nodes, list):
        for index, raw_target_node in enumerate(raw_target_nodes):
            if not isinstance(raw_target_node, dict):
                warnings.append(
                    _warning(
                        "invalid_aspect_ratio_processing_target_node",
                        "aspect_ratio_processing.target_nodes entries must be objects",
                        details={"index": index},
                    )
                )
                continue

            node_id = raw_target_node.get("node_id")
            width_param = raw_target_node.get("width_param")
            height_param = raw_target_node.get("height_param")
            if (
                not isinstance(node_id, str)
                or not node_id.strip()
                or not isinstance(width_param, str)
                or not width_param.strip()
                or not isinstance(height_param, str)
                or not height_param.strip()
            ):
                warnings.append(
                    _warning(
                        "invalid_aspect_ratio_processing_target_node",
                        "Each aspect_ratio_processing.target_nodes entry requires node_id, width_param, and height_param",
                        details={"index": index, "entry": raw_target_node},
                    )
                )
                continue

            normalized_target_nodes.append(
                {
                    "node_id": node_id.strip(),
                    "width_param": width_param.strip(),
                    "height_param": height_param.strip(),
                }
            )
    elif "target_nodes" in raw_aspect_ratio_processing:
        warnings.append(
            _warning(
                "invalid_aspect_ratio_processing_target_nodes",
                "aspect_ratio_processing.target_nodes must be an array",
                details={"target_nodes": raw_target_nodes},
            )
        )

    aspect_ratio_processing["target_nodes"] = normalized_target_nodes

    raw_ar_postprocess = raw_aspect_ratio_processing.get("postprocess", {})
    if raw_ar_postprocess is None:
        raw_ar_postprocess = {}
    if not isinstance(raw_ar_postprocess, dict):
        warnings.append(
            _warning(
                "invalid_aspect_ratio_processing_postprocess",
                "aspect_ratio_processing.postprocess must be an object; defaults will be used",
            )
        )
        raw_ar_postprocess = {}

    ar_postprocess = deepcopy(default_rules()["aspect_ratio_processing"]["postprocess"])
    if "enabled" in raw_ar_postprocess:
        ar_postprocess["enabled"] = _to_bool(raw_ar_postprocess.get("enabled"), True)

    raw_ar_postprocess_mode = raw_ar_postprocess.get("mode")
    if isinstance(raw_ar_postprocess_mode, str):
        normalized_mode = raw_ar_postprocess_mode.strip()
        if normalized_mode in SUPPORTED_AR_POSTPROCESS_MODES:
            ar_postprocess["mode"] = normalized_mode
        else:
            warnings.append(
                _warning(
                    "invalid_aspect_ratio_processing_postprocess_mode",
                    "aspect_ratio_processing.postprocess.mode is invalid; defaulting to stretch_exact",
                    details={"mode": raw_ar_postprocess_mode},
                )
            )
    elif "mode" in raw_ar_postprocess:
        warnings.append(
            _warning(
                "invalid_aspect_ratio_processing_postprocess_mode",
                "aspect_ratio_processing.postprocess.mode is invalid; defaulting to stretch_exact",
                details={"mode": raw_ar_postprocess_mode},
            )
        )

    raw_ar_postprocess_apply_to = raw_ar_postprocess.get("apply_to")
    if isinstance(raw_ar_postprocess_apply_to, str):
        normalized_apply_to = raw_ar_postprocess_apply_to.strip()
        if normalized_apply_to in SUPPORTED_AR_POSTPROCESS_APPLY_TO:
            ar_postprocess["apply_to"] = normalized_apply_to
        else:
            warnings.append(
                _warning(
                    "invalid_aspect_ratio_processing_postprocess_apply_to",
                    "aspect_ratio_processing.postprocess.apply_to is invalid; defaulting to all_visual_outputs",
                    details={"apply_to": raw_ar_postprocess_apply_to},
                )
            )
    elif "apply_to" in raw_ar_postprocess:
        warnings.append(
            _warning(
                "invalid_aspect_ratio_processing_postprocess_apply_to",
                "aspect_ratio_processing.postprocess.apply_to is invalid; defaulting to all_visual_outputs",
                details={"apply_to": raw_ar_postprocess_apply_to},
            )
        )

    aspect_ratio_processing["postprocess"] = ar_postprocess
    rules["aspect_ratio_processing"] = aspect_ratio_processing

    raw_output_injections = raw.get("output_injections", {})
    if not isinstance(raw_output_injections, dict):
        warnings.append(
            _warning(
                "invalid_output_injections",
                "Rules 'output_injections' must be an object",
            )
        )
        raw_output_injections = {}

    normalized_output_injections: dict[str, dict[str, dict[str, Any]]] = {}
    for raw_target_node_id, raw_target_outputs in raw_output_injections.items():
        target_node_id = str(raw_target_node_id)
        if not isinstance(raw_target_outputs, dict):
            warnings.append(
                _warning(
                    "invalid_injection_target",
                    "Output injection target must be an object keyed by output index",
                    node_id=target_node_id,
                )
            )
            continue

        normalized_target_outputs: dict[str, dict[str, Any]] = {}
        for raw_output_idx, raw_rule in raw_target_outputs.items():
            output_index = _to_int(raw_output_idx)
            if output_index is None:
                warnings.append(
                    _warning(
                        "invalid_output_index",
                        "Output index key must be a non-negative integer",
                        node_id=target_node_id,
                        details={"output_index": raw_output_idx},
                    )
                )
                continue

            if not isinstance(raw_rule, dict):
                warnings.append(
                    _warning(
                        "invalid_injection_rule",
                        "Injection rule must be an object",
                        node_id=target_node_id,
                        output_index=output_index,
                    )
                )
                continue

            source = raw_rule.get("source")
            if not isinstance(source, dict):
                warnings.append(
                    _warning(
                        "invalid_injection_source",
                        "Injection rule source must be an object",
                        node_id=target_node_id,
                        output_index=output_index,
                    )
                )
                continue

            kind = source.get("kind")
            if not isinstance(kind, str):
                warnings.append(
                    _warning(
                        "invalid_source_kind",
                        "Injection source.kind must be a string",
                        node_id=target_node_id,
                        output_index=output_index,
                    )
                )
                continue

            normalized_source: dict[str, Any] = {"kind": kind}
            if kind == "node_output":
                source_node_id = source.get("node_id")
                source_output_index = _to_int(source.get("output_index"))
                if not isinstance(source_node_id, str) or source_output_index is None:
                    warnings.append(
                        _warning(
                            "invalid_node_output_source",
                            "node_output source requires node_id (string) and output_index (integer)",
                            node_id=target_node_id,
                            output_index=output_index,
                        )
                    )
                    continue
                normalized_source["node_id"] = source_node_id
                normalized_source["output_index"] = source_output_index
            elif kind == "manual_slot":
                slot_id = source.get("slot_id")
                if not isinstance(slot_id, str):
                    warnings.append(
                        _warning(
                            "invalid_manual_slot_source",
                            "manual_slot source requires slot_id (string)",
                            node_id=target_node_id,
                            output_index=output_index,
                        )
                    )
                    continue
                normalized_source["slot_id"] = slot_id
            else:
                warnings.append(
                    _warning(
                        "unsupported_source_kind",
                        "Unsupported injection source kind; this rule will be ignored",
                        node_id=target_node_id,
                        output_index=output_index,
                        details={"kind": kind},
                    )
                )
                continue

            normalized_target_outputs[str(output_index)] = {"source": normalized_source}

        if normalized_target_outputs:
            normalized_output_injections[target_node_id] = normalized_target_outputs

    rules["output_injections"] = normalized_output_injections
    return rules, warnings


def load_rules_for_workflow(
    workflows_dir: Path,
    workflow_filename: str | None,
    *,
    fallback_dirs: list[Path] | None = None,
) -> tuple[WorkflowRules, list[WorkflowRuleWarning]]:
    warnings: list[WorkflowRuleWarning] = []
    if not workflow_filename:
        return default_rules(), warnings
    if not isinstance(workflow_filename, str) or not _is_safe_workflow_filename(
        workflow_filename
    ):
        warnings.append(
            _warning(
                "invalid_workflow_id",
                "workflow_id is invalid; skipping manual rules",
                details={"workflow_id": workflow_filename},
            )
        )
        return default_rules(), warnings

    # Search primary dir first, then any fallback dirs for the sidecar.
    sidecar_path = sidecar_path_for_workflow(workflows_dir, workflow_filename)
    if not sidecar_path.exists() and fallback_dirs:
        for fb_dir in fallback_dirs:
            candidate = sidecar_path_for_workflow(fb_dir, workflow_filename)
            if candidate.exists():
                sidecar_path = candidate
                break

    if not sidecar_path.exists():
        return default_rules(), warnings

    try:
        raw_rules = json.loads(sidecar_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        warnings.append(
            _warning(
                "invalid_rules_json",
                "Rules sidecar JSON is malformed; defaults will be used",
                details={"path": str(sidecar_path), "error": str(exc)},
            )
        )
        return default_rules(), warnings
    except OSError as exc:
        warnings.append(
            _warning(
                "rules_read_failed",
                "Rules sidecar could not be read; defaults will be used",
                details={"path": str(sidecar_path), "error": str(exc)},
            )
        )
        return default_rules(), warnings

    normalized, normalize_warnings = normalize_rules(raw_rules)
    warnings.extend(normalize_warnings)
    return normalized, warnings


__all__ = [
    "WorkflowPrompt",
    "WorkflowRuleWarning",
    "WorkflowRules",
    "default_rules",
    "load_rules_for_workflow",
    "normalize_rules",
    "sidecar_path_for_workflow",
]
