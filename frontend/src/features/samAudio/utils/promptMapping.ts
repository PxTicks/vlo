import type { TimelineClip } from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../timeline";
import { useTimelineSelectionStore } from "../../timelineSelection";
import { presentationToClipSourceTime } from "../../transformations";
import type { ClipPresentationContext } from "../../transformations";
import type { SamAudioPromptPayload } from "../services/samAudioApi";

export interface SamAudioSpanSelection {
  selectionMode: boolean;
  selectionStartTick: number;
  selectionEndTick: number;
}

export function createSpanAnchorsForClip(
  clip: TimelineClip,
  presentationContext: ClipPresentationContext,
  selection: SamAudioSpanSelection = useTimelineSelectionStore.getState(),
): Array<Array<["+", number, number]>> | undefined {
  if (!selection.selectionMode) {
    return undefined;
  }

  const rangeStart = Math.min(
    selection.selectionStartTick,
    selection.selectionEndTick,
  );
  const rangeEnd = Math.max(
    selection.selectionStartTick,
    selection.selectionEndTick,
  );
  const clipStart = clip.start;
  const clipEnd = clip.start + clip.timelineDuration;
  const overlapStart = Math.max(rangeStart, clipStart);
  const overlapEnd = Math.min(rangeEnd, clipEnd);
  if (overlapEnd <= overlapStart) {
    return undefined;
  }

  const sourceStart = presentationToClipSourceTime(
    presentationContext,
    clip,
    overlapStart,
  );
  const sourceEnd = presentationToClipSourceTime(
    presentationContext,
    clip,
    overlapEnd,
  );
  const windowStart = clip.offset;
  const windowDuration = Math.max(1, clip.croppedSourceDuration);
  const relativeStartTicks = Math.max(
    0,
    Math.min(windowDuration, sourceStart - windowStart),
  );
  const relativeEndTicks = Math.max(
    relativeStartTicks,
    Math.min(windowDuration, sourceEnd - windowStart),
  );
  if (relativeEndTicks <= relativeStartTicks) {
    return undefined;
  }

  return [
    [
      [
        "+",
        relativeStartTicks / TICKS_PER_SECOND,
        relativeEndTicks / TICKS_PER_SECOND,
      ],
    ],
  ];
}

export function createSamAudioPromptPayload(options: {
  text: string;
  anchors?: Array<Array<["+", number, number]>>;
  useSpanPrompt: boolean;
  visualPrompt?: { sam2SourceId: string; sam2MaskId: string } | null;
  useVisualPrompt: boolean;
  highQuality: boolean;
}): SamAudioPromptPayload {
  const prompt: SamAudioPromptPayload = {};
  const text = options.text.trim().toLowerCase();
  if (text) {
    prompt.text = text;
  }
  if (options.useSpanPrompt && options.anchors) {
    prompt.anchors = options.anchors;
  }
  if (options.useVisualPrompt && options.visualPrompt) {
    prompt.sam2SourceId = options.visualPrompt.sam2SourceId;
    prompt.sam2MaskId = options.visualPrompt.sam2MaskId;
  }
  if (options.highQuality) {
    prompt.predictSpans = true;
    prompt.rerankingCandidates = 8;
  } else {
    prompt.rerankingCandidates = 1;
  }
  return prompt;
}
