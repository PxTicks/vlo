import { isRecord } from "../parsers";
import {
  createDefaultWorkflowRules,
  DEFAULT_WORKFLOW_MASK_CROPPING,
  DEFAULT_WORKFLOW_POSTPROCESSING,
  type WorkflowAspectRatioProcessingConfig,
  type WorkflowDerivedWidgetRule,
  type WorkflowInputCondition,
  type WorkflowInputValidationRule,
  type WorkflowMaskCroppingConfig,
  type WorkflowRuleNode,
  type WorkflowRuleNodePresent,
  type WorkflowRules,
  type WorkflowRuleSlot,
  type WorkflowRuleWarning,
  type WorkflowRuleWidgetEntry,
  type WorkflowValidationConfig,
} from "./types";
import {
  normalizeParamReference,
  toPositiveInteger,
  toRulesWarning,
  toStringRecord,
  toWidgetOptions,
  toWidgetValueType,
} from "./shared";

function normalizeDerivedWidgetRule(
  rawRule: unknown,
  warnings: WorkflowRuleWarning[],
  index: number,
): WorkflowDerivedWidgetRule | null {
  if (!isRecord(rawRule)) {
    warnings.push(
      toRulesWarning(
        "invalid_derived_widget_rule",
        "derived_widgets entries must be objects",
      ),
    );
    return null;
  }

  if (rawRule.kind !== "dual_sampler_denoise") {
    warnings.push(
      toRulesWarning(
        "unsupported_derived_widget_kind",
        `Unsupported derived widget kind '${String(rawRule.kind ?? "")}'`,
      ),
    );
    return null;
  }

  if (typeof rawRule.id !== "string" || rawRule.id.trim().length === 0) {
    warnings.push(
      toRulesWarning(
        "missing_derived_widget_id",
        `derived_widgets[${index}] requires a non-empty id`,
      ),
    );
    return null;
  }

  const totalSteps = normalizeParamReference(rawRule.total_steps);
  const startStep = normalizeParamReference(rawRule.start_step);
  const baseSplitStep = normalizeParamReference(rawRule.base_split_step);
  const splitStepTargets = Array.isArray(rawRule.split_step_targets)
    ? rawRule.split_step_targets.flatMap((target) => {
        const normalized = normalizeParamReference(target);
        return normalized ? [normalized] : [];
      })
    : [];

  if (
    totalSteps === null ||
    startStep === null ||
    baseSplitStep === null ||
    splitStepTargets.length === 0
  ) {
    warnings.push(
      toRulesWarning(
        "invalid_derived_widget_rule",
        `derived_widgets[${index}] has invalid node/param references`,
      ),
    );
    return null;
  }

  return {
    id: rawRule.id.trim(),
    kind: "dual_sampler_denoise",
    ...(typeof rawRule.label === "string" && rawRule.label.trim().length > 0
      ? { label: rawRule.label.trim() }
      : {}),
    ...(typeof rawRule.group_id === "string" &&
    rawRule.group_id.trim().length > 0
      ? { group_id: rawRule.group_id.trim() }
      : {}),
    ...(typeof rawRule.group_title === "string" &&
    rawRule.group_title.trim().length > 0
      ? { group_title: rawRule.group_title.trim() }
      : {}),
    ...(typeof rawRule.group_order === "number" && rawRule.group_order >= 0
      ? { group_order: Math.floor(rawRule.group_order) }
      : {}),
    total_steps: totalSteps,
    start_step: startStep,
    base_split_step: baseSplitStep,
    split_step_targets: splitStepTargets,
  };
}

