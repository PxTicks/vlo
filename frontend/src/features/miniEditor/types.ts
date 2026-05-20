/**
 * Modal video editor (single track, single clip): temporal trim ("crop") plus
 * one or more range masks. The feature is intentionally generation-agnostic —
 * the opener injects how to resolve the editable source video (`prepare`) and
 * what to do with the edit on save (`onSave`). This keeps the dependency edge
 * pointing generation -> miniEditor (never the reverse).
 */

/** A masked time window, expressed in source-video ticks. Mirrors RangeMaskComponentParameters. */
export interface EditorRangeMask {
  id: string;
  startSourceTicks: number;
  endSourceTicks: number;
  isActive: boolean;
}

/** The editable source video resolved by the opener (asset src, or a rendered selection mp4). */
export interface ResolvedEditorSource {
  /** Object URL used by the preview <video> element. */
  videoUrl: string;
  /** The underlying file the bake renders from. */
  videoFile: File;
  /** Full source duration in timeline ticks. */
  durationTicks: number;
}

/** The user's edit, handed back to the opener to bake. Times are source-video ticks. */
export interface MiniEditorEditSpec {
  cropStartTicks: number;
  cropEndTicks: number;
  ranges: EditorRangeMask[];
}

export interface MiniEditorInitialState {
  cropStartTicks?: number;
  cropEndTicks?: number;
  ranges?: EditorRangeMask[];
}

/**
 * Frame-quantization constraint inherited from the workflow's timeline-selection
 * rules. When provided, the crop snaps so its length is always a valid frame
 * count (`frameStep * n + 1` frames at `fps`), matching what the generation
 * pipeline requires of the rendered selection.
 */
export interface MiniEditorFrameConstraint {
  fps: number;
  frameStep: number;
}

export interface MiniEditorOpenArgs {
  title?: string;
  /** Resolve the editable source video. May be slow (e.g. rendering a selection). */
  prepare: () => Promise<ResolvedEditorSource>;
  /** Bake + persist the edit. Resolves when the result has been applied. */
  onSave: (
    spec: MiniEditorEditSpec,
    source: ResolvedEditorSource,
  ) => Promise<void>;
  initial?: MiniEditorInitialState;
  /** Optional frame-step quantization for the crop. */
  frameConstraint?: MiniEditorFrameConstraint;
}
