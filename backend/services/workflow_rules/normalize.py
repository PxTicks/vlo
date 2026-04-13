import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from services.workflow_rules.derived_mask_video_treatment import (
    DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM,
    DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OPTIONS,
    DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OVERRIDE_OPERATORS,
    normalize_derived_mask_source_video_treatment,
    normalize_derived_mask_source_video_treatment_list,
    normalize_derived_mask_source_video_treatment_widget_param,
    parse_derived_mask_source_video_treatment,
)
from services.workflow_rules.schema import (
    AuthoredWorkflowRulesV1,
    AuthoredWorkflowRulesV2,
    ResolvedWorkflowRules,
    WorkflowRuleWarningModel,
    compile_authored_v1_to_resolved,
    compile_authored_v2_to_resolved,
    default_resolved_rules_model,
    dump_resolved_rules,
    dump_warning_models,
    validation_warnings_from_error,
)


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
SUPPORTED_MASK_SOURCE_VIDEO_TREATMENTS = set(
    DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OPTIONS.keys()
)
SUPPORTED_MASK_SOURCE_VIDEO_TREATMENT_INPUTS = SUPPORTED_MASK_SOURCE_VIDEO_TREATMENTS | {
    "keep transparency",
    "preserve transparency",
    "fill transparent with neutral gray",
    "fill transparent with neutral grey",
    "remove transparency",
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
SUPPORTED_WIDGET_CONTROLS = {
    "slider",
}
SUPPORTED_WIDGET_SLIDER_DISPLAYS = {
    "percent",
    "number",
}
SUPPORTED_DERIVED_WIDGET_KINDS = {
    "dual_sampler_denoise",
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
    return dump_resolved_rules(default_resolved_rules_model())


def default_rules_model() -> ResolvedWorkflowRules:
    return default_resolved_rules_model()


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


def _normalize_param_ref(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    node_id = value.get("node_id")
    param = value.get("param")
    if not isinstance(node_id, str) or not isinstance(param, str):
        return None
    normalized_node_id = node_id.strip()
    normalized_param = param.strip()
    if not normalized_node_id or not normalized_param:
        return None
    return {
        "node_id": normalized_node_id,
        "param": normalized_param,
    }


def _normalize_mask_source_video_treatment_option_list(
    raw_value: Any,
    *,
    field_name: str,
    warnings: list[WorkflowRuleWarning],
) -> list[str] | None:
    if raw_value is None:
        return None
    if not isinstance(raw_value, list):
        warnings.append(
            _warning(
                f"invalid_mask_processing_source_video_treatment_{field_name}",
                f"mask_processing.source_video_treatment.{field_name} must be an array of treatments; ignoring it",
                details={field_name: raw_value},
            )
        )
        return None

    normalized = normalize_derived_mask_source_video_treatment_list(raw_value)
    invalid_values = [
        value
        for value in raw_value
        if parse_derived_mask_source_video_treatment(value) is None
    ]
    if invalid_values:
        warnings.append(
            _warning(
                f"invalid_mask_processing_source_video_treatment_{field_name}",
                f"mask_processing.source_video_treatment.{field_name} contains invalid treatments; ignoring those entries",
                details={"invalid_values": invalid_values},
            )
        )
    return normalized


def _normalize_mask_source_video_treatment_default_overrides(
    raw_value: Any,
    warnings: list[WorkflowRuleWarning],
) -> list[dict[str, Any]] | None:
    if raw_value is None:
        return None
    if not isinstance(raw_value, list):
        warnings.append(
            _warning(
                "invalid_mask_processing_source_video_treatment_default_overrides",
                "mask_processing.source_video_treatment.default_overrides must be an array; ignoring it",
                details={"default_overrides": raw_value},
            )
        )
        return None

    normalized: list[dict[str, Any]] = []
    for index, raw_override in enumerate(raw_value):
        if not isinstance(raw_override, dict):
            warnings.append(
                _warning(
                    "invalid_mask_processing_source_video_treatment_default_override",
                    "mask_processing.source_video_treatment.default_overrides[*] must be an object; ignoring entry",
                    details={"index": index},
                )
            )
            continue

        raw_when = raw_override.get("when")
        raw_value_choice = raw_override.get("value")
        when = raw_when if isinstance(raw_when, dict) else None
        node_id = when.get("node_id") if when else None
        param = when.get("param") if when else None
        operator = when.get("operator") if when else "eq"
        normalized_value = parse_derived_mask_source_video_treatment(raw_value_choice)

        if (
            not isinstance(node_id, str)
            or not node_id.strip()
            or not isinstance(param, str)
            or not param.strip()
            or operator not in DERIVED_MASK_SOURCE_VIDEO_TREATMENT_OVERRIDE_OPERATORS
            or isinstance(when.get("value") if when else None, (dict, list, tuple, set))
            or normalized_value is None
        ):
            warnings.append(
                _warning(
                    "invalid_mask_processing_source_video_treatment_default_override",
                    "mask_processing.source_video_treatment.default_overrides[*] is invalid; ignoring entry",
                    details={"index": index},
                )
            )
            continue

        normalized.append(
            {
                "when": {
                    "node_id": node_id.strip(),
                    "param": param.strip(),
                    "operator": operator,
                    "value": when.get("value"),
                },
                "value": normalized_value,
            }
        )

    return normalized


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


def _normalize_rules_dict(raw: Any) -> tuple[WorkflowRules, list[WorkflowRuleWarning]]:
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
            if isinstance(raw_present.get("group_id"), str):
                group_id = raw_present["group_id"].strip()
                if group_id:
                    present["group_id"] = group_id
            if isinstance(raw_present.get("group_title"), str):
                group_title = raw_present["group_title"].strip()
                if group_title:
                    present["group_title"] = group_title
            group_order = raw_present.get("group_order")
            if isinstance(group_order, int) and not isinstance(group_order, bool):
                if group_order >= 0:
                    present["group_order"] = group_order
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
                normalized_widget_name, used_deprecated_alias = (
                    normalize_derived_mask_source_video_treatment_widget_param(
                        widget_name
                    )
                )
                if not isinstance(raw_widget, dict):
                    warnings.append(
                        _warning(
                            "invalid_widget_rule",
                            f"Widget rule for '{widget_name}' must be an object",
                            node_id=node_id,
                        )
                    )
                    continue
                if used_deprecated_alias:
                    warnings.append(
                        _warning(
                            "deprecated_widget_param_alias",
                            "Widget param '__derived_mask_video_treatment' is deprecated; use 'derived_mask_source_video_treatment'",
                            node_id=node_id,
                            details={
                                "widget": widget_name,
                                "replacement": DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM,
                            },
                        )
                    )
                if (
                    normalized_widget_name
                    == DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM
                    and normalized_widget_name in normalized_widgets
                    and used_deprecated_alias
                ):
                    warnings.append(
                        _warning(
                            "duplicate_widget_param_alias",
                            "Ignoring deprecated widget alias because the canonical widget param is already defined",
                            node_id=node_id,
                            details={
                                "widget": widget_name,
                                "replacement": DERIVED_MASK_SOURCE_VIDEO_TREATMENT_WIDGET_PARAM,
                            },
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
                if isinstance(raw_widget.get("hidden"), bool):
                    widget_rule["hidden"] = raw_widget["hidden"]
                raw_control = raw_widget.get("control")
                if isinstance(raw_control, str):
                    control = raw_control.strip().lower()
                    if control in SUPPORTED_WIDGET_CONTROLS:
                        widget_rule["control"] = control
                    elif control:
                        warnings.append(
                            _warning(
                                "invalid_widget_control",
                                "Widget control is invalid; expected slider",
                                node_id=node_id,
                                details={"widget": widget_name, "control": raw_control},
                            )
                        )
                raw_slider_display = raw_widget.get("slider_display")
                if isinstance(raw_slider_display, str):
                    slider_display = raw_slider_display.strip().lower()
                    if slider_display in SUPPORTED_WIDGET_SLIDER_DISPLAYS:
                        widget_rule["slider_display"] = slider_display
                    elif slider_display:
                        warnings.append(
                            _warning(
                                "invalid_widget_slider_display",
                                "Widget slider_display is invalid; expected percent|number",
                                node_id=node_id,
                                details={
                                    "widget": widget_name,
                                    "slider_display": raw_slider_display,
                                },
                            )
                        )
                if isinstance(raw_widget.get("unit"), str):
                    unit = raw_widget["unit"].strip()
                    if unit:
                        widget_rule["unit"] = unit
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
                for num_key in ("min", "max", "step"):
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
                normalized_widgets[normalized_widget_name] = widget_rule

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

        for mask_key in (
            "binary_derived_mask_of",
            "soft_derived_mask_of",
            "binary_audio_derived_mask_of",
        ):
            raw_val = raw_node_rule.get(mask_key)
            if isinstance(raw_val, str) and raw_val.strip():
                node_rule[mask_key] = raw_val.strip()

        audio_derived_mask_fps = _to_positive_int(raw_node_rule.get("audio_derived_mask_fps"))
        if audio_derived_mask_fps is not None:
            node_rule["audio_derived_mask_fps"] = audio_derived_mask_fps
        elif "audio_derived_mask_fps" in raw_node_rule:
            warnings.append(
                _warning(
                    "invalid_audio_derived_mask_fps",
                    "Node audio_derived_mask_fps must be a positive integer",
                    node_id=node_id,
                )
            )

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

    raw_mask_processing = raw.get("mask_processing")
    if raw_mask_processing is None and "mask_cropping" in raw:
        raw_mask_processing = {"cropping": raw.get("mask_cropping")}
    if raw_mask_processing is None:
        raw_mask_processing = {}
    if not isinstance(raw_mask_processing, dict):
        warnings.append(
            _warning(
                "invalid_mask_processing_rule",
                "Rules 'mask_processing' must be an object",
            )
        )
        raw_mask_processing = {}

    mask_processing = deepcopy(default_rules()["mask_processing"])

    raw_mask_cropping = raw_mask_processing.get("cropping", {})
    if raw_mask_cropping is None:
        raw_mask_cropping = {}
    if not isinstance(raw_mask_cropping, dict):
        warnings.append(
            _warning(
                "invalid_mask_processing_cropping_rule",
                "mask_processing.cropping must be an object",
            )
        )
        raw_mask_cropping = {}

    raw_mode = raw_mask_cropping.get("mode")
    if isinstance(raw_mode, str):
        normalized_mode = raw_mode.strip()
        if normalized_mode in SUPPORTED_MASK_CROPPING_MODES:
            mask_processing["cropping"]["mode"] = normalized_mode
        else:
            warnings.append(
                _warning(
                    "invalid_mask_processing_cropping_mode",
                    "mask_processing.cropping.mode must be 'crop' or 'full'; defaulting to crop",
                    details={"mode": raw_mode},
                )
            )
    elif "mode" in raw_mask_cropping:
        warnings.append(
            _warning(
                "invalid_mask_processing_cropping_mode",
                "mask_processing.cropping.mode must be 'crop' or 'full'; defaulting to crop",
                details={"mode": raw_mode},
            )
        )
    elif "enabled" in raw_mask_cropping:
        raw_enabled = raw_mask_cropping.get("enabled")
        if isinstance(raw_enabled, bool):
            mask_processing["cropping"]["mode"] = "crop" if raw_enabled else "full"
        else:
            warnings.append(
                _warning(
                    "invalid_mask_processing_cropping_enabled",
                    "mask_processing.cropping.enabled must be a boolean; defaulting to crop",
                    details={"enabled": raw_enabled},
                )
            )

    raw_source_video_treatment = raw_mask_processing.get("source_video_treatment", {})
    if raw_source_video_treatment is None:
        raw_source_video_treatment = {}
    if not isinstance(raw_source_video_treatment, dict):
        warnings.append(
            _warning(
                "invalid_mask_processing_source_video_treatment_rule",
                "mask_processing.source_video_treatment must be an object",
            )
        )
        raw_source_video_treatment = {}

    raw_default = raw_source_video_treatment.get("default")
    if isinstance(raw_default, str):
        parsed_default = parse_derived_mask_source_video_treatment(raw_default)
        if parsed_default is not None:
            mask_processing["source_video_treatment"]["default"] = (
                normalize_derived_mask_source_video_treatment(raw_default)
            )
        else:
            warnings.append(
                _warning(
                    "invalid_mask_processing_source_video_treatment_default",
                    "mask_processing.source_video_treatment.default is invalid; defaulting to preserve_transparency",
                    details={"default": raw_default},
                )
            )
    elif "default" in raw_source_video_treatment:
        warnings.append(
            _warning(
                "invalid_mask_processing_source_video_treatment_default",
                "mask_processing.source_video_treatment.default is invalid; defaulting to preserve_transparency",
                details={"default": raw_default},
            )
        )

    raw_expose_as_widget = raw_source_video_treatment.get("expose_as_widget")
    if isinstance(raw_expose_as_widget, bool):
        mask_processing["source_video_treatment"]["expose_as_widget"] = (
            raw_expose_as_widget
        )
    elif "expose_as_widget" in raw_source_video_treatment:
        warnings.append(
            _warning(
                "invalid_mask_processing_source_video_treatment_expose_as_widget",
                "mask_processing.source_video_treatment.expose_as_widget must be a boolean; defaulting to true",
                details={"expose_as_widget": raw_expose_as_widget},
            )
        )

    raw_label = raw_source_video_treatment.get("label")
    if isinstance(raw_label, str) and raw_label.strip():
        mask_processing["source_video_treatment"]["label"] = raw_label.strip()
    elif "label" in raw_source_video_treatment and raw_label is not None:
        warnings.append(
            _warning(
                "invalid_mask_processing_source_video_treatment_label",
                "mask_processing.source_video_treatment.label must be a non-empty string; defaulting to 'Transparency handling'",
                details={"label": raw_label},
            )
        )

    if "include_options" in raw_source_video_treatment:
        normalized_include_options = _normalize_mask_source_video_treatment_option_list(
            raw_source_video_treatment.get("include_options"),
            field_name="include_options",
            warnings=warnings,
        )
        if normalized_include_options is not None:
            mask_processing["source_video_treatment"]["include_options"] = (
                normalized_include_options
            )

    if "exclude_options" in raw_source_video_treatment:
        normalized_exclude_options = _normalize_mask_source_video_treatment_option_list(
            raw_source_video_treatment.get("exclude_options"),
            field_name="exclude_options",
            warnings=warnings,
        )
        if normalized_exclude_options is not None:
            mask_processing["source_video_treatment"]["exclude_options"] = (
                normalized_exclude_options
            )

    if "default_overrides" in raw_source_video_treatment:
        normalized_default_overrides = (
            _normalize_mask_source_video_treatment_default_overrides(
                raw_source_video_treatment.get("default_overrides"),
                warnings,
            )
        )
        if normalized_default_overrides is not None:
            mask_processing["source_video_treatment"]["default_overrides"] = (
                normalized_default_overrides
            )

    rules["mask_processing"] = mask_processing

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
    normalized_target_nodes: list[dict[str, Any]] = []
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

            width_ref = _normalize_param_ref(raw_target_node.get("width"))
            height_ref = _normalize_param_ref(raw_target_node.get("height"))
            if width_ref is not None and height_ref is not None:
                normalized_target_nodes.append(
                    {
                        "width": width_ref,
                        "height": height_ref,
                    }
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
                        "Each aspect_ratio_processing.target_nodes entry requires node_id/width_param/height_param or width/height param references",
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

    raw_derived_widgets = raw.get("derived_widgets", [])
    if raw_derived_widgets is None:
        raw_derived_widgets = []
    if not isinstance(raw_derived_widgets, list):
        warnings.append(
            _warning(
                "invalid_derived_widgets",
                "Rules 'derived_widgets' must be an array",
            )
        )
        raw_derived_widgets = []

    normalized_derived_widgets: list[dict[str, Any]] = []
    for index, raw_derived_widget in enumerate(raw_derived_widgets):
        if not isinstance(raw_derived_widget, dict):
            warnings.append(
                _warning(
                    "invalid_derived_widget_rule",
                    "Derived widget rules must be objects",
                    details={"index": index},
                )
            )
            continue

        derived_widget_id = raw_derived_widget.get("id")
        if not isinstance(derived_widget_id, str) or not derived_widget_id.strip():
            warnings.append(
                _warning(
                    "missing_derived_widget_id",
                    "Derived widget rules require a non-empty id",
                    details={"index": index},
                )
            )
            continue

        kind = raw_derived_widget.get("kind")
        if not isinstance(kind, str) or kind not in SUPPORTED_DERIVED_WIDGET_KINDS:
            warnings.append(
                _warning(
                    "unsupported_derived_widget_kind",
                    "Derived widget kind is not supported",
                    details={"index": index, "kind": kind},
                )
            )
            continue

        normalized_rule: dict[str, Any] = {
            "id": derived_widget_id.strip(),
            "kind": kind,
        }

        if isinstance(raw_derived_widget.get("label"), str):
            label = raw_derived_widget["label"].strip()
            if label:
                normalized_rule["label"] = label
        if isinstance(raw_derived_widget.get("group_id"), str):
            group_id = raw_derived_widget["group_id"].strip()
            if group_id:
                normalized_rule["group_id"] = group_id
        if isinstance(raw_derived_widget.get("group_title"), str):
            group_title = raw_derived_widget["group_title"].strip()
            if group_title:
                normalized_rule["group_title"] = group_title
        group_order = raw_derived_widget.get("group_order")
        if isinstance(group_order, int) and not isinstance(group_order, bool):
            if group_order >= 0:
                normalized_rule["group_order"] = group_order

        if kind == "dual_sampler_denoise":
            total_steps = _normalize_param_ref(raw_derived_widget.get("total_steps"))
            start_step = _normalize_param_ref(raw_derived_widget.get("start_step"))
            base_split_step = _normalize_param_ref(
                raw_derived_widget.get("base_split_step")
            )
            raw_split_targets = raw_derived_widget.get("split_step_targets")
            split_step_targets = (
                [
                    normalized_target
                    for item in raw_split_targets
                    if (
                        normalized_target := _normalize_param_ref(item)
                    )
                    is not None
                ]
                if isinstance(raw_split_targets, list)
                else []
            )

            if (
                total_steps is None
                or start_step is None
                or base_split_step is None
                or not split_step_targets
            ):
                warnings.append(
                    _warning(
                        "invalid_derived_widget_rule",
                        "dual_sampler_denoise requires total_steps, start_step, base_split_step, and split_step_targets references",
                        details={"index": index, "id": normalized_rule["id"]},
                    )
                )
                continue

            normalized_rule["total_steps"] = total_steps
            normalized_rule["start_step"] = start_step
            normalized_rule["base_split_step"] = base_split_step
            normalized_rule["split_step_targets"] = split_step_targets

        normalized_derived_widgets.append(normalized_rule)

    rules["derived_widgets"] = normalized_derived_widgets

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


def _warning_models_to_dicts(
    warnings: list[WorkflowRuleWarningModel],
) -> list[WorkflowRuleWarning]:
    return dump_warning_models(warnings)


def _resolved_rules_with_v1_validation(
    rules: WorkflowRules,
    warnings: list[WorkflowRuleWarning],
) -> tuple[ResolvedWorkflowRules, list[WorkflowRuleWarningModel]]:
    warning_models = [WorkflowRuleWarningModel.model_validate(warning) for warning in warnings]
    try:
        authored = AuthoredWorkflowRulesV1.model_validate(rules)
        return compile_authored_v1_to_resolved(authored), warning_models
    except ValidationError as exc:
        warning_models.extend(
            validation_warnings_from_error(
                exc,
                code="invalid_rules_schema",
                message_prefix="Resolved workflow rules failed schema validation",
            )
        )
        return default_resolved_rules_model(), warning_models


def _resolved_rules_from_v2(
    raw: Any,
) -> tuple[ResolvedWorkflowRules, list[WorkflowRuleWarningModel]]:
    try:
        authored = AuthoredWorkflowRulesV2.model_validate(raw)
    except ValidationError as exc:
        return (
            default_resolved_rules_model(),
            validation_warnings_from_error(
                exc,
                code="invalid_rules_v2_schema",
                message_prefix="Workflow rules v2 failed schema validation",
            ),
        )

    try:
        return compile_authored_v2_to_resolved(authored), []
    except ValidationError as exc:
        return (
            default_resolved_rules_model(),
            validation_warnings_from_error(
                exc,
                code="invalid_rules_v2_compilation",
                message_prefix="Workflow rules v2 could not be compiled",
            ),
        )


def normalize_rules_model(
    raw: Any,
) -> tuple[ResolvedWorkflowRules, list[WorkflowRuleWarningModel]]:
    if isinstance(raw, dict) and raw.get("version") == 2:
        return _resolved_rules_from_v2(raw)

    normalized_rules, warnings = _normalize_rules_dict(raw)
    return _resolved_rules_with_v1_validation(normalized_rules, warnings)


def normalize_rules(raw: Any) -> tuple[WorkflowRules, list[WorkflowRuleWarning]]:
    resolved_rules, warning_models = normalize_rules_model(raw)
    return dump_resolved_rules(resolved_rules), _warning_models_to_dicts(warning_models)


def load_rules_model_for_workflow(
    workflows_dir: Path,
    workflow_filename: str | None,
    *,
    fallback_dirs: list[Path] | None = None,
) -> tuple[ResolvedWorkflowRules, list[WorkflowRuleWarningModel]]:
    warnings: list[WorkflowRuleWarningModel] = []
    if not workflow_filename:
        return default_resolved_rules_model(), warnings
    if not isinstance(workflow_filename, str) or not _is_safe_workflow_filename(
        workflow_filename
    ):
        warnings.append(
            WorkflowRuleWarningModel(
                code="invalid_workflow_id",
                message="workflow_id is invalid; skipping manual rules",
                details={"workflow_id": workflow_filename},
            )
        )
        return default_resolved_rules_model(), warnings

    # Search primary dir first, then any fallback dirs for the sidecar.
    sidecar_path = sidecar_path_for_workflow(workflows_dir, workflow_filename)
    if not sidecar_path.exists() and fallback_dirs:
        for fb_dir in fallback_dirs:
            candidate = sidecar_path_for_workflow(fb_dir, workflow_filename)
            if candidate.exists():
                sidecar_path = candidate
                break

    if not sidecar_path.exists():
        return default_resolved_rules_model(), warnings

    try:
        raw_rules = json.loads(sidecar_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        warnings.append(
            WorkflowRuleWarningModel(
                code="invalid_rules_json",
                message="Rules sidecar JSON is malformed; defaults will be used",
                details={"path": str(sidecar_path), "error": str(exc)},
            )
        )
        return default_resolved_rules_model(), warnings
    except OSError as exc:
        warnings.append(
            WorkflowRuleWarningModel(
                code="rules_read_failed",
                message="Rules sidecar could not be read; defaults will be used",
                details={"path": str(sidecar_path), "error": str(exc)},
            )
        )
        return default_resolved_rules_model(), warnings

    normalized, normalize_warnings = normalize_rules_model(raw_rules)
    warnings.extend(normalize_warnings)
    return normalized, warnings


def load_rules_for_workflow(
    workflows_dir: Path,
    workflow_filename: str | None,
    *,
    fallback_dirs: list[Path] | None = None,
) -> tuple[WorkflowRules, list[WorkflowRuleWarning]]:
    resolved_rules, warning_models = load_rules_model_for_workflow(
        workflows_dir,
        workflow_filename,
        fallback_dirs=fallback_dirs,
    )
    return dump_resolved_rules(resolved_rules), _warning_models_to_dicts(warning_models)


__all__ = [
    "WorkflowPrompt",
    "WorkflowRuleWarning",
    "WorkflowRules",
    "default_rules",
    "default_rules_model",
    "load_rules_model_for_workflow",
    "load_rules_for_workflow",
    "normalize_rules_model",
    "normalize_rules",
    "sidecar_path_for_workflow",
]
