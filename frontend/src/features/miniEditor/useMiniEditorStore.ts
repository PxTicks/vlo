import { create } from "zustand";
import { mediaSecondsToTick, TICKS_PER_SECOND } from "../../core/time";
import { getTicksPerFrame, snapSteppedRangeEdge } from "../timelineSelection";
import type {
  EditorRangeMask,
  ResolvedEditorSource,
  MiniEditorEditSpec,
  MiniEditorOpenArgs,
  MiniEditorPresentation,
} from "./types";

export type MiniEditorStatus =
  | "preparing"
  | "ready"
  | "saving"
  | "extracting-range"
  | "extracting-frame"
  | "error";

export type MiniEditorExtractionMode = "range" | "frame" | null;

function isWorkingStatus(status: MiniEditorStatus): boolean {
  return (
    status === "saving" ||
    status === "extracting-range" ||
    status === "extracting-frame"
  );
}

/** Minimum trim/range width so handles never collapse onto each other. */
const MIN_SPAN_TICKS = mediaSecondsToTick(0.1);

interface MiniEditorInternal {
  openerId: string | null;
  autoPlay: boolean;
  prepare: MiniEditorOpenArgs["prepare"] | null;
  onSave: MiniEditorOpenArgs["onSave"] | null;
  onExtractRange: MiniEditorOpenArgs["onExtractRange"] | null;
  onExtractFrame: MiniEditorOpenArgs["onExtractFrame"] | null;
  onClose: MiniEditorOpenArgs["onClose"] | null;
  onPrevious: MiniEditorOpenArgs["onPrevious"] | null;
  onNext: MiniEditorOpenArgs["onNext"] | null;
  hasPrevious: boolean;
  hasNext: boolean;
  /** Crop frame quantization (null = unconstrained, free dragging). */
  ticksPerFrame: number | null;
  frameStep: number;
  extractionSnapshot: {
    cropStartTicks: number;
    cropEndTicks: number;
    playheadTicks: number;
  } | null;
}

export interface MiniEditorState {
  isOpen: boolean;
  presentation: MiniEditorPresentation;
  title: string;
  status: MiniEditorStatus;
  error: string | null;
  notice: string | null;

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
  extractionMode: MiniEditorExtractionMode;

  _internal: MiniEditorInternal;

