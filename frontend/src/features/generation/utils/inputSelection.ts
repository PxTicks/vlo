import type { TimelineSelection } from "../../../types/TimelineTypes";
import {
  ExportRenderer,
  buildProjectRenderInputs,
  createBinaryMaskOutputFilter,
  createFilterStackTransform,
  createNonBinaryMaskOutputColorMatrixFilter,
  renderProjectFrameFileAtTick,
} from "../../renderer";
import {
  getTicksPerFrame,
  resolveSelectionFps,
  resolveSelectionFrameStep,
  snapFrameCountToStep,
} from "../../timelineSelection";
import type {
  DerivedMaskMapping,
  DerivedMaskPurpose,
  DerivedMaskType,
} from "../pipeline/types";
import {
  createGenerationAbortError,
  throwIfAborted,
} from "../pipeline/utils/abort";

export async function captureFramePngAtTick(
  tick: number,
  filenamePrefix: string,
  timelineSelection?: TimelineSelection,
): Promise<File> {
  return renderProjectFrameFileAtTick(tick, {
    filenamePrefix,
    mimeType: "image/png",
    timelineSelection,
  });
}

export async function renderTimelineSelectionToMp4(
  timelineSelection: TimelineSelection,
  options: {
    includeTimelineMasks?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<File> {
  throwIfAborted(options.signal);
  const { exportConfig, projectData } = buildProjectRenderInputs();

  const renderer = await ExportRenderer.create(exportConfig);
  try {
    const result = await renderer.render(projectData, exportConfig, () => {}, {
      timelineSelection,
      format: "mp4",
      includeTimelineMasks: options.includeTimelineMasks,
      signal: options.signal,
    });
    throwIfAborted(options.signal);

    return new File([result.video], `generation-selection-${Date.now()}.mp4`, {
      type: "video/mp4",
      lastModified: Date.now(),
    });
  } catch (error) {
    if (options.signal?.aborted && error instanceof Error) {
      throw createGenerationAbortError(error.message);
    }
    throw error;
  }
}

export interface TimelineSelectionWithMaskResult {
  video: File;
  mask: File;
}

export type DerivedMaskRenderKey =
  | "video_binary"
  | "video_soft"
  | `audio_timing_binary_${number}`;

export interface TimelineSelectionWithDerivedMasksResult {
  video: File;
  masks: Partial<Record<DerivedMaskRenderKey, File>>;
}

export const DEFAULT_AUDIO_TIMING_MASK_EXPORT_FPS = 25;
export const AUDIO_TIMING_MASK_OUTPUT_SIZE = 64;

type RenderSelectionOutputDefinition =
  | ReturnType<typeof createVideoOutputDefinition>
  | ReturnType<typeof createMaskOutputDefinition>;

function getDerivedMaskPurpose(
  mapping: Pick<DerivedMaskMapping, "purpose">,
): DerivedMaskPurpose {
  return mapping.purpose === "audio_timing" ? "audio_timing" : "video";
}

export function resolveAudioTimingMaskExportFps(
  renderFps: number | undefined,
): number {
  if (
    typeof renderFps === "number" &&
    Number.isFinite(renderFps) &&
    renderFps > 0
  ) {
    return Math.max(1, Math.round(renderFps));
  }
  return DEFAULT_AUDIO_TIMING_MASK_EXPORT_FPS;
}

export function getDerivedMaskRenderKey(
  mapping: Pick<DerivedMaskMapping, "maskType" | "purpose" | "renderFps">,
): DerivedMaskRenderKey {
  if (getDerivedMaskPurpose(mapping) === "audio_timing") {
    return `audio_timing_binary_${resolveAudioTimingMaskExportFps(mapping.renderFps)}`;
  }
  return mapping.maskType === "soft" ? "video_soft" : "video_binary";
}

export function pickPrimaryPreparedMaskFile(
  derivedMaskMappings: readonly Pick<
    DerivedMaskMapping,
    "maskType" | "purpose" | "renderFps"
  >[],
  masks: Partial<Record<DerivedMaskRenderKey, File>>,
): File | null {
  const primaryVisualMapping = derivedMaskMappings.find(
    (mapping) => getDerivedMaskPurpose(mapping) === "video",
  );
  if (!primaryVisualMapping) {
    return null;
  }
  return masks[getDerivedMaskRenderKey(primaryVisualMapping)] ?? null;
}

function createMaskFilter(maskType: DerivedMaskType) {
  switch (maskType) {
    case "binary":
      return createBinaryMaskOutputFilter();
    case "soft":
      return createNonBinaryMaskOutputColorMatrixFilter();
  }
}

function createVideoOutputDefinition() {
  return {
    id: "video",
    format: "mp4" as const,
    includeAudio: true,
  };
}

function createMaskOutputDefinition(maskType: DerivedMaskType) {
  return {
    id: "mask",
    format: "mp4" as const,
    includeAudio: false,
    bitrate: 20_000_000,
    transformStack: [createFilterStackTransform([createMaskFilter(maskType)])],
  };
}

interface RenderTimelineSelectionMaskOptions {
  signal?: AbortSignal;
  outputWidth?: number;
  outputHeight?: number;
}

function createOutputFile(blob: Blob, filename: string): File {
  const now = Date.now();
  return new File([blob], filename, {
    type: "video/mp4",
    lastModified: now,
  });
}

function normalizeOutputDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(2, Math.round(value / 2) * 2);
}

async function renderTimelineSelectionToOutputs(
  timelineSelection: TimelineSelection,
  outputs: readonly RenderSelectionOutputDefinition[],
  options: {
    signal?: AbortSignal;
    includeTimelineMasks?: boolean;
    outputWidth?: number;
    outputHeight?: number;
  } = {},
): Promise<Record<string, Blob>> {
  throwIfAborted(options.signal);
  const { exportConfig, projectData } = buildProjectRenderInputs();
  const renderConfig = {
    ...exportConfig,
    outputWidth: normalizeOutputDimension(options.outputWidth, exportConfig.outputWidth),
    outputHeight: normalizeOutputDimension(
      options.outputHeight,
      exportConfig.outputHeight,
    ),
  };
  const renderer = await ExportRenderer.create({
    ...renderConfig,
  });
  const result = await renderer.render(projectData, renderConfig, () => {}, {
    timelineSelection,
    outputs: [...outputs],
    includeTimelineMasks: options.includeTimelineMasks,
    signal: options.signal,
  });
  return result.outputs;
}

export async function renderTimelineSelectionToMaskMp4(
  timelineSelection: TimelineSelection,
  maskType: DerivedMaskType = "binary",
  options: RenderTimelineSelectionMaskOptions = {},
): Promise<File> {
  throwIfAborted(options.signal);

  try {
    const outputs = await renderTimelineSelectionToOutputs(
      timelineSelection,
      [createMaskOutputDefinition(maskType)],
      {
        signal: options.signal,
        outputWidth: options.outputWidth,
        outputHeight: options.outputHeight,
      },
    );
    const maskBlob = outputs.mask;
    if (!maskBlob) {
      throw new Error("Mask output was requested but not produced");
    }
    return createOutputFile(
      maskBlob,
      `generation-selection-mask-${Date.now()}.mp4`,
    );
  } catch (error) {
    if (options.signal?.aborted && error instanceof Error) {
      throw createGenerationAbortError(error.message);
    }
    throw error;
  }
}

export async function renderTimelineSelectionToMp4WithDerivedMasks(
  timelineSelection: TimelineSelection,
  derivedMaskMappings: readonly Pick<
    DerivedMaskMapping,
    "maskType" | "purpose" | "renderFps"
  >[],
  options: {
    signal?: AbortSignal;
    preparedVideoFile?: File;
    preparedMaskFile?: File | null;
  } = {},
): Promise<TimelineSelectionWithDerivedMasksResult> {
  const masks: Partial<Record<DerivedMaskRenderKey, File>> = {};
  const requiredMasksByKey = new Map<
    DerivedMaskRenderKey,
    Pick<DerivedMaskMapping, "maskType" | "purpose" | "renderFps">
  >();
  for (const mapping of derivedMaskMappings) {
    const key = getDerivedMaskRenderKey(mapping);
    if (!requiredMasksByKey.has(key)) {
      requiredMasksByKey.set(key, mapping);
    }
  }
  const requiredMaskKeys = [...requiredMasksByKey.keys()];
  const visualMaskKeys = requiredMaskKeys.filter(
    (key) => !key.startsWith("audio_timing_binary_"),
  );

  if (options.preparedMaskFile && visualMaskKeys.length === 1) {
    masks[visualMaskKeys[0]] = options.preparedMaskFile;
  }

  const preparedVideoFile = options.preparedVideoFile;
  const canReusePreparedVideo = !!preparedVideoFile;

  if (
    !canReusePreparedVideo &&
    requiredMaskKeys.length === 1 &&
    visualMaskKeys.length === 1 &&
    !masks[visualMaskKeys[0]]
  ) {
    const { video, mask } = await renderTimelineSelectionToMp4WithMask(
      timelineSelection,
      visualMaskKeys[0] === "video_soft" ? "soft" : "binary",
      { signal: options.signal },
    );
    masks[visualMaskKeys[0]] = mask;
    return { video, masks };
  }

  const video = canReusePreparedVideo
    ? preparedVideoFile
    : await renderTimelineSelectionToMp4(timelineSelection, {
        includeTimelineMasks: false,
        signal: options.signal,
      });

  for (const key of requiredMaskKeys) {
    if (masks[key]) {
      continue;
    }
    const mapping = requiredMasksByKey.get(key);
    if (!mapping) {
      continue;
    }
    if (getDerivedMaskPurpose(mapping) === "audio_timing") {
      masks[key] = await renderTimelineSelectionToMaskMp4(
        {
          ...timelineSelection,
          fps: resolveAudioTimingMaskExportFps(mapping.renderFps),
          frameStep: 1,
        },
        "binary",
        {
          signal: options.signal,
          outputWidth: AUDIO_TIMING_MASK_OUTPUT_SIZE,
          outputHeight: AUDIO_TIMING_MASK_OUTPUT_SIZE,
        },
      );
      continue;
    }
    masks[key] = await renderTimelineSelectionToMaskMp4(
      timelineSelection,
      key === "video_soft" ? "soft" : "binary",
      {
        signal: options.signal,
      },
    );
  }

  return { video, masks };
}

export async function renderTimelineSelectionToMp4WithMask(
  timelineSelection: TimelineSelection,
  maskType: DerivedMaskType = "binary",
  options: {
    signal?: AbortSignal;
  } = {},
): Promise<TimelineSelectionWithMaskResult> {
  throwIfAborted(options.signal);
  const { exportConfig, projectData } = buildProjectRenderInputs();
  try {
    const maskOutput = createMaskOutputDefinition(maskType);
    const maskRenderer = await ExportRenderer.create(exportConfig);
    const maskResult = await maskRenderer.render(
      projectData,
      exportConfig,
      () => {},
      {
        timelineSelection,
        outputs: [maskOutput],
        signal: options.signal,
      },
    );
    const maskBlob = maskResult.outputs.mask ?? maskResult.mask ?? maskResult.video;
    throwIfAborted(options.signal);

    const videoRenderer = await ExportRenderer.create(exportConfig);
    const videoResult = await videoRenderer.render(
      projectData,
      exportConfig,
      () => {},
      {
        timelineSelection,
        outputs: [createVideoOutputDefinition()],
        includeTimelineMasks: false,
        signal: options.signal,
      },
    );
    const videoBlob = videoResult.outputs.video ?? videoResult.video;

    throwIfAborted(options.signal);
    if (!videoBlob) {
      throw new Error("Video output was requested but not produced");
    }
    if (!maskBlob) {
      throw new Error("Mask output was requested but not produced");
    }

    const now = Date.now();
    return {
      video: createOutputFile(videoBlob, `generation-selection-${now}.mp4`),
      mask: createOutputFile(maskBlob, `generation-selection-mask-${now}.mp4`),
    };
  } catch (error) {
    if (options.signal?.aborted && error instanceof Error) {
      throw createGenerationAbortError(error.message);
    }
    throw error;
  }
}

export async function renderTimelineSelectionToFrameBatch(
  timelineSelection: TimelineSelection,
  fps: number,
  options: { frameStep?: number; maxFrames?: number } = {},
): Promise<File[]> {
  const clampedFps = resolveSelectionFps(timelineSelection, fps);
  const frameStep = resolveSelectionFrameStep({
    frameStep:
      timelineSelection.frameStep && timelineSelection.frameStep > 1
        ? timelineSelection.frameStep
        : options.frameStep ?? timelineSelection.frameStep,
  });
  const ticksPerFrame = getTicksPerFrame(clampedFps);
  const startTick = timelineSelection.start;
  const requestedEndTick = Math.max(
    startTick + ticksPerFrame,
    timelineSelection.end ?? startTick + ticksPerFrame,
  );
  const rawFrameCount = Math.max(
    1,
    Math.ceil((requestedEndTick - startTick) / ticksPerFrame),
  );
  let frameCount = snapFrameCountToStep(rawFrameCount, frameStep, "floor");
  const maxFrames =
    typeof options.maxFrames === "number" &&
    Number.isFinite(options.maxFrames) &&
    options.maxFrames > 0
      ? Math.max(1, Math.round(options.maxFrames))
      : null;
  if (maxFrames !== null) {
    frameCount = snapFrameCountToStep(
      Math.min(frameCount, maxFrames),
      frameStep,
      "floor",
    );
  }

  const frames: File[] = [];

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const tick = startTick + frameIndex * ticksPerFrame;
    const frame = await captureFramePngAtTick(
      tick,
      `generation-selection-frame-${frameIndex}`,
      timelineSelection,
    );
    frames.push(frame);
  }

  if (frames.length === 0) {
    frames.push(
      await captureFramePngAtTick(startTick, "generation-selection-frame-0", timelineSelection),
    );
  }

  return frames;
}
