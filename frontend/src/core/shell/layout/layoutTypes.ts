/**
 * Vocabulary for the configurable dock layout
 * (docs/configurable-docking-and-dedicated-workspaces-plan.md §3.1, §4.1–§4.3).
 *
 * This module is deliberately data-only: it declares the places a panel can
 * live, the constraints each place imposes, the shape a panel advertises to the
 * layout kernel, the persisted document, and the resolved output. Nothing here
 * reads storage, touches React, or knows about the view registry, so the
 * resolver and the migrations can be exercised without rendering anything.
 */

/**
 * Places that hold tools and supporting information. Deliberately a closed set:
 * the first release is a constrained dock, not an arbitrary window manager.
 *
 * This is a subset of the shell's view regions. `projects-page.main` is a
 * full-page surface rather than a dock, so it stays outside the docking model.
 */
export const DOCK_REGIONS = [
  "left-sidebar",
  "right-sidebar",
  "player-aside",
  "bottom-dock",
] as const;

export type DockRegion = (typeof DOCK_REGIONS)[number];

/** Human-readable region names for move menus, separators, and announcements. */
export const DOCK_REGION_LABELS: Readonly<Record<DockRegion, string>> =
  Object.freeze({
    "left-sidebar": "Left sidebar",
    "right-sidebar": "Right sidebar",
    "player-aside": "Player aside",
    "bottom-dock": "Bottom dock",
  });

/**
 * Places that hold the editor's primary working surfaces. `main-stage` holds
 * the picture and `lower-stage` holds the timeline; a dedicated workspace
 * composes the editor by choosing a different surface for one or both.
 */
export const EDITOR_STAGES = ["main-stage", "lower-stage"] as const;

export type EditorStage = (typeof EDITOR_STAGES)[number];

export const EDITOR_STAGE_LABELS: Readonly<Record<EditorStage, string>> =
  Object.freeze({
    "main-stage": "Main stage",
    "lower-stage": "Lower stage",
  });

export function isEditorStage(value: unknown): value is EditorStage {
  return EDITOR_STAGES.includes(value as EditorStage);
}

/** Regions whose outer boundary can be resized by the shell. */
export type ResizableShellRegion = DockRegion | "lower-stage";

export type ResponsiveSidebarRegion = "left-sidebar" | "right-sidebar";

export const RESPONSIVE_SIDEBAR_BREAKPOINT_PX = 900;
export const COLLAPSED_REGION_SIZE_PX = 32;

export function isDockRegion(value: unknown): value is DockRegion {
  return DOCK_REGIONS.includes(value as DockRegion);
}

/** Which viewport dimension a region's `sizePx` measures. */
export type DockRegionAxis = "width" | "height";

export interface DockRegionConstraints {
  readonly axis: DockRegionAxis;
  readonly defaultSizePx: number;
  readonly minimumSizePx: number;
  readonly maximumSizePx: number;
  /**
   * Whether an unselected region falls back to its first available view.
   * Sidebars always show something, so they do; the bottom dock must not, or it
   * would open itself the moment anything registered into it.
   */
  readonly autoSelect: boolean;
  readonly collapsible: boolean;
  /**
   * Largest share of the viewport the region may occupy. Applied to the
   * *effective* size only, so a narrow window never overwrites the desktop
   * preference (plan §5.1).
   */
  readonly maximumViewportFraction: number;
}

/**
 * The lower stage is structural rather than a dock, but its boundary follows
 * the same sizing rules. Surface selection remains a Phase D concern.
 */
export const LOWER_STAGE_CONSTRAINTS: DockRegionConstraints = Object.freeze({
  axis: "height",
  defaultSizePx: 280,
  minimumSizePx: 160,
  maximumSizePx: 720,
  autoSelect: false,
  collapsible: true,
  maximumViewportFraction: 0.65,
});

/**
 * Defaults match the geometry EditorLayout, PlayerAsidePanel, and
 * EditorBottomDock hard-code today, so adopting the kernel is visually neutral.
 */
export const DOCK_REGION_CONSTRAINTS: Readonly<
  Record<DockRegion, DockRegionConstraints>