function normalizeValidationInputRule(
  rawRule: unknown,
  warnings: WorkflowRuleWarning[],
  index: number,
): WorkflowInputValidationRule | null {
  if (!isRecord(rawRule)) {
    warnings.push(
      toRulesWarning(
        "invalid_validation_input_rule",
        "validation.inputs[*] must be an object",
      ),
    );
    return null;
  }

  if (typeof rawRule.kind !== "string") {
    warnings.push(
      toRulesWarning(
        "invalid_validation_input_rule_kind",
        `validation.inputs[${index}].kind must be a string`,
      ),
    );
    return null;
  }

  const kind = rawRule.kind.trim().toLowerCase();
  const message =
    typeof rawRule.message === "string" && rawRule.message.trim().length > 0
      ? rawRule.message.trim()
      : undefined;

  if (kind === "required" || kind === "optional") {
    if (typeof rawRule.input !== "string" || rawRule.input.trim().length === 0) {
      warnings.push(
        toRulesWarning(
          "invalid_validation_input_rule_input",
          `validation.inputs[${index}].input must be a non-empty string`,
        ),
      );
      return null;
    }
    return {
      kind,
      input: rawRule.input.trim(),
      ...(message ? { message } : {}),
    };
  }

  if (kind === "at_least_n") {
    if (!Array.isArray(rawRule.inputs)) {
      warnings.push(
        toRulesWarning(
          "invalid_validation_input_rule_inputs",
          `validation.inputs[${index}].inputs must be an array of input IDs`,
        ),
      );
      return null;
    }
    const inputs = rawRule.inputs
      .filter((inputId): inputId is string => typeof inputId === "string")
      .map((inputId) => inputId.trim())
      .filter((inputId) => inputId.length > 0);
    const min = toPositiveInteger(rawRule.min);
    if (inputs.length === 0 || min === null || min > inputs.length) {
      warnings.push(
        toRulesWarning(
          "invalid_validation_input_rule_min",
          `validation.inputs[${index}] has invalid inputs/min configuration`,
        ),
      );
      return null;
    }
    return {
      kind,
      inputs,
      min,
      ...(message ? { message } : {}),
    };
  }

  warnings.push(
    toRulesWarning(
      "invalid_validation_input_rule_kind",
      `validation.inputs[${index}] has unsupported kind '${rawRule.kind}'`,
    ),
  );
  return null;
}

