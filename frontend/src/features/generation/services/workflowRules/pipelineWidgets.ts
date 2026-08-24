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
import { getWorkflowResolutionLadder } from "./resolutions";
import {
  getAspectRatioSelectionLabels,
  getAspectRatioSelectionOptions,
} from "../../utils/aspectRatioSelection";
import type { GenerationAspectRatioSelection } from "../../utils/aspectRatioSelection";

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

function shouldExposePipelineControl(
  control: PipelineControl | null,
): control is PipelineControl {
  return control !== null && control.expose !== "none";
}

interface ResolvePipelineWidgetInputsOptions {
  showTargetResolution: boolean;
  currentResolution: number;
  showAspectRatioSelector: boolean;
  aspectRatioSelection: GenerationAspectRatioSelection;
  projectAspectRatio: string;
  showMaskControls: boolean;
  maskCropMode: WorkflowMaskCroppingMode;
  maskCropDilation: number;
}

export function resolvePipelineWidgetInputs(
  rules: WorkflowRules | null | undefined,
  options: ResolvePipelineWidgetInputsOptions,
): WorkflowWidgetInput[] {
  const result: WorkflowWidgetInput[] = [];

  const aspectRatioStage = getAspectRatioStage(rules);

  if (options.showAspectRatioSelector && aspectRatioStage) {
    const targetAspectRatioControl = getStageControl(
      aspectRatioStage.controls,
      "target_aspect_ratio",
    );
    if (shouldExposePipelineControl(targetAspectRatioControl)) {
      result.push(
        createPipelineWidgetInput(
          aspectRatioStage.id,
          targetAspectRatioControl,
          options.aspectRatioSelection,
          {
            label: targetAspectRatioControl.label ?? "Aspect ratio",
            valueType: "enum",
            // The choices are the project's ratios, not something a workflow
            // enumerates, so they are supplied here rather than from `control.options`.
            options: getAspectRatioSelectionOptions(),
            optionLabels: getAspectRatioSelectionLabels(
              options.projectAspectRatio,
            ),
          },
        ),
      );
    }
  }

  if (options.showTargetResolution && aspectRatioStage) {
    const targetResolutionControl = getStageControl(
      aspectRatioStage.controls,
      "target_resolution",
    );
    if (shouldExposePipelineControl(targetResolutionControl)) {
      // Only a declared range becomes a ladder. A legacy `resolutions`
      // whitelist keeps its dropdown, since its values genuinely are the only
      // allowed ones and a custom field there would just be clamped away.
      const ladder = getWorkflowResolutionLadder(rules);
      result.push(
        createPipelineWidgetInput(
          aspectRatioStage.id,
          targetResolutionControl,
          options.currentResolution,
          ladder?.ladder
            ? {
                // The rungs drive a snapped slider and the value stays a plain
                // int, so a custom override off the ladder is still legal.
                //
                // Deliberately no `min`/`max`: the session validates widget
                // writes against them, so pinning the ladder's bounds here
                // would reject exactly the off-ladder values the custom field
                // exists to allow. The slider takes its bounds from the rungs.
                valueType: "int",
                options: undefined,
                resolutionLadder: ladder.values,
              }
            : {},
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
    if (maskProcessingStage && shouldExposePipelineControl(cropModeControl)) {
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
    if (
      maskProcessingStage &&
      shouldExposePipelineControl(cropDilationControl)
    ) {
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
