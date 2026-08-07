/**
 * Modal asset viewer and single-source editor. The opener injects source
 * preparation and the operations available for that source, keeping the
 * feature independent from the asset library and generation workflows.
 */

/** A masked time window, expressed in source-video ticks. Mirrors RangeMaskComponentParameters. */
export interface EditorRangeMask {
  id: string;
  startSourceTicks: number;
  endSourceTicks: number;
  isActive: boolean;
}

export type MiniEditorMediaType = "video" | "audio" | "image" | "lut";

/** The source media resolved by the opener (asset src, or a rendered selection mp4). */
export interface ResolvedEditorSource {
  /** Object URL owned by the editor and revoked when it closes. */
  sourceUrl: string;
  /** The underlying file extraction or baking reads from. */
  sourceFile: File;
  /** Full source duration in timeline ticks. Zero for still assets. */
  durationTicks: number;
  /** Defaults to video for backwards-compatible generation callers. */
  mediaType?: MiniEditorMediaType;
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
  /** Stable identity used to coordinate replacement and live opener updates. */
  openerId?: string;
  /** Start video playback on load when the browser permits it. */
  autoPlay?: boolean;
  title?: string;
  /** Resolve the source media. May be slow (e.g. rendering a selection). */
  prepare: () => Promise<ResolvedEditorSource>;
  /** Bake + persist an edit. Omit when the editor is being used as a viewer. */
  onSave?: (
    spec: MiniEditorEditSpec,
    source: ResolvedEditorSource,
  ) => Promise<void>;
  /** Extract the selected temporal range without closing the viewer. */
  onExtractRange?: (
    spec: MiniEditorEditSpec,
    source: ResolvedEditorSource,
  ) => Promise<string | void>;
  /** Extract the frame under the playhead without closing the viewer. */
  onExtractFrame?: (
    playheadTicks: number,
    source: ResolvedEditorSource,
  ) => Promise<string | void>;
  /** Called after the editor has released its source and closed. */
  onClose?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  hasPrevious?: boolean;
  hasNext?: boolean;
  initial?: MiniEditorInitialState;
  /** Optional frame-step quantization for the crop. */
  frameConstraint?: MiniEditorFrameConstraint;
}
