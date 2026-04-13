import type {
  PipelineControl,
  WorkflowAspectRatioStage,
  WorkflowMaskProcessingStage,
  WorkflowOutputAssemblyStage,
  WorkflowPostprocessingConfig,
  WorkflowRules,
} from "./types";

export function findWorkflowStageByKind<
  TStage extends WorkflowRules["pipeline"] extends Array<infer U> ? U : never,
>(
  rules: WorkflowRules | null | undefined,
  kind: string,
): TStage | null {
  for (const stage of rules?.pipeline ?? []) {
    if (stage.kind === kind) {
      return stage as TStage;
    }
  }
  return null;
}

export function findWorkflowStageById<
  TStage extends WorkflowRules["pipeline"] extends Array<infer U> ? U : never,
>(
  rules: WorkflowRules | null | undefined,
  stageId: string,
): TStage | null {
  for (const stage of rules?.pipeline ?? []) {
    if (stage.id === stageId) {
      return stage as TStage;
    }
  }
  return null;
}

export function getWorkflowStageControl(
  stage: { controls?: PipelineControl[] } | null | undefined,
  key: string,
): PipelineControl | null {
  for (const control of stage?.controls ?? []) {
    if (control.key === key) {
      return control;
    }
  }
  return null;
}

export function getMaskProcessingStage(
  rules: WorkflowRules | null | undefined,
): WorkflowMaskProcessingStage | null {
  return findWorkflowStageByKind<WorkflowMaskProcessingStage>(
    rules,
    "mask_processing",
  );
}

export function getAspectRatioStage(
  rules: WorkflowRules | null | undefined,
): WorkflowAspectRatioStage | null {
  return findWorkflowStageByKind<WorkflowAspectRatioStage>(
    rules,
    "aspect_ratio",
  );
}

export function getOutputAssemblyStage(
  rules: WorkflowRules | null | undefined,
): WorkflowOutputAssemblyStage | null {
  return findWorkflowStageByKind<WorkflowOutputAssemblyStage>(
    rules,
    "output_assembly",
  );
}

export function getMaskCropModeDefault(
  rules: WorkflowRules | null | undefined,
): "crop" | "full" {
  const control = getWorkflowStageControl(getMaskProcessingStage(rules), "crop_mode");
  return control?.default === "full" ? "full" : "crop";
}

export function getMaskCropDilationDefault(
  rules: WorkflowRules | null | undefined,
  fallback = 0.1,
): number {
  const control = getWorkflowStageControl(
    getMaskProcessingStage(rules),
    "crop_dilation",
  );
  return typeof control?.default === "number" ? control.default : fallback;
}

export function getWorkflowPostprocessingConfig(
  rules: WorkflowRules | null | undefined,
): WorkflowPostprocessingConfig {
  const config = getOutputAssemblyStage(rules)?.config;
  return {
    mode: config?.mode ?? "auto",
    panel_preview: config?.panel_preview ?? "raw_outputs",
    on_failure: config?.on_failure ?? "fallback_raw",
    ...(typeof config?.stitch_fps === "number"
      ? { stitch_fps: config.stitch_fps }
      : {}),
  };
}

export function buildWorkflowReplayPipelineInputs(
  rules: WorkflowRules | null | undefined,
  options: {
    targetResolution: number;
    maskCropMode: "crop" | "full";
    maskCropDilation: number;
  },
): Record<string, Record<string, unknown>> {
  const pipelineInputs: Record<string, Record<string, unknown>> = {};

  const aspectRatioStage = getAspectRatioStage(rules);
  if (aspectRatioStage && getWorkflowStageControl(aspectRatioStage, "target_resolution")) {
    pipelineInputs[aspectRatioStage.id] = {
      target_resolution: options.targetResolution,
    };
  }

  const maskProcessingStage = getMaskProcessingStage(rules);
  if (maskProcessingStage) {
    const stageInputs: Record<string, unknown> = {};
    if (getWorkflowStageControl(maskProcessingStage, "crop_mode")) {
      stageInputs.crop_mode = options.maskCropMode;
    }
    if (
      options.maskCropMode !== "full" &&
      getWorkflowStageControl(maskProcessingStage, "crop_dilation")
    ) {
      stageInputs.crop_dilation = options.maskCropDilation;
    }
    if (Object.keys(stageInputs).length > 0) {
      pipelineInputs[maskProcessingStage.id] = stageInputs;
    }
  }

  return pipelineInputs;
}

export function getWorkflowReplayPipelineValue(
  rules: WorkflowRules | null | undefined,
  pipelineInputs: Record<string, Record<string, unknown>> | null | undefined,
  options: {
    stageKind: "aspect_ratio" | "mask_processing" | "output_assembly";
    key: string;
  },
): unknown {
  if (!pipelineInputs) {
    return undefined;
  }

  const stage =
    options.stageKind === "aspect_ratio"
      ? getAspectRatioStage(rules)
      : options.stageKind === "mask_processing"
        ? getMaskProcessingStage(rules)
        : getOutputAssemblyStage(rules);
  if (!stage) {
    return undefined;
  }

  const stageInputs = pipelineInputs[stage.id];
  if (!stageInputs || typeof stageInputs !== "object") {
    return undefined;
  }

  return stageInputs[options.key];
}