  open: (args: MiniEditorOpenArgs) => Promise<void>;
  setNavigationState: (
    openerId: string,
    navigation: {
      onPrevious?: () => void;
      onNext?: () => void;
      hasPrevious: boolean;
      hasNext: boolean;
    },
  ) => void;
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
  beginRangeExtraction: () => void;
  beginFrameExtraction: () => void;
  cancelExtractionSelection: () => void;
  extractRange: () => Promise<void>;
  extractFrame: () => Promise<void>;
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function revokeSource(source: ResolvedEditorSource | null) {
  if (source) {
    URL.revokeObjectURL(source.sourceUrl);
  }
}

const INITIAL: Omit<
  MiniEditorState,
  | "open"
  | "close"
  | "setNavigationState"
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
  | "beginRangeExtraction"
  | "beginFrameExtraction"
  | "cancelExtractionSelection"
  | "extractRange"
  | "extractFrame"
> = {
  isOpen: false,
  presentation: "modal",
  title: "Edit video",
  status: "preparing",
  error: null,
  notice: null,
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
  extractionMode: null,
  _internal: {
    openerId: null,
    autoPlay: false,
    prepare: null,
    onSave: null,
    onExtractRange: null,
    onExtractFrame: null,
    onClose: null,
    onPrevious: null,
    onNext: null,
    hasPrevious: false,
    hasNext: false,
    ticksPerFrame: null,
    frameStep: 1,
    extractionSnapshot: null,
  },
};

export const useMiniEditorStore = create<MiniEditorState>((set, get) => ({
  ...INITIAL,

  open: async (args) => {
    const previous = get();
    const openerId = args.openerId ?? null;
    const displacedOnClose =
      previous.isOpen && previous._internal.openerId !== openerId
        ? previous._internal.onClose
        : null;
    revokeSource(previous.source);
    set({
      ...INITIAL,
      isOpen: true,
      presentation: args.presentation ?? "modal",
      status: "preparing",
      title: args.title ?? "Edit video",
      ranges: args.initial?.ranges ?? [],
      _internal: {
        openerId,
        autoPlay: args.autoPlay ?? false,
        prepare: args.prepare,
        onSave: args.onSave ?? null,
        onExtractRange: args.onExtractRange ?? null,
        onExtractFrame: args.onExtractFrame ?? null,
        onClose: args.onClose ?? null,
        onPrevious: args.onPrevious ?? null,
        onNext: args.onNext ?? null,
        hasPrevious: args.hasPrevious ?? false,
        hasNext: args.hasNext ?? false,
        ticksPerFrame:
          args.frameConstraint && args.frameConstraint.fps > 0
            ? getTicksPerFrame(args.frameConstraint.fps)
            : null,
        frameStep: Math.max(
          1,
          Math.round(args.frameConstraint?.frameStep ?? 1),
        ),
        extractionSnapshot: null,
      },
    });
    displacedOnClose?.();

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
      const cropEnd =
        duration > 0
          ? clamp(
              args.initial?.cropEndTicks ?? duration,
              cropStart + MIN_SPAN_TICKS,
              duration,
            )
          : 0;
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
    const onClose = get()._internal.onClose;
    revokeSource(get().source);
    set({ ...INITIAL });
    onClose?.();
  },

  setNavigationState: (openerId, navigation) => {
    const state = get();
    if (!state.isOpen || state._internal.openerId !== openerId) {
      return;
    }

    set({
      _internal: {
        ...state._internal,
        onPrevious: navigation.onPrevious ?? null,
        onNext: navigation.onNext ?? null,
        hasPrevious: navigation.hasPrevious,
        hasNext: navigation.hasNext,
      },
    });
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

    let start = clamp(
      startTicks,
      0,
      Math.max(0, durationTicks - MIN_SPAN_TICKS),
    );
    let end = clamp(endTicks, start + MIN_SPAN_TICKS, durationTicks);

    if (ticksPerFrame && ticksPerFrame > 0) {
      // Anchor the endpoint the user is not dragging, then quantize the span.
      const startMoved = startTicks !== state.cropStartTicks;
      const endMoved = endTicks !== state.cropEndTicks;
      if (endMoved && !startMoved) {
        end = snapSteppedRangeEdge({
          edge: "end",
          proposedTick: end,
          fixedTick: start,
          ticksPerFrame,
          frameStep,
          maxTick: durationTicks,
        });
      } else {
        start = snapSteppedRangeEdge({
          edge: "start",
          proposedTick: start,
          fixedTick: end,
          ticksPerFrame,
          frameStep,
          minTick: 0,
          maxTick: durationTicks,
        });
      }
    }

    set({
      cropStartTicks: start,
      cropEndTicks: end,
      playheadTicks: clamp(get().playheadTicks, start, end),
    });
  },

  addRangeAtPlayhead: () => {
    const { playheadTicks, cropStartTicks, cropEndTicks, durationTicks } =
      get();
    const anchor = clamp(playheadTicks, 0, durationTicks);
    const defaultLen = Math.min(TICKS_PER_SECOND, durationTicks);
    let start = clamp(anchor, 0, Math.max(0, durationTicks - defaultLen));
    let end = clamp(start + defaultLen, start + MIN_SPAN_TICKS, durationTicks);
    // Bias the seed toward the visible crop window when possible.
    if (cropEndTicks > cropStartTicks) {
      start = clamp(
        start,
        cropStartTicks,
        Math.max(cropStartTicks, cropEndTicks - MIN_SPAN_TICKS),
      );
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
    const start = clamp(
      startTicks,
      0,
      Math.max(0, durationTicks - MIN_SPAN_TICKS),
    );
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

  setPlayhead: (ticks) => {
    const state = get();
    const clamped = clamp(ticks, 0, state.durationTicks);
    const ticksPerFrame = state._internal.ticksPerFrame;
    set({
      playheadTicks: ticksPerFrame
        ? clamp(
            Math.round(clamped / ticksPerFrame) * ticksPerFrame,
            0,
            state.durationTicks,
          )
        : clamped,
    });
  },

  setPlaying: (playing) => set({ isPlaying: playing }),

  save: async () => {
    const state = get();
    const { source } = state;
    const onSave = state._internal.onSave;
    if (!source || !onSave || isWorkingStatus(state.status)) return;

    set({ status: "saving", error: null, notice: null, isPlaying: false });
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

  beginRangeExtraction: () => {
    const state = get();
    if (
      !state.source ||
      !state._internal.onExtractRange ||
      isWorkingStatus(state.status) ||
      state.extractionMode !== null
    ) {
      return;
    }

    set({
      extractionMode: "range",
      error: null,
      notice: null,
      isPlaying: false,
      _internal: {
        ...state._internal,
        extractionSnapshot: {
          cropStartTicks: state.cropStartTicks,
          cropEndTicks: state.cropEndTicks,
          playheadTicks: state.playheadTicks,
        },
      },
    });
  },

  beginFrameExtraction: () => {
    const state = get();
    if (
      !state.source ||
      !state._internal.onExtractFrame ||
      isWorkingStatus(state.status) ||
      state.extractionMode !== null
    ) {
      return;
    }

    set({
      extractionMode: "frame",
      error: null,
      notice: null,
      isPlaying: false,
      _internal: {
        ...state._internal,
        extractionSnapshot: {
          cropStartTicks: state.cropStartTicks,
          cropEndTicks: state.cropEndTicks,
          playheadTicks: state.playheadTicks,
        },
      },
    });
  },

  cancelExtractionSelection: () => {
    const state = get();
    if (state.extractionMode === null || isWorkingStatus(state.status)) {
      return;
    }

    const snapshot = state._internal.extractionSnapshot;
    set({
      extractionMode: null,
      ...(snapshot
        ? {
            cropStartTicks: snapshot.cropStartTicks,
            cropEndTicks: snapshot.cropEndTicks,
            playheadTicks: snapshot.playheadTicks,
          }
        : {}),
      error: null,
      _internal: {
        ...state._internal,
        extractionSnapshot: null,
      },
    });
  },

  extractRange: async () => {
    const state = get();
    const { source } = state;
    const onExtractRange = state._internal.onExtractRange;
    if (
      !source ||
      !onExtractRange ||
      isWorkingStatus(state.status) ||
      state.extractionMode !== "range"
    ) {
      return;
    }

    set({
      status: "extracting-range",
      error: null,
      notice: null,
      isPlaying: false,
    });
    try {
      const successNotice = await onExtractRange(
        {
          cropStartTicks: state.cropStartTicks,
          cropEndTicks: state.cropEndTicks,
          ranges: state.ranges,
        },
        source,
      );
      if (
        get().source === source &&
        get()._internal.onExtractRange === onExtractRange
      ) {
        set((current) => ({
          status: "ready",
          notice: successNotice ?? null,
          extractionMode: null,
          _internal: {
            ...current._internal,
            extractionSnapshot: null,
          },
        }));
      }
    } catch (error) {
      if (
        get().source !== source ||
        get()._internal.onExtractRange !== onExtractRange
      ) {
        return;
      }
      set({
        status: "error",
        error:
          error instanceof Error ? error.message : "Failed to extract range",
      });
    }
  },

  extractFrame: async () => {
    const state = get();
    const { source } = state;
    const onExtractFrame = state._internal.onExtractFrame;
    if (
      !source ||
      !onExtractFrame ||
      isWorkingStatus(state.status) ||
      state.extractionMode !== "frame"
    ) {
      return;
    }

    set({
      status: "extracting-frame",
      error: null,
      notice: null,
      isPlaying: false,
    });
    try {
      const successNotice = await onExtractFrame(state.playheadTicks, source);
      if (
        get().source === source &&
        get()._internal.onExtractFrame === onExtractFrame
      ) {
        set((current) => ({
          status: "ready",
          notice: successNotice ?? null,
          extractionMode: null,
          _internal: {
            ...current._internal,
            extractionSnapshot: null,
          },
        }));
      }
    } catch (error) {
      if (
        get().source !== source ||
        get()._internal.onExtractFrame !== onExtractFrame
      ) {
        return;
      }
      set({
        status: "error",
        error:
          error instanceof Error ? error.message : "Failed to extract frame",
      });
    }
  },
}));
