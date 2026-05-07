import { TICKS_PER_SECOND } from "../../timeline";
import {
  getIncludedTracksForSelection,
  getTicksPerFrame,
  resolveSelectionFps,
  resolveSelectionFrameStep,
  selectionHasMaskClip,
  snapFrameCountToStep,
} from "../../timelineSelection";
import type { GenerationMediaInputValue, WorkflowInput } from "../types";
import type {
  ProjectConfig,
  TimelineSelectionInputMetadata,
  WorkflowInputMetadata,
  WorkflowInputMetadataMap,
} from "../pipeline/types";
import {
  buildWorkflowInputLookup,
  getWorkflowInputId,
  getWorkflowInputValue,
  resolveWorkflowInputKeys,
} from "./workflowInputs";

function buildTimelineSelectionInputMetadata(
  selection: import("../../../types/TimelineTypes").TimelineSelection,
  projectFps: number,
): TimelineSelectionInputMetadata {
  const effectiveFps = resolveSelectionFps(selection, projectFps);
  const frameStep = resolveSelectionFrameStep(selection);
  const ticksPerFrame = getTicksPerFrame(effectiveFps);
  const requestedEndTick = Math.max(
    selection.start + ticksPerFrame,
    selection.end ?? selection.start + ticksPerFrame,
  );
  const rawFrameCount = Math.max(
    1,
    Math.ceil((requestedEndTick - selection.start) / ticksPerFrame),
  );
  const frameCount = snapFrameCountToStep(rawFrameCount, frameStep, "floor");
  const durationTicks = frameCount * ticksPerFrame;
  const includedTrackCount = getIncludedTracksForSelection(
    selection,
    selection.tracks ?? [],
  ).length;

  return {
    startTick: selection.start,
    endTick: selection.start + durationTicks,
    durationTicks,
    durationSeconds: durationTicks / TICKS_PER_SECOND,
    effectiveFps,
    frameStep,
    frameCount,
    clipCount: selection.clips.length,
    trackCount: selection.tracks?.length ?? 0,
    includedTrackCount,
    hasMaskClip: selectionHasMaskClip(selection),
    isRange:
      typeof selection.end === "number" && selection.end > selection.start,
  };
}

function buildWorkflowInputMetadata(
  workflowInput: WorkflowInput,
  value: GenerationMediaInputValue,
  projectConfig: ProjectConfig,
): WorkflowInputMetadata {
  if (value.kind === "asset") {
    return {
      sourceKind: "asset",
      inputType: workflowInput.inputType,
      mediaType:
        workflowInput.inputType === "text" ? undefined : workflowInput.inputType,
    };
  }

  if (value.kind === "frame") {
    return {
      sourceKind: "frame",
      inputType: workflowInput.inputType,
      mediaType: "image",
      ...(value.timelineSelection
        ? {
            timelineSelection: buildTimelineSelectionInputMetadata(
              value.timelineSelection,
              projectConfig.fps,
            ),
          }
        : {}),
    };
  }

  return {
    sourceKind: "timeline_selection",
    inputType: workflowInput.inputType,
    mediaType: value.mediaType,
    timelineSelection: buildTimelineSelectionInputMetadata(
      value.timelineSelection,
      projectConfig.fps,
    ),
  };
}

export function buildWorkflowInputMetadataMap(
  workflowInputs: WorkflowInput[],
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  projectConfig: ProjectConfig,
): WorkflowInputMetadataMap {
  const inputById = buildWorkflowInputLookup(workflowInputs);
  const metadata: WorkflowInputMetadataMap = {};

  for (const workflowInput of workflowInputs) {
    const value = getWorkflowInputValue(mediaInputs, workflowInput, inputById);
    if (!value) {
      continue;
    }

    const inputMetadata = buildWorkflowInputMetadata(
      workflowInput,
      value,
      projectConfig,
    );
    for (const inputKey of resolveWorkflowInputKeys(
      getWorkflowInputId(workflowInput),
      inputById,
    )) {
      metadata[inputKey] = inputMetadata;
    }
  }

  return metadata;
}