function normalizeNodeRules(
  rawNodes: Record<string, unknown>,
  warnings: WorkflowRuleWarning[],
): Record<string, WorkflowRuleNode> {
  const nodes: Record<string, WorkflowRuleNode> = {};

  for (const [nodeId, nodeRuleUnknown] of Object.entries(rawNodes)) {
    if (!isRecord(nodeRuleUnknown)) {
      warnings.push(
        toRulesWarning(
          "invalid_node_rule",
          "Node rule must be an object",
          nodeId,
        ),
      );
      continue;
    }

    const nodeRule: WorkflowRuleNode = {};
    if ("ignore" in nodeRuleUnknown) {
      nodeRule.ignore = Boolean(nodeRuleUnknown.ignore);
    }
    if (
      nodeRuleUnknown.widgets_mode === "control_after_generate" ||
      nodeRuleUnknown.widgets_mode === "all"
    ) {
      nodeRule.widgets_mode = nodeRuleUnknown.widgets_mode;
    }

    if (isRecord(nodeRuleUnknown.present)) {
      const present: WorkflowRuleNodePresent = {};
      if ("enabled" in nodeRuleUnknown.present) {
        present.enabled = Boolean(nodeRuleUnknown.present.enabled);
      }
      if ("required" in nodeRuleUnknown.present) {
        present.required = Boolean(nodeRuleUnknown.present.required);
      }
      if (typeof nodeRuleUnknown.present.input_type === "string") {
        present.input_type = nodeRuleUnknown.present.input_type;
      }
      if (typeof nodeRuleUnknown.present.param === "string") {
        present.param = nodeRuleUnknown.present.param;
      }
      if (typeof nodeRuleUnknown.present.label === "string") {
        present.label = nodeRuleUnknown.present.label;
      }
      if (typeof nodeRuleUnknown.present.class_type === "string") {
        present.class_type = nodeRuleUnknown.present.class_type;
      }
      nodeRule.present = present;
    }

    if (isRecord(nodeRuleUnknown.widgets)) {
      const widgets: Record<string, WorkflowRuleWidgetEntry> = {};
      for (const [widgetName, rawWidget] of Object.entries(nodeRuleUnknown.widgets)) {
        if (!isRecord(rawWidget)) continue;

        const entry: WorkflowRuleWidgetEntry = {};
        if (typeof rawWidget.label === "string") entry.label = rawWidget.label;
        if (typeof rawWidget.control_after_generate === "boolean") {
          entry.control_after_generate = rawWidget.control_after_generate;
        }
        if (typeof rawWidget.default_randomize === "boolean") {
          entry.default_randomize = rawWidget.default_randomize;
        }
        if (typeof rawWidget.frontend_only === "boolean") {
          entry.frontend_only = rawWidget.frontend_only;
        }
        if (typeof rawWidget.hidden === "boolean") {
          entry.hidden = rawWidget.hidden;
        }
        if (typeof rawWidget.group_id === "string") {
          const groupId = rawWidget.group_id.trim();
          if (groupId.length > 0) entry.group_id = groupId;
        }
        if (typeof rawWidget.group_title === "string") {
          const groupTitle = rawWidget.group_title.trim();
          if (groupTitle.length > 0) entry.group_title = groupTitle;
        }
        if (
          typeof rawWidget.group_order === "number" &&
          rawWidget.group_order >= 0
        ) {
          entry.group_order = Math.floor(rawWidget.group_order);
        }
        if (typeof rawWidget.min === "number") entry.min = rawWidget.min;
        if (typeof rawWidget.max === "number") entry.max = rawWidget.max;
        if ("default" in rawWidget) entry.default = rawWidget.default;
        const valueType = toWidgetValueType(rawWidget.value_type);
        if (valueType) entry.value_type = valueType;
        const options = toWidgetOptions(rawWidget.options);
        if (options) entry.options = options;
        widgets[widgetName] = entry;
      }

      if (Object.keys(widgets).length > 0) {
        nodeRule.widgets = widgets;
      }
    }

    if (typeof nodeRuleUnknown.node_title === "string") {
      nodeRule.node_title = nodeRuleUnknown.node_title;
    }

    if (isRecord(nodeRuleUnknown.selection)) {
      const selection: WorkflowRuleNode["selection"] = {};
      const exportFps = toPositiveInteger(nodeRuleUnknown.selection.export_fps);
      if (exportFps !== null) {
        selection.export_fps = exportFps;
      } else if (nodeRuleUnknown.selection.export_fps !== undefined) {
        warnings.push(
          toRulesWarning(
            "invalid_node_selection_export_fps",
            `Node '${nodeId}' has invalid selection.export_fps`,
            nodeId,
          ),
        );
      }

      const frameStep = toPositiveInteger(nodeRuleUnknown.selection.frame_step);
      if (frameStep !== null) {
        selection.frame_step = frameStep;
      } else if (nodeRuleUnknown.selection.frame_step !== undefined) {
        warnings.push(
          toRulesWarning(
            "invalid_node_selection_frame_step",
            `Node '${nodeId}' has invalid selection.frame_step`,
            nodeId,
          ),
        );
      }

      const maxFrames = toPositiveInteger(nodeRuleUnknown.selection.max_frames);
      if (maxFrames !== null) {
        selection.max_frames = maxFrames;
      } else if (nodeRuleUnknown.selection.max_frames !== undefined) {
        warnings.push(
          toRulesWarning(
            "invalid_node_selection_max_frames",
            `Node '${nodeId}' has invalid selection.max_frames`,
            nodeId,
          ),
        );
      }

      if (Object.keys(selection).length > 0) {
        nodeRule.selection = selection;
      }
    }

    if (typeof nodeRuleUnknown.binary_derived_mask_of === "string") {
      nodeRule.binary_derived_mask_of = nodeRuleUnknown.binary_derived_mask_of;
    }
    if (typeof nodeRuleUnknown.soft_derived_mask_of === "string") {
      nodeRule.soft_derived_mask_of = nodeRuleUnknown.soft_derived_mask_of;
    }

    nodes[nodeId] = nodeRule;
  }

  return nodes;
}

