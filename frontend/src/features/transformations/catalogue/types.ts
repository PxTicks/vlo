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

export interface TransformState {
  scaleX: number;
  scaleY: number;
  x: number;
  y: number;
  rotation: number;
  /* Visual Effects State (Data-Driven) */
  filters: Array<{
    type: string;
    params: Record<string, unknown>;
  }>;
  /** Feather compositing state */
  feather?: {
    mode: "hard_outer" | "soft_inner" | "two_way";
    amount: number;
  } | null;
  /** Binary mask growth state */
  maskGrow?: {
    amount: number;
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
}

export interface TransformContext {
  container: Size;
  content: Size;
  time?: number;
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
) => void;

// Import UI types
import type { TransformationLayoutConfig } from "./ui/UITypes";

// Type for PixiJS filter class constructor
type FilterConstructor = new () => Filter;

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

  // --- Filter-specific properties (optional) ---

  /** For filter types: the unique filter identifier */
  filterName?: string;

  /** For filter types: the PixiJS Filter class constructor */
  FilterClass?: FilterConstructor;

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
}
