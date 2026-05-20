import { create } from "zustand";
import { TICKS_PER_SECOND } from "../timeline";
import { getTicksPerFrame, snapFrameCountToStep } from "../timelineSelection";
import type {
  EditorRangeMask,
  ResolvedEditorSource,
  MiniEditorEditSpec,
  MiniEditorOpenArgs,
} from "./types";

export type MiniEditorStatus = "preparing" | "ready" | "saving" | "error";

/** Minimum trim/range width so handles never collapse onto each other. */
const MIN_SPAN_TICKS = Math.round(TICKS_PER_SECOND / 10);

interface MiniEditorInternal {
  prepare: MiniEditorOpenArgs["prepare"] | null;
  onSave: MiniEditorOpenArgs["onSave"] | null;
  /** Crop frame quantization (null = unconstrained, free dragging). */
  ticksPerFrame: number | null;
  frameStep: number;
}

/**
 * Snaps a crop window so its length is a valid selection frame count
 * (`frameStep * n + 1` frames), keeping whichever endpoint the user is not
 * dragging fixed. Endpoints land on frame boundaries; the span is clamped to
 * the source so it never runs past the available frames.
 */
function snapCropToFrameStep(
  startTicks: number,
  endTicks: number,
  durationTicks: number,
  ticksPerFrame: number,
  frameStep: number,
  anchor: "start" | "end",
): { start: number; end: number } {
  const totalFrames = Math.max(1, Math.round(durationTicks / ticksPerFrame));
  const rawCount = Math.max(1, Math.round((endTicks - startTicks) / ticksPerFrame));
  const count = Math.min(
    totalFrames,
    snapFrameCountToStep(rawCount, frameStep, "nearest"),
  );

  if (anchor === "start") {
    let startFrame = Math.min(Math.max(0, Math.round(startTicks / ticksPerFrame)), totalFrames - 1);
    let endFrame = startFrame + count;
    if (endFrame > totalFrames) {
      endFrame = totalFrames;
      startFrame = Math.max(0, endFrame - count);
    }
    return { start: startFrame * ticksPerFrame, end: endFrame * ticksPerFrame };
  }

  let endFrame = Math.min(Math.max(1, Math.round(endTicks / ticksPerFrame)), totalFrames);
  let startFrame = endFrame - count;
  if (startFrame < 0) {
    startFrame = 0;
    endFrame = Math.min(totalFrames, count);
  }
  return { start: startFrame * ticksPerFrame, end: endFrame * ticksPerFrame };
}

export interface MiniEditorState {
  isOpen: boolean;
  title: string;
  status: MiniEditorStatus;
  error: string | null;

  source: ResolvedEditorSource | null;
  durationTicks: number;
  /** Source pixel dimensions, measured from the <video> element once loaded. */
  sourceWidth: number;
  sourceHeight: number;

  cropStartTicks: number;
  cropEndTicks: number;
  ranges: EditorRangeMask[];
  selectedRangeId: string | null;

  playheadTicks: number;
  isPlaying: boolean;

  _internal: MiniEditorInternal;

