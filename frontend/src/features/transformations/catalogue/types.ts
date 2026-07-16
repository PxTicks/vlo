import type { ClipTransform } from "../../../types/TimelineTypes";
import type { Filter } from "pixi.js";

export type FilterParameterScaleMode =
  | "worldX"
  | "worldY"
  | "worldUniform";

export type FilterParameterPointSpace = "inputLocal" | "screenGlobal";

export interface FilterParameterPointBinding {
  x: string;
  y: string;
  space: FilterParameterPointSpace;
}

export interface FilterOperation {
  type: string;
  params: Record<string, unknown>;
  /** The authored transform that emitted this resolved operation. */
  sourceTransformId?: string;
}

export interface TransformState {
  scaleX: number;
  scaleY: number;
  x: number;
  y: number;
  rotation: number;
  /* Visual Effects State (Data-Driven) */
  filters: FilterOperation[];
  /** PixiJS blend mode applied to the rendered target. Defaults to "normal"
   *  when no blend-mode transform is present. Advanced modes (overlay,
   *  color-burn, ...) require the advanced-blend-modes extension + back buffer
   *  (see core/pixi/advancedBlendModes). */
  blendMode?: string;
  /** Feather compositing state */
  feather?: {
    mode: "hard_outer" | "soft_inner" | "two_way";
    amount: number;
    invert: boolean;
  } | null;
  /** Binary mask growth state */
  maskGrow?: {
    amount: number;
    invert: boolean;
  } | null;
}

export interface Size {
  width: number;
  height: number;
}

export interface ClipRenderPoint {
  x: number;
  y: number;
  set: (x: number, y: number) => void;
}

export interface ClipTransformTarget {
  position: ClipRenderPoint;
  scale: ClipRenderPoint;
  rotation: number;
  anchor?: {
    set: (x: number, y?: number) => void;
  };
  readonly filters?: readonly Filter[] | null;
  /** PixiJS blend mode. Present on Sprite / Container targets. */
  blendMode?: string;
}

export interface TransformContext {
  container: Size;
  content: Size;
  time?: number;
  visualTime?: number;
  visualDuration?: number;
}

/**
 * Host-owned time-dependency policy for a filter transformation. Native filter
 * definitions use this directly; extension metadata is projected into the
 * same policy by its adapter.
 */
export type FilterTimeDependency = "none" | "sample" | "history";

export interface TransformationRenderingPolicy {
  readonly timeDependency: FilterTimeDependency;
  /** Bounded, finite seconds of history a `history` filter may replay. */
  readonly maxHistorySeconds: number;
  /** Largest continuous step accepted without replay, or null when unbounded. */
  readonly maxStepSeconds: number | null;
}

/** Author-facing input normalized into `TransformationRenderingPolicy`. */
export interface TransformationRenderingPolicyInput {
  readonly timeDependency: FilterTimeDependency;
  readonly maxHistorySeconds?: number;
  readonly maxStepSeconds?: number;
}

export type FilterRenderMode = "preview" | "export" | "still";

export type FilterRenderContinuity =
  | "initial"
  | "sequential"
  | "repeat"
  | "discontinuous";

/**
 * Host-side render-sample identity and timing carried through every filter
 * runtime. The extension SDK mirrors this native contract; it is never
 * persisted.
 */
export interface FilterRenderContext {
  readonly sequenceId: number;
  readonly sampleId: number;
  readonly mode: FilterRenderMode;
  readonly continuity: FilterRenderContinuity;
  readonly presentationTimeTicks: number;
  readonly visualTimeTicks: number;
  readonly sourceTimeTicks: number;
  readonly deltaTimeTicks: number | null;
  readonly fps: number;
  readonly isWarmup: boolean;
}

export type TransformHandler<T extends ClipTransform = ClipTransform> = (
  state: TransformState,
  transform: T,
  context: TransformContext,
) => void;

export type TransformTemplate<P = TransformState> = (
  context: TransformContext,
) => Partial<P>;

export type StateApplicator = (
  target: ClipTransformTarget,
  state: TransformState,
  /**
   * Optional content size override. Sprite targets normally have a `.texture`
   * the filter applicator can read for spatial-parameter scaling; textureless
   * targets (Pixi Containers used by render groups) carry no texture and need
   * an explicit size or `worldX`/`worldY`/`worldUniform` params and
   * `filterParameterPoints` would scale against a 1×1 fallback.
   *
   * `applyClipTransforms` passes the clip texture size here; group callers
   * pass the logical project size. Applicators that don't care about content
   * size (e.g. `layoutApplicator`) ignore this parameter.
   */
  contentSize?: { width: number; height: number },
  /**
   * Optional render-sample context forwarded to time-dependent filters. Only
   * the filter applicator consumes it; omitting it synthesizes a stateless
   * `none`/`initial` sample so existing callers stay behavior-compatible.
   */
  render?: FilterRenderContext,
) => void;

// Import UI types
import type { TransformationLayoutConfig } from "./ui/UITypes";