function normalizeSlotRules(
  rawSlots: Record<string, unknown>,
  warnings: WorkflowRuleWarning[],
): Record<string, WorkflowRuleSlot> {
  const slots: Record<string, WorkflowRuleSlot> = {};

  for (const [slotId, rawSlotUnknown] of Object.entries(rawSlots)) {
    if (!isRecord(rawSlotUnknown)) {
      warnings.push(
        toRulesWarning(
          "invalid_slot_rule",
          "Slot rule must be an object",
          slotId,
        ),
      );
      continue;
    }

    const slotRule: WorkflowRuleSlot = {};
    if (typeof rawSlotUnknown.input_type === "string") {
      slotRule.input_type = rawSlotUnknown.input_type;
    }
    if (typeof rawSlotUnknown.label === "string") {
      slotRule.label = rawSlotUnknown.label;
    }
    if (typeof rawSlotUnknown.param === "string") {
      slotRule.param = rawSlotUnknown.param;
    }
    if ("experimental" in rawSlotUnknown) {
      slotRule.experimental = Boolean(rawSlotUnknown.experimental);
    }

    const exportFps = toPositiveInteger(rawSlotUnknown.export_fps);
    if (exportFps !== null) {
      slotRule.export_fps = exportFps;
    } else if (rawSlotUnknown.export_fps !== undefined) {
      warnings.push(
        toRulesWarning(
          "invalid_slot_export_fps",
          `Slot '${slotId}' has invalid export_fps`,
        ),
      );
    }

    const frameStep = toPositiveInteger(rawSlotUnknown.frame_step);
    if (frameStep !== null) {
      slotRule.frame_step = frameStep;
    } else if (rawSlotUnknown.frame_step !== undefined) {
      warnings.push(
        toRulesWarning(
          "invalid_slot_frame_step",
          `Slot '${slotId}' has invalid frame_step`,
        ),
      );
    }

    const maxFrames = toPositiveInteger(rawSlotUnknown.max_frames);
    if (maxFrames !== null) {
      slotRule.max_frames = maxFrames;
    } else if (rawSlotUnknown.max_frames !== undefined) {
      warnings.push(
        toRulesWarning(
          "invalid_slot_max_frames",
          `Slot '${slotId}' has invalid max_frames`,
        ),
      );
    }

    if (Object.keys(slotRule).length > 0) {
      slots[slotId] = slotRule;
    }
  }

  return slots;
}

function normalizeValidationConfig(
  rawValidation: unknown,
  warnings: WorkflowRuleWarning[],
): WorkflowValidationConfig {
  const validation: WorkflowValidationConfig = { inputs: [] };

  if (isRecord(rawValidation)) {
    if (Array.isArray(rawValidation.inputs)) {
      validation.inputs = rawValidation.inputs.flatMap((rawRule, index) => {
        const normalizedRule = normalizeValidationInputRule(
          rawRule,
          warnings,
          index,
        );
        return normalizedRule ? [normalizedRule] : [];
      });
    } else if ("inputs" in rawValidation) {
      warnings.push(
        toRulesWarning(
          "invalid_validation_inputs",
          "validation.inputs must be an array",
        ),
      );
    }
  } else if (rawValidation !== undefined) {
    warnings.push(
      toRulesWarning("invalid_validation", "validation must be an object"),
    );
  }

  return validation;
}

function normalizeInputConditions(
  rawConditions: unknown,
  validation: WorkflowValidationConfig,
): WorkflowInputCondition[] | undefined {
  if (!Array.isArray(rawConditions)) {
    return undefined;
  }

  const normalizedConditions = rawConditions.flatMap((condition) => {
    if (!isRecord(condition)) return [];
    if (condition.kind !== "at_least_one") return [];
    if (!Array.isArray(condition.inputs)) return [];

    const inputs = condition.inputs
      .filter((inputId): inputId is string => typeof inputId === "string")
      .map((inputId) => inputId.trim())
      .filter((inputId) => inputId.length > 0);
    if (inputs.length === 0) return [];

    return [
      {
        kind: "at_least_one" as const,
        inputs,
        ...(typeof condition.message === "string" &&
        condition.message.trim().length > 0
          ? { message: condition.message.trim() }
          : {}),
      },
    ];
  });

  if (normalizedConditions.length === 0) {
    return undefined;
  }

  if (validation.inputs.length === 0) {
    validation.inputs = normalizedConditions.map((condition) => ({
      kind: "at_least_n",
      inputs: condition.inputs,
      min: 1,
      ...(condition.message ? { message: condition.message } : {}),
    }));
  }

  return normalizedConditions;
}