  open: (args: MiniEditorOpenArgs) => Promise<void>;
  close: () => void;
  setSourceDimensions: (width: number, height: number) => void;
  setCrop: (startTicks: number, endTicks: number) => void;
  addRangeAtPlayhead: () => void;
  updateRange: (id: string, startTicks: number, endTicks: number) => void;
  removeRange: (id: string) => void;
  toggleRange: (id: string) => void;
  selectRange: (id: string | null) => void;
  setPlayhead: (ticks: number) => void;
  setPlaying: (playing: boolean) => void;
  save: () => Promise<void>;
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function revokeSource(source: ResolvedEditorSource | null) {
  if (source) {
    URL.revokeObjectURL(source.videoUrl);
  }
}

const INITIAL: Omit<
  MiniEditorState,
  | "open"
  | "close"
  | "setSourceDimensions"
  | "setCrop"
  | "addRangeAtPlayhead"
  | "updateRange"
  | "removeRange"
  | "toggleRange"
  | "selectRange"
  | "setPlayhead"
  | "setPlaying"
  | "save"
> = {
  isOpen: false,
  title: "Edit video",
  status: "preparing",
  error: null,
  source: null,
  durationTicks: 0,
  sourceWidth: 0,
  sourceHeight: 0,
  cropStartTicks: 0,
  cropEndTicks: 0,
  ranges: [],
  selectedRangeId: null,
  playheadTicks: 0,
  isPlaying: false,
  _internal: { prepare: null, onSave: null, ticksPerFrame: null, frameStep: 1 },
};

export const useMiniEditorStore = create<MiniEditorState>((set, get) => ({
  ...INITIAL,

  open: async (args) => {
    revokeSource(get().source);
    set({
      ...INITIAL,
      isOpen: true,
      status: "preparing",
      title: args.title ?? "Edit video",
      ranges: args.initial?.ranges ?? [],
      _internal: {
        prepare: args.prepare,
        onSave: args.onSave,
        ticksPerFrame:
          args.frameConstraint && args.frameConstraint.fps > 0
            ? getTicksPerFrame(args.frameConstraint.fps)
            : null,
        frameStep: Math.max(1, Math.round(args.frameConstraint?.frameStep ?? 1)),
      },
    });

    try {
      const source = await args.prepare();
      // A later open()/close() may have superseded this preparation.
      if (get()._internal.prepare !== args.prepare) {
        revokeSource(source);
        return;
      }
      const duration = source.durationTicks;
      const cropStart = clamp(
        args.initial?.cropStartTicks ?? 0,
        0,
        Math.max(0, duration - MIN_SPAN_TICKS),
      );
      const cropEnd = clamp(
        args.initial?.cropEndTicks ?? duration,
        cropStart + MIN_SPAN_TICKS,
        duration,
      );
      set({
        status: "ready",
        source,
        durationTicks: duration,
        cropStartTicks: cropStart,
        cropEndTicks: cropEnd,
        playheadTicks: cropStart,
      });
    } catch (error) {
      if (get()._internal.prepare !== args.prepare) return;
      set({
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Failed to prepare the video for editing",
      });
    }
  },

  close: () => {
    revokeSource(get().source);
    set({ ...INITIAL });
  },

  setSourceDimensions: (width, height) => {
    if (width > 0 && height > 0) {
      set({ sourceWidth: width, sourceHeight: height });
    }
  },

  setCrop: (startTicks, endTicks) => {
    const state = get();
    const { durationTicks } = state;
    const { ticksPerFrame, frameStep } = state._internal;

    let start = clamp(startTicks, 0, Math.max(0, durationTicks - MIN_SPAN_TICKS));
    let end = clamp(endTicks, start + MIN_SPAN_TICKS, durationTicks);

    if (ticksPerFrame && ticksPerFrame > 0) {
      // Anchor the endpoint the user is not dragging, then quantize the span.
      const startMoved = startTicks !== state.cropStartTicks;
      const endMoved = endTicks !== state.cropEndTicks;
      const anchor: "start" | "end" =
        endMoved && !startMoved ? "start" : "end";
      const snapped = snapCropToFrameStep(
        start,
        end,
        durationTicks,
        ticksPerFrame,
        frameStep,
        anchor,
      );
      start = snapped.start;
      end = snapped.end;
    }

    set({
      cropStartTicks: start,
      cropEndTicks: end,
      playheadTicks: clamp(get().playheadTicks, start, end),
    });
  },

  addRangeAtPlayhead: () => {
    const { playheadTicks, cropStartTicks, cropEndTicks, durationTicks } = get();
    const anchor = clamp(playheadTicks, 0, durationTicks);
    const defaultLen = Math.min(TICKS_PER_SECOND, durationTicks);
    let start = clamp(anchor, 0, Math.max(0, durationTicks - defaultLen));
    let end = clamp(start + defaultLen, start + MIN_SPAN_TICKS, durationTicks);
    // Bias the seed toward the visible crop window when possible.
    if (cropEndTicks > cropStartTicks) {
      start = clamp(start, cropStartTicks, Math.max(cropStartTicks, cropEndTicks - MIN_SPAN_TICKS));
      end = clamp(end, start + MIN_SPAN_TICKS, cropEndTicks);
    }
    const range: EditorRangeMask = {
      id: `range_${crypto.randomUUID()}`,
      startSourceTicks: start,
      endSourceTicks: end,
      isActive: true,
    };
    set((state) => ({
      ranges: [...state.ranges, range],
      selectedRangeId: range.id,
    }));
  },

  updateRange: (id, startTicks, endTicks) => {
    const { durationTicks } = get();
    const start = clamp(startTicks, 0, Math.max(0, durationTicks - MIN_SPAN_TICKS));
    const end = clamp(endTicks, start + MIN_SPAN_TICKS, durationTicks);
    set((state) => ({
      ranges: state.ranges.map((range) =>
        range.id === id
          ? { ...range, startSourceTicks: start, endSourceTicks: end }
          : range,
      ),
    }));
  },

  removeRange: (id) =>
    set((state) => ({
      ranges: state.ranges.filter((range) => range.id !== id),
      selectedRangeId:
        state.selectedRangeId === id ? null : state.selectedRangeId,
    })),

  toggleRange: (id) =>
    set((state) => ({
      ranges: state.ranges.map((range) =>
        range.id === id ? { ...range, isActive: !range.isActive } : range,
      ),
    })),

  selectRange: (id) => set({ selectedRangeId: id }),

  setPlayhead: (ticks) =>
    set({ playheadTicks: clamp(ticks, 0, get().durationTicks) }),

  setPlaying: (playing) => set({ isPlaying: playing }),

  save: async () => {
    const state = get();
    const { source } = state;
    const onSave = state._internal.onSave;
    if (!source || !onSave || state.status === "saving") return;

    set({ status: "saving", error: null, isPlaying: false });
    const spec: MiniEditorEditSpec = {
      cropStartTicks: state.cropStartTicks,
      cropEndTicks: state.cropEndTicks,
      ranges: state.ranges,
    };
    try {
      await onSave(spec, source);
      // onSave succeeded; tear down (revokes the source URL).
      get().close();
    } catch (error) {
      set({
        status: "error",
        error:
          error instanceof Error ? error.message : "Failed to save the edit",
      });
    }
  },
}));