// Convenience constructor for ordinary host-owned PixiJS filters.
export type TransformationFilterConstructor = new () => Filter;

export interface TransformationFilterUpdateContext {
  readonly target: ClipTransformTarget;
  readonly transformId: string;
  readonly contentSize?: Readonly<{ width: number; height: number }>;
  readonly render: FilterRenderContext;
}

/**
 * Native filter-runtime contract used by every filter implementation. Basic
 * `FilterClass` definitions are adapted automatically; advanced native filters
 * can provide a runtime directly, and trusted extensions are adapted onto the
 * same contract at their boundary.
 */
export interface TransformationFilterRuntime {
  create(transformId: string): Filter | null;
  /** True when `filter` is this factory's instance for exactly `transformId`. */
  matches(filter: Filter, transformId: string): boolean;
  /** True when `filter` is owned by this runtime, regardless of transform. */
  owns(filter: Filter): boolean;
  update(
    filter: Filter,
    parameters: Readonly<Record<string, unknown>>,
    context: TransformationFilterUpdateContext,
    outputFilters: Filter[],
  ): boolean;
  release(filter: Filter): void;
  dispose(): void;
}

/**
 * A complete, self-contained transformation definition.
 * Each transformation module exports one of these containing all its metadata,
 * runtime handler, and UI configuration.
 */
export interface TransformationDefinition {
  /** The transformation type key (e.g., "position", "scale", "filter") */
  type: string;

  /** Human-readable label for UI display */
  label: string;

  /** Optional clip compatibility filter. If not specified, compatible with all clip types. */
  compatibleClips?: string;

  /** Whether this is a default transformation that always appears (cannot be added/removed). Defaults to false. */
  isDefault?: boolean;

  /** Whether to hide this transformation from the add menu. Defaults to false. */
  hidden?: boolean;

  /**
   * Whether this transformation applies sensibly to adjustment clips (which
   * dispatch to a textureless Pixi Container instead of a sprite).
   * Defaults to `false`. Opt in explicitly per definition — `compatibleClips`
   * is not enough on its own because adjustment-incompatible entries
   * (speed, volume, mask, fitMode) span multiple `compatibleClips` values.
   *
   * Set true for: the layout definition (position/scale/rotation) and
   * every filter that scales sensibly against an explicit content size.
   */
  adjustmentCompatible?: boolean;

  /**
   * List of specific transform types handled by this definition.
   * Used when a single definition (like Layout) handles multiple clip transform types (position, scale, etc).
   */
  handledTypes?: readonly string[];

  /**
   * Runtime handler that mutates TransformState.
   * Type-erased to allow any specific handler to be assigned.
   * Runtime dispatch ensures correct typing.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: TransformHandler<any>;

  /** UI configuration defining the controls to render */
  uiConfig: TransformationLayoutConfig;

  /** Defaults beyond or overriding those declared by native controls. */
  defaultParameters?: Readonly<Record<string, unknown>>;

  /**
   * Fill parameters absent from older persisted instances with current control
   * defaults before validation and dispatch. Opt in explicitly: some native
   * definitions historically assigned semantics to a missing value that differ
   * from their current authoring default.
   */
  hydrateMissingParameters?: boolean;

  // --- Filter-specific properties (optional) ---

  /** For filter types: the unique filter identifier */
  filterName?: string;

  /**
   * For ordinary native filter types: a PixiJS Filter constructor. The host
   * automatically supplies transform-keyed reuse, parameter updates, render
   * context, and destruction through its native filter runtime.
   */
  FilterClass?: TransformationFilterConstructor;

  /**
   * Advanced native runtime for filters that need render context, custom
   * updates, or child-resource lifecycle. Extension adapters target this same
   * host contract; the capability itself is not extension-specific.
   */
  filterRuntime?: TransformationFilterRuntime;

  /**
   * Normalized native time-dependency policy for this transformation. Omission
   * means stateless (`none`). Extension declarations are validated and
   * projected into this host-owned policy.
   */
  rendering?: TransformationRenderingPolicy;

  /**
   * Optional per-parameter scale metadata for spatial filters whose authored
   * values should track the rendered object size across playback/export paths.
   */
  filterParameterScale?: Readonly<Record<string, FilterParameterScaleMode>>;

  /**
   * Optional point bindings for filters that interpret an `(x, y)` pair as a
   * single authored point inside the clip rather than as independent scalars.
   */
  filterParameterPoints?: readonly FilterParameterPointBinding[];

  /**
   * Optional filter padding resolver for effects whose visible bounds expand as
   * parameters increase.
   */
  filterPadding?: (params: Readonly<Record<string, unknown>>) => number;

  /** Host metadata for a dynamically registered extension contribution. */
  extension?: Readonly<{
    ownerId: string;
    contributionId: string;
    validateParameters: (
      parameters: Readonly<Record<string, unknown>>,
    ) => boolean;
    reportFailureOnce: (
      key: string,
      level: "error" | "warning",
      message: string,
      detail?: unknown,
    ) => void;
  }>;
}