> = Object.freeze({
  "left-sidebar": Object.freeze({
    axis: "width",
    defaultSizePx: 356,
    minimumSizePx: 220,
    maximumSizePx: 640,
    autoSelect: true,
    collapsible: true,
    maximumViewportFraction: 0.4,
  }),
  "right-sidebar": Object.freeze({
    axis: "width",
    defaultSizePx: 340,
    minimumSizePx: 300,
    maximumSizePx: 640,
    autoSelect: true,
    collapsible: true,
    maximumViewportFraction: 0.4,
  }),
  "player-aside": Object.freeze({
    axis: "width",
    defaultSizePx: 280,
    minimumSizePx: 180,
    maximumSizePx: 520,
    autoSelect: true,
    collapsible: true,
    maximumViewportFraction: 0.3,
  }),
  "bottom-dock": Object.freeze({
    axis: "height",
    defaultSizePx: 240,
    minimumSizePx: 120,
    maximumSizePx: 720,
    autoSelect: false,
    collapsible: true,
    // Retains the dock's previous 60% viewport cap.
    maximumViewportFraction: 0.6,
  }),
} satisfies Record<DockRegion, DockRegionConstraints>);

/**
 * A panel's effective visibility: the user's recorded intent when they have
 * one, the registration's default otherwise. Every reader goes through this so
 * "absent means visible" cannot drift from "absent means the default".
 */
export function isPanelVisible(
  descriptor: Pick<ShellPanelDescriptor, "defaultVisible"> | undefined,
  placement: Pick<PersistedPanelPlacement, "visible"> | undefined,
): boolean {
  return placement?.visible ?? descriptor?.defaultVisible ?? true;
}

