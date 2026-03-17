import { useProjectStore } from "../../project";
import {
  TICKS_PER_SECOND,
  getTimelineDuration,
  useTimelineStore,
} from "../../timeline";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import { useTimelineSelectionStore } from "../useTimelineSelectionStore";
import {
  getClipsInSelection,
  getTicksPerFrame,
  resolveSelectionFps,
  resolveSelectionFrameStep,
  snapFrameCountToStep,
} from "./timelineSelection";

export function createTimelineSelection(
  startTick: number,
  endTick: number,
): TimelineSelection {
  const clips = useTimelineStore.getState().clips;
  const projectFps = Math.max(1, useProjectStore.getState().config.fps);
  const { selectionFpsOverride, selectionFrameStep } =
    useTimelineSelectionStore.getState();
  const selectionFps = resolveSelectionFps(
    { fps: selectionFpsOverride },
    projectFps,
  );

  return {
    start: startTick,
    end: endTick,
    clips: getClipsInSelection(clips, {
      start: startTick,
      end: endTick,
      clips: [],
    }),
    fps: selectionFps,
    frameStep: selectionFrameStep,
  };
}

export function getDefaultSelectionEnd(startTick: number): number {
  const fps = useProjectStore.getState().config.fps;
  const { selectionFpsOverride, selectionFrameStep } =
    useTimelineSelectionStore.getState();
  const effectiveFps = resolveSelectionFps(
    { fps: selectionFpsOverride },
    fps,
  );
  const frameStep = resolveSelectionFrameStep({
    frameStep: selectionFrameStep,
  });
  const ticksPerFrame = getTicksPerFrame(effectiveFps);
  const maxDuration = getTimelineDuration();
  const oneSecondLater = startTick + TICKS_PER_SECOND;
  const requestedEndTick = Math.min(oneSecondLater, maxDuration);
  const rawFrameCount = Math.max(
    1,
    Math.ceil((requestedEndTick - startTick) / ticksPerFrame),
  );
  const safeFrameCount = snapFrameCountToStep(rawFrameCount, frameStep, "floor");
  return startTick + safeFrameCount * ticksPerFrame;
}
