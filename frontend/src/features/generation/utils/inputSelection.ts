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
  normalizeTimelineSelection,
  resolveSelectionFps,
  resolveSelectionFrameStep,
  snapFrameCountToStep,
} from "../../timelineSelection";
import type {
  DerivedMaskMapping,
  DerivedMaskPurpose,
  DerivedMaskType,
  TimelineSelectionRenderMode,
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
  const normalizedSelection = normalizeTimelineSelection(
    timelineSelection,
    projectData.clips,
  );

  const renderer = await ExportRenderer.create(exportConfig);
  try {
    const result = await renderer.render(projectData, exportConfig, () => {}, {
      timelineSelection: normalizedSelection,
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
  maskHasVisibleContent: boolean;
}

export type DerivedMaskRenderKey =
  | "video_binary"
  | "video_soft"
  | `audio_timing_binary_${number}`;

export interface TimelineSelectionWithDerivedMasksResult {
  video: File;
  masks: Partial<Record<DerivedMaskRenderKey, File>>;
  maskContentByKey: Partial<Record<DerivedMaskRenderKey, boolean>>;
}

export const DEFAULT_AUDIO_TIMING_MASK_EXPORT_FPS = 25;

type RenderSelectionOutputDefinition =
  | ReturnType<typeof createVideoOutputDefinition>
  | ReturnType<typeof createMaskOutputDefinition>;

function getDerivedMaskPurpose(
  mapping: Pick<DerivedMaskMapping, "purpose">,
): DerivedMaskPurpose {
  return mapping.purpose === "audio_timing" ? "audio_timing" : "video";
}

function resolveTimelineSelectionRenderMode(
  mode: TimelineSelectionRenderMode | undefined,
): TimelineSelectionRenderMode {
  return mode === "full_selection" ? "full_selection" : "input_selection";
}

function resolveTimelineSelectionForRenderMode(
  timelineSelection: TimelineSelection,
  mode: TimelineSelectionRenderMode | undefined,
): TimelineSelection {
  if (resolveTimelineSelectionRenderMode(mode) !== "full_selection") {
    return timelineSelection;
  }
  if (
    !Array.isArray(timelineSelection.includedTrackIds) ||
    timelineSelection.includedTrackIds.length === 0
  ) {
    return timelineSelection;
  }

  const fullSelection: TimelineSelection = {
    ...timelineSelection,
  };
  delete fullSelection.includedTrackIds;
  return fullSelection;
}

function resolveSharedSourceSelectionMode(
  derivedMaskMappings: readonly Pick<DerivedMaskMapping, "sourceSelection">[],
): TimelineSelectionRenderMode {
  const modes = new Set<TimelineSelectionRenderMode>();
  for (const mapping of derivedMaskMappings) {
    modes.add(resolveTimelineSelectionRenderMode(mapping.sourceSelection));
  }
  if (modes.size > 1) {
    throw new Error(
      "Derived masks for a single source requested conflicting source selection modes",
    );
  }
  return [...modes][0] ?? "input_selection";
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

function createMaskOutputDefinition(
  maskType: DerivedMaskType,
  options: {
    trackRenderedMaskContent?: boolean;
  } = {},
) {
  return {
    id: "mask",
    format: "mp4" as const,
    includeAudio: false,
    bitrate: 20_000_000,
    transformStack: [createFilterStackTransform([createMaskFilter(maskType)])],
    ...(options.trackRenderedMaskContent
      ? { contentProbe: "non_black_pixels" as const }
      : {}),
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

function normalizeOutputDimension(
  value: number | undefined,
  fallback: number,
): number {
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
): Promise<Awaited<ReturnType<ExportRenderer["render"]>>> {
  throwIfAborted(options.signal);
  const { exportConfig, projectData } = buildProjectRenderInputs();
  const normalizedSelection = normalizeTimelineSelection(
    timelineSelection,
    projectData.clips,
  );
  const renderConfig = {
    ...exportConfig,
    outputWidth: normalizeOutputDimension(
      options.outputWidth,
      exportConfig.outputWidth,
    ),
    outputHeight: normalizeOutputDimension(
      options.outputHeight,
      exportConfig.outputHeight,
    ),
  };
  const renderer = await ExportRenderer.create({
    ...renderConfig,
  });
  const result = await renderer.render(projectData, renderConfig, () => {}, {
    timelineSelection: normalizedSelection,
    outputs: [...outputs],
    includeTimelineMasks: options.includeTimelineMasks,
    signal: options.signal,
  });
  return result;
}

function getRenderedMaskHasVisibleContent(
  result: Awaited<ReturnType<ExportRenderer["render"]>>,
): boolean {
  return result.outputAnalyses?.mask?.hasVisibleContent ?? true;
}

async function renderTimelineSelectionToMaskOutput(
  timelineSelection: TimelineSelection,
  maskType: DerivedMaskType = "binary",
  options: RenderTimelineSelectionMaskOptions & {
    trackRenderedMaskContent?: boolean;
  } = {},
): Promise<{ file: File; hasVisibleContent: boolean }> {
  const result = await renderTimelineSelectionToOutputs(
    timelineSelection,
    [
      createMaskOutputDefinition(maskType, {
        trackRenderedMaskContent: options.trackRenderedMaskContent,
      }),
    ],
    {
      signal: options.signal,
      outputWidth: options.outputWidth,
      outputHeight: options.outputHeight,
    },
  );
  const maskBlob = result.outputs.mask;
  if (!maskBlob) {
    throw new Error("Mask output was requested but not produced");
  }

  return {
    file: createOutputFile(
      maskBlob,
      `generation-selection-mask-${Date.now()}.mp4`,
    ),
    hasVisibleContent: getRenderedMaskHasVisibleContent(result),
  };
}

export async function renderTimelineSelectionToMaskMp4(
  timelineSelection: TimelineSelection,
  maskType: DerivedMaskType = "binary",
  options: RenderTimelineSelectionMaskOptions = {},
): Promise<File> {
  throwIfAborted(options.signal);

  try {
    const result = await renderTimelineSelectionToMaskOutput(
      timelineSelection,
      maskType,
      options,
    );
    return result.file;
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
    | "maskType"
    | "purpose"
    | "renderFps"
    | "optional"
    | "sourceSelection"
    | "maskSelection"
  >[],
  options: {
    signal?: AbortSignal;
    preparedVideoFile?: File;
    preparedMaskFile?: File | null;
  } = {},
): Promise<TimelineSelectionWithDerivedMasksResult> {
  const sourceSelectionMode =
    resolveSharedSourceSelectionMode(derivedMaskMappings);
  const sourceTimelineSelection = resolveTimelineSelectionForRenderMode(
    timelineSelection,
    sourceSelectionMode,
  );
  const masks: Partial<Record<DerivedMaskRenderKey, File>> = {};
  const maskContentByKey: Partial<Record<DerivedMaskRenderKey, boolean>> = {};
  const requiredMasksByKey = new Map<
    DerivedMaskRenderKey,
    Pick<
      DerivedMaskMapping,
      | "maskType"
      | "purpose"
      | "renderFps"
      | "optional"
      | "sourceSelection"
      | "maskSelection"
    >
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
  const hasOptionalVisualMask = derivedMaskMappings.some(
    (mapping) =>
      getDerivedMaskPurpose(mapping) === "video" && mapping.optional === true,
  );
  const singleVisualMaskMapping =
    visualMaskKeys.length === 1
      ? requiredMasksByKey.get(visualMaskKeys[0]) ?? null
      : null;

  if (
    options.preparedMaskFile &&
    visualMaskKeys.length === 1 &&
    !hasOptionalVisualMask
  ) {
    masks[visualMaskKeys[0]] = options.preparedMaskFile;
    maskContentByKey[visualMaskKeys[0]] = true;
  }

  const preparedVideoFile = options.preparedVideoFile;
  const canReusePreparedVideo = !!preparedVideoFile;

  if (
    !canReusePreparedVideo &&
    requiredMaskKeys.length === 1 &&
    visualMaskKeys.length === 1 &&
    !masks[visualMaskKeys[0]] &&
    resolveTimelineSelectionRenderMode(singleVisualMaskMapping?.maskSelection) ===
      sourceSelectionMode
  ) {
    const { video, mask, maskHasVisibleContent } =
      await renderTimelineSelectionToMp4WithMask(
        sourceTimelineSelection,
        visualMaskKeys[0] === "video_soft" ? "soft" : "binary",
        {
          signal: options.signal,
        },
      );
    masks[visualMaskKeys[0]] = mask;
    maskContentByKey[visualMaskKeys[0]] = maskHasVisibleContent;
    return { video, masks, maskContentByKey };
  }

  const video = canReusePreparedVideo
    ? preparedVideoFile
    : await renderTimelineSelectionToMp4(sourceTimelineSelection, {
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
    const maskTimelineSelection = resolveTimelineSelectionForRenderMode(
      timelineSelection,
      mapping.maskSelection,
    );
    if (getDerivedMaskPurpose(mapping) === "audio_timing") {
      // Audio timing masks are reduced to per-frame activity downstream, so
      // shrinking them here can erase small active regions entirely.
      masks[key] = await renderTimelineSelectionToMaskMp4(
        {
          ...maskTimelineSelection,
          fps: resolveAudioTimingMaskExportFps(mapping.renderFps),
          frameStep: 1,
        },
        "binary",
        {
          signal: options.signal,
        },
      );
      maskContentByKey[key] = true;
      continue;
    }
    const { file, hasVisibleContent } =
      await renderTimelineSelectionToMaskOutput(
        maskTimelineSelection,
        key === "video_soft" ? "soft" : "binary",
        {
          signal: options.signal,
          trackRenderedMaskContent: true,
        },
      );
    masks[key] = file;
    maskContentByKey[key] = hasVisibleContent;
  }

  return { video, masks, maskContentByKey };
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
  const normalizedSelection = normalizeTimelineSelection(
    timelineSelection,
    projectData.clips,
  );
  try {
    const maskOutput = createMaskOutputDefinition(maskType, {
      trackRenderedMaskContent: true,
    });
    const maskRenderer = await ExportRenderer.create(exportConfig);
    const maskResult = await maskRenderer.render(
      projectData,
      exportConfig,
      () => {},
      {
        timelineSelection: normalizedSelection,
        outputs: [maskOutput],
        signal: options.signal,
      },
    );
    const maskBlob =
      maskResult.outputs.mask ?? maskResult.mask ?? maskResult.video;
    throwIfAborted(options.signal);

    const videoRenderer = await ExportRenderer.create(exportConfig);
    const videoResult = await videoRenderer.render(
      projectData,
      exportConfig,
      () => {},
      {
        timelineSelection: normalizedSelection,
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
      maskHasVisibleContent: getRenderedMaskHasVisibleContent(maskResult),
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
        : (options.frameStep ?? timelineSelection.frameStep),
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
      await captureFramePngAtTick(
        startTick,
        "generation-selection-frame-0",
        timelineSelection,
      ),
    );
  }

  return frames;
}