export interface ShellViewport {
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * What a registered panel tells the layout kernel about itself. Owner-neutral:
 * host views and extension views produce the same shape, and `available`
 * carries the already-evaluated `when` condition so the resolver stays pure.
 */
export interface ShellPanelDescriptor {
  readonly id: string;
  readonly defaultRegion: DockRegion;
  /**
   * Regions the panel may be moved to. Until Phase C teaches registration
   * about portability this is just `[defaultRegion]`, which is why a persisted
   * placement outside this list falls back rather than throwing.
   */
  readonly allowedRegions: readonly DockRegion[];
  /** Registration-time ordering hint, used when the user has no preference. */
  readonly defaultOrder: number;
  /** Result of evaluating the panel's declarative availability condition. */
  readonly available: boolean;
  /**
   * Whether the panel is shown before the user has an opinion. Absent means
   * visible, which is what every panel that does not opt out gets. A panel
   * registered with `false` starts off the tab strip and is turned on from
   * "Manage panels"; the user's choice is then an explicit placement and
   * outlives the default.
   */
  readonly defaultVisible?: boolean;
  readonly source: "host" | "extension";
  readonly preferredSizePx?: number;
  readonly minimumSizePx?: number;
  readonly maximumSizePx?: number;
}

/**
 * What a registered editor surface tells the layout kernel about itself. Same
 * owner-neutral shape as a panel descriptor, with `available` carrying the
 * already-evaluated `when` condition so the resolver stays pure.
 */
export interface ShellSurfaceDescriptor {
  readonly id: string;
  readonly defaultStage: EditorStage;
  /** Stages a workspace may mount this surface in; always includes the default. */
  readonly allowedStages: readonly EditorStage[];
  /** Registration-time tie-breaker among a stage's default surfaces. */
  readonly defaultOrder: number;
  readonly available: boolean;
}

/**
 * One stage's resolved state. A stage shows exactly one surface, so unlike a
 * dock region there is no ordering or tab set — only which surface is mounted
 * and which ones could be.
 */
export interface ResolvedEditorStage {
  readonly id: EditorStage;
  /** The surface the shell mounts. Null when the stage has nothing to show. */
  readonly surfaceId: string | null;
  /** Available surfaces permitting this stage, in default order. */
  readonly candidateSurfaceIds: readonly string[];
}

/**
 * One region's resolved state. Placement, visibility, selection, collapse, and
 * size are separate concerns (plan §4.2): collapse and size belong to the
 * region, not to whichever view happens to be selected.
 */
export interface ResolvedDockRegion {
  readonly id: DockRegion;
  /** Visible and available panels, in user order. Drives the tab strip. */
  readonly orderedViewIds: readonly string[];
  /**
   * Every panel placed here, including user-hidden and currently unavailable
   * ones, in the same order. Drives the manage-panels control.
   */
  readonly placedViewIds: readonly string[];
  readonly selectedViewId: string | null;
  /** Persisted collapse intent before responsive adaptation. */
  readonly userCollapsed: boolean;
  /** Effective collapse state rendered by the shell. */
  readonly collapsed: boolean;
  /** Effective size after viewport clamping. What the shell should render. */
  readonly sizePx: number;
  /** The user's preference before viewport clamping. What gets persisted. */
  readonly userSizePx: number;
  /** User-resize bounds; responsive output may render below the minimum. */
  readonly minimumSizePx: number;
  readonly maximumSizePx: number;
}

/** The lower stage's geometry. Which surface it shows lives in `stages`. */
export interface ResolvedLowerStage {
  readonly id: "lower-stage";
  readonly collapsed: boolean;
  /** Effective size after viewport clamping. What the shell should render. */
  readonly sizePx: number;
  /** The user's preference before viewport clamping. What gets persisted. */
  readonly userSizePx: number;
  readonly minimumSizePx: number;
  readonly maximumSizePx: number;
}

export interface ResolvedShellLayout {
  readonly regions: Readonly<Record<DockRegion, ResolvedDockRegion>>;
  readonly stages: Readonly<Record<EditorStage, ResolvedEditorStage>>;
  readonly lowerStage: ResolvedLowerStage;
  /** Effective region of every known panel, keyed by view ID. */
  readonly panelRegions: Readonly<Record<string, DockRegion>>;
}

/**
 * A session-only stage composition: which surface each stage should mount right
 * now. A dedicated workspace supplies one while it is active (plan §4.4 layer
 * 4). Deliberately not part of the persisted document — the editor always opens
 * on its registered defaults (plan §3.3, §5.2).
 */
export type EditorStageSurfaces = Readonly<
  Partial<Record<EditorStage, string>>
>;

/**
 * A panel's persisted intent.
 *
 * `region` is optional on purpose, despite the plan sketch typing it as
 * required: absent means "wherever the panel's registration says". Recording a
 * placement the user never chose would pin a panel to a region forever, and
 * would force the version 1 migration — which had no placement concept at all —
 * to invent one.
 */
export interface PersistedPanelPlacement {
  readonly region?: DockRegion;
  /** Absent means "use the panel's registered default visibility". */
  readonly visible?: boolean;
  /** Absent means "use the registration order". */
  readonly order?: number;
}

export interface PersistedRegionState {
  readonly selectedViewId?: string | null;
  readonly collapsed?: boolean;
  readonly sizePx?: number;
}

export type PersistedRegionGeometry = Pick<
  PersistedRegionState,
  "collapsed" | "sizePx"
>;

/** A dedicated workspace's saved layout override. Consumed from Phase E. */
export interface WorkspaceLayoutOverride {
  readonly panels: Readonly<Record<string, PersistedPanelPlacement>>;
  readonly regions: Readonly<Partial<Record<DockRegion, PersistedRegionState>>>;
  readonly lowerStage?: PersistedRegionGeometry;
}

export interface ShellLayoutDocumentV2 {
  readonly version: 2;
  readonly panels: Readonly<Record<string, PersistedPanelPlacement>>;
  readonly regions: Readonly<Partial<Record<DockRegion, PersistedRegionState>>>;
  /**
   * Geometry only. Which surface a stage shows is session state, not a saved
   * preference: the editor always opens on its registered defaults, and a
   * dedicated workspace's composition is transient by design (§3.3, §5.2).
   */
  readonly lowerStage?: PersistedRegionGeometry;
  readonly workspaceLayouts: Readonly<Record<string, WorkspaceLayoutOverride>>;
  /**
   * Marks the one-time fold-in of the version 1 hidden/order preferences.
   *
   * Phase A could rely on "a version 2 document exists" meaning "the user has
   * moved on", because only geometry lived here. Phase C moves panel visibility
   * and ordering into this document too, so a user who resized a sidebar before
   * this phase already has a version 2 document with an empty `panels` map and
   * would otherwise lose their version 1 preferences. Merging until this flag is
   * set folds them in exactly once, so a later unhide is not undone on reload.
   */
  readonly legacyPanelsMerged?: boolean;
}

export const EMPTY_SHELL_LAYOUT_DOCUMENT: ShellLayoutDocumentV2 = Object.freeze({
  version: 2,
  panels: Object.freeze({}),
  regions: Object.freeze({}),
  workspaceLayouts: Object.freeze({}),
  legacyPanelsMerged: true,
});