function normalizeMaskCropping(
  rawMaskCropping: unknown,
  warnings: WorkflowRuleWarning[],
): WorkflowMaskCroppingConfig {
  const maskCropping: WorkflowMaskCroppingConfig = {
    ...DEFAULT_WORKFLOW_MASK_CROPPING,
  };

  if (rawMaskCropping !== undefined && !isRecord(rawMaskCropping)) {
    warnings.push(
      toRulesWarning(
        "invalid_mask_cropping_rule",
        "mask_cropping must be an object",
      ),
    );
  }

  const maskCroppingRecord = toStringRecord(rawMaskCropping);
  if ("mode" in maskCroppingRecord) {
    if (
      maskCroppingRecord.mode === "crop" ||
      maskCroppingRecord.mode === "full"
    ) {
      maskCropping.mode = maskCroppingRecord.mode;
    } else {
      warnings.push(
        toRulesWarning(
          "invalid_mask_cropping_mode",
          "mask_cropping.mode must be 'crop' or 'full'; defaulting to crop",
        ),
      );
    }
  } else if ("enabled" in maskCroppingRecord) {
    if (typeof maskCroppingRecord.enabled === "boolean") {
      maskCropping.mode = maskCroppingRecord.enabled ? "crop" : "full";
    } else {
      warnings.push(
        toRulesWarning(
          "invalid_mask_cropping_enabled",
          "mask_cropping.enabled must be a boolean; defaulting to crop",
        ),
      );
    }
  }

  return maskCropping;
}

function normalizePostprocessing(
  rawPostprocessing: unknown,
  warnings: WorkflowRuleWarning[],
) {
  const postprocessing = {
    ...DEFAULT_WORKFLOW_POSTPROCESSING,
  };

  if (rawPostprocessing !== undefined && !isRecord(rawPostprocessing)) {
    warnings.push(
      toRulesWarning(
        "invalid_postprocessing_rule",
        "postprocessing must be an object",
      ),
    );
  }

  const postprocessingRecord = toStringRecord(rawPostprocessing);
  if ("mode" in postprocessingRecord) {
    const rawMode = postprocessingRecord.mode;
    if (
      rawMode === "auto" ||
      rawMode === "stitch_frames_with_audio" ||
      rawMode === "none"
    ) {
      postprocessing.mode = rawMode;
    } else {
      warnings.push(
        toRulesWarning(
          "invalid_postprocessing_mode",
          "postprocessing.mode is invalid; defaulting to 'auto'",
        ),
      );
    }
  }
  if ("panel_preview" in postprocessingRecord) {
    const rawPanelPreview = postprocessingRecord.panel_preview;
    if (
      rawPanelPreview === "raw_outputs" ||
      rawPanelPreview === "replace_outputs"
    ) {
      postprocessing.panel_preview = rawPanelPreview;
    } else {
      warnings.push(
        toRulesWarning(
          "invalid_postprocessing_panel_preview",
          "postprocessing.panel_preview is invalid; defaulting to 'raw_outputs'",
        ),
      );
    }
  }
  if ("on_failure" in postprocessingRecord) {
    const rawOnFailure = postprocessingRecord.on_failure;
    if (rawOnFailure === "fallback_raw" || rawOnFailure === "show_error") {
      postprocessing.on_failure = rawOnFailure;
    } else {
      warnings.push(
        toRulesWarning(
          "invalid_postprocessing_on_failure",
          "postprocessing.on_failure is invalid; defaulting to 'fallback_raw'",
        ),
      );
    }
  }
  if ("stitch_fps" in postprocessingRecord) {
    const rawStitchFps = toPositiveInteger(postprocessingRecord.stitch_fps);
    if (rawStitchFps !== null) {
      postprocessing.stitch_fps = rawStitchFps;
    } else {
      warnings.push(
        toRulesWarning(
          "invalid_postprocessing_stitch_fps",
          "postprocessing.stitch_fps is invalid; ignoring override",
        ),
      );
    }
  }

  return postprocessing;
}

