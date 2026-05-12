import type {
  WorkflowMaskCroppingMode,
  WorkflowWidgetInput,
  WidgetInputConfig,
} from "../../types";
import type {
  PipelineControl,
  WorkflowRules,
} from "./types";
import {
  getAspectRatioStage,
  getMaskProcessingStage,
} from "./pipeline";

const PIPELINE_WIDGET_NODE_ID_PREFIX = "__pipeline__:";

function buildPipelineWidgetNodeId(stageId: string): string {
  return `${PIPELINE_WIDGET_NODE_ID_PREFIX}${stageId}`;
}

export function isPipelineWidgetNodeId(nodeId: string): boolean {
  return nodeId.startsWith(PIPELINE_WIDGET_NODE_ID_PREFIX);
}

function toPipelineWidgetValueType(
  control: PipelineControl,
): WidgetInputConfig["valueType"] {
  if (Array.isArray(control.options) && control.options.length > 0) {
    return "enum";
  }
  return control.value_type ?? "unknown";
}

function toPipelineWidgetConfig(
  stageId: string,
  control: PipelineControl,
  overrides: Partial<WidgetInputConfig> = {},
): WidgetInputConfig {
  return {
    label: control.label ?? control.key,
    ...(control.description ? { description: control.description } : {}),
    controlAfterGenerate: false,
    frontendOnly: true,
    ...(control.section_id ? { sectionId: control.section_id } : {}),
    ...(control.group_id ? { groupId: control.group_id } : {}),
    ...(control.group_title ? { groupTitle: control.group_title } : {}),
    ...(typeof control.group_order === "number"
      ? { groupOrder: control.group_order }
      : {}),
    ...(control.control ? { control: control.control } : {}),
    ...(control.slider_display ? { sliderDisplay: control.slider_display } : {}),
    ...(control.unit ? { unit: control.unit } : {}),
    ...(control.display_unit
      ? {
          displayUnit: {
            scale: control.display_unit.scale ?? 1,
            offset: control.display_unit.offset ?? 0,
            ...(control.display_unit.unit
              ? { unit: control.display_unit.unit }
              : {}),
            ...(typeof control.display_unit.precision === "number"
              ? { precision: control.display_unit.precision }
              : {}),
          },
        }
      : {}),
    ...(typeof control.min === "number" ? { min: control.min } : {}),
    ...(typeof control.max === "number" ? { max: control.max } : {}),
    ...(typeof control.step === "number" ? { step: control.step } : {}),
    ...(control.default !== undefined ? { defaultValue: control.default } : {}),
    ...(Array.isArray(control.options) ? { options: [...control.options] } : {}),
    ...(control.true_value !== undefined ? { trueValue: control.true_value } : {}),
    ...(control.false_value !== undefined
      ? { falseValue: control.false_value }
      : {}),
    nodeTitle: stageId,
    valueType: toPipelineWidgetValueType(control),
    ...overrides,
  };
}

function createPipelineWidgetInput(
  stageId: string,
  control: PipelineControl,
  currentValue: unknown,
  overrides: Partial<WidgetInputConfig> = {},
): WorkflowWidgetInput {
  return {
    kind: "raw",
    nodeId: buildPipelineWidgetNodeId(stageId),
    param: control.key,
    currentValue,
    config: toPipelineWidgetConfig(stageId, control, overrides),
  };
}

function getStageControl(
  controls: PipelineControl[] | undefined,
  key: string,
): PipelineControl | null {
  for (const control of controls ?? []) {
    if (control.key === key) {
      return control;
    }
  }
  return null;
}

interface ResolvePipelineWidgetInputsOptions {
  showTargetResolution: boolean;
  currentResolution: number;
  showMaskControls: boolean;
  maskCropMode: WorkflowMaskCroppingMode;
  maskCropDilation: number;
}

export function resolvePipelineWidgetInputs(
  rules: WorkflowRules | null | undefined,
  options: ResolvePipelineWidgetInputsOptions,
): WorkflowWidgetInput[] {
  const result: WorkflowWidgetInput[] = [];

  if (options.showTargetResolution) {
    const aspectRatioStage = getAspectRatioStage(rules);
    const targetResolutionControl = getStageControl(
      aspectRatioStage?.controls,
      "target_resolution",
    );
    if (aspectRatioStage && targetResolutionControl) {
      result.push(
        createPipelineWidgetInput(
          aspectRatioStage.id,
          targetResolutionControl,
          options.currentResolution,
        ),
      );
    }
  }

  if (options.showMaskControls) {
    const maskProcessingStage = getMaskProcessingStage(rules);
    const cropModeControl = getStageControl(
      maskProcessingStage?.controls,
      "crop_mode",
    );
    if (maskProcessingStage && cropModeControl) {
      result.push(
        createPipelineWidgetInput(
          maskProcessingStage.id,
          cropModeControl,
          options.maskCropMode,
        ),
      );
    }

    const cropDilationControl = getStageControl(
      maskProcessingStage?.controls,
      "crop_dilation",
    );
    if (maskProcessingStage && cropDilationControl) {
      result.push(
        createPipelineWidgetInput(
          maskProcessingStage.id,
          cropDilationControl,
          options.maskCropDilation,
          {
            hidden: options.maskCropMode === "full",
          },
        ),
      );
    }
  }

  return result;
}

export function getPipelineWidgetKey(
  stageId: string,
  controlKey: string,
): string {
  return `${buildPipelineWidgetNodeId(stageId)}:${controlKey}`;
}