function normalizeAspectRatioProcessing(
  rawArp: unknown,
): WorkflowAspectRatioProcessingConfig | undefined {
  if (!isRecord(rawArp)) {
    return undefined;
  }

  const resolutions: number[] = [];
  if (Array.isArray(rawArp.resolutions)) {
    for (const resolution of rawArp.resolutions) {
      if (
        typeof resolution === "number" &&
        Number.isFinite(resolution) &&
        resolution > 0
      ) {
        resolutions.push(Math.round(resolution));
      }
    }
  }

  const targetNodes: WorkflowAspectRatioProcessingConfig["target_nodes"] = [];
  if (Array.isArray(rawArp.target_nodes)) {
    for (const targetNode of rawArp.target_nodes) {
      if (
        isRecord(targetNode) &&
        typeof targetNode.node_id === "string" &&
        typeof targetNode.width_param === "string" &&
        typeof targetNode.height_param === "string"
      ) {
        targetNodes.push({
          node_id: targetNode.node_id,
          width_param: targetNode.width_param,
          height_param: targetNode.height_param,
        });
      }
    }
  }

  const arpPostprocess = isRecord(rawArp.postprocess) ? rawArp.postprocess : {};
  return {
    enabled: Boolean(rawArp.enabled),
    stride:
      typeof rawArp.stride === "number" && rawArp.stride > 0
        ? rawArp.stride
        : 16,
    search_steps:
      typeof rawArp.search_steps === "number" && rawArp.search_steps >= 0
        ? rawArp.search_steps
        : 2,
    resolutions,
    target_nodes: targetNodes,
    postprocess: {
      enabled: arpPostprocess.enabled !== false,
      mode:
        typeof arpPostprocess.mode === "string"
          ? arpPostprocess.mode
          : "stretch_exact",
      apply_to:
        typeof arpPostprocess.apply_to === "string"
          ? arpPostprocess.apply_to
          : "all_visual_outputs",
    },
  };
}

function normalizeDerivedWidgets(
  rawDerivedWidgets: unknown,
  warnings: WorkflowRuleWarning[],
): WorkflowDerivedWidgetRule[] | undefined {
  if (rawDerivedWidgets === undefined) {
    return undefined;
  }
  if (!Array.isArray(rawDerivedWidgets)) {
    warnings.push(
      toRulesWarning(
        "invalid_derived_widgets",
        "derived_widgets must be an array",
      ),
    );
    return undefined;
  }

  const normalizedDerivedWidgets = rawDerivedWidgets.flatMap((rawRule, index) => {
    const normalized = normalizeDerivedWidgetRule(rawRule, warnings, index);
    return normalized ? [normalized] : [];
  });

  return normalizedDerivedWidgets.length > 0 ? normalizedDerivedWidgets : undefined;
}

export function normalizeWorkflowRules(rawRules: unknown): {
  rules: WorkflowRules;
  warnings: WorkflowRuleWarning[];
} {
  const warnings: WorkflowRuleWarning[] = [];
  const raw = toStringRecord(rawRules);

  const versionValue = raw.version;
  const version = typeof versionValue === "number" ? versionValue : 1;
  if (versionValue !== undefined && typeof versionValue !== "number") {
    warnings.push(
      toRulesWarning(
        "invalid_rules_version",
        "Rules version is invalid; falling back to version 1",
      ),
    );
  }

  const nodes = normalizeNodeRules(toStringRecord(raw.nodes), warnings);
  const slots = normalizeSlotRules(toStringRecord(raw.slots), warnings);
  const validation = normalizeValidationConfig(raw.validation, warnings);
  const inputConditions = normalizeInputConditions(raw.input_conditions, validation);
  const maskCropping = normalizeMaskCropping(raw.mask_cropping, warnings);
  const postprocessing = normalizePostprocessing(raw.postprocessing, warnings);
  const aspectRatioProcessing = normalizeAspectRatioProcessing(
    raw.aspect_ratio_processing,
  );
  const derivedWidgets = normalizeDerivedWidgets(raw.derived_widgets, warnings);

  return {
    rules: createDefaultWorkflowRules({
      version,
      nodes,
      validation,
      ...(inputConditions ? { input_conditions: inputConditions } : {}),
      derived_widgets: derivedWidgets ?? [],
      output_injections: toStringRecord(
        raw.output_injections,
      ) as WorkflowRules["output_injections"],
      slots,
      mask_cropping: maskCropping,
      postprocessing,
      ...(aspectRatioProcessing
        ? { aspect_ratio_processing: aspectRatioProcessing }
        : {}),
    }),
    warnings,
  };
}
