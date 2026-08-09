/**
 * The shell layout store: the single owner of layout intent (plan §3.5, §4.4).
 *
 * Every mutation is one transaction — the document and the resolved layout move
 * together in a single update, so no consumer can observe a half-applied move.
 * Resize is the only debounced write, because a drag would otherwise persist
 * dozens of intermediate states.
 */
import { create } from "zustand";
import {
  createLocalShellLayoutPersistence,
  type ShellLayoutPersistence,
} from "./layoutPersistence";
import { hostViewRegistry } from "../viewRegistry";
import {
  arePanelDescriptorsEqual,
  observeShellPanels,
} from "./layoutDescriptors";
import { resolveShellLayout } from "./layoutResolver";
import {
  DOCK_REGION_CONSTRAINTS,
  LOWER_STAGE_CONSTRAINTS,
  RESPONSIVE_SIDEBAR_BREAKPOINT_PX,
  type DockRegion,
  type DockRegionConstraints,
  type PersistedPanelPlacement,
  type PersistedRegionGeometry,
  type PersistedRegionState,
  type ResolvedShellLayout,
  type ResizableShellRegion,
  type ResponsiveSidebarRegion,
  type ShellLayoutDocumentV2,
  type ShellPanelDescriptor,
  type ShellViewport,
} from "./layoutTypes";

/** Long enough to swallow a drag, short enough to survive a quick reload. */
const DEFAULT_RESIZE_PERSIST_DELAY_MS = 250;

export interface ShellLayoutState {
  /** Persisted user intent. Never read directly by components. */
  readonly document: ShellLayoutDocumentV2;
  /** Live panel table, pushed in by the registry adapter. */
  readonly panels: readonly ShellPanelDescriptor[];
  readonly viewport: ShellViewport | null;
  readonly responsiveExpandedRegion: ResponsiveSidebarRegion | null;
  readonly resolved: ResolvedShellLayout;

  setPanelDescriptors(panels: readonly ShellPanelDescriptor[]): void;
  setViewport(viewport: ShellViewport | null): void;

  /**
   * Moves a panel to one of its allowed regions and reveals it there. Returns
   * false when the panel does not permit the target region.
   */
  movePanel(viewId: string, region: DockRegion): boolean;
  /** Moves a panel one slot within its region, hidden siblings included. */
  reorderPanel(viewId: string, delta: -1 | 1): boolean;
  setPanelVisible(viewId: string, visible: boolean): void;
  /** Returns false when the view is not selectable in that region right now. */
  selectView(region: DockRegion, viewId: string): boolean;
  /** Drops a region's selection. Auto-selecting regions fall back immediately. */
  closeRegion(region: DockRegion): void;
  setRegionCollapsed(region: ResizableShellRegion, collapsed: boolean): void;
  resizeRegion(region: ResizableShellRegion, sizePx: number): void;
  resetRegion(region: ResizableShellRegion): void;
  /** Resets only retained size, preserving placement, visibility, and selection. */
  resetRegionSize(region: ResizableShellRegion): void;
  resetLayout(): void;
  /** Writes any debounced resize immediately. */
  flushPersistence(): void;
}

export interface ShellLayoutStoreOptions {
  readonly persistence?: ShellLayoutPersistence;
  readonly constraints?: Readonly<Record<DockRegion, DockRegionConstraints>>;
  readonly resizePersistDelayMs?: number;
  readonly panels?: readonly ShellPanelDescriptor[];
  readonly viewport?: ShellViewport | null;
}

/** Mutable mirrors of the persisted shapes, for building the next document. */
interface DraftPlacement {
  region?: DockRegion;
  visible?: boolean;
  order?: number;
}

interface DraftRegionState {
  selectedViewId?: string | null;
  collapsed?: boolean;
  sizePx?: number;
}

function withPlacement(
  document: ShellLayoutDocumentV2,
  viewId: string,
  placement: PersistedPanelPlacement,
): ShellLayoutDocumentV2 {
  const panels = { ...document.panels };
  if (Object.keys(placement).length === 0) delete panels[viewId];
  else panels[viewId] = placement;
  return { ...document, panels };
}

function withRegionState(
  document: ShellLayoutDocumentV2,
  region: DockRegion,
  state: PersistedRegionState,
): ShellLayoutDocumentV2 {
  const regions = { ...document.regions };
  if (Object.keys(state).length === 0) delete regions[region];
  else regions[region] = state;
  return { ...document, regions };
}

function withLowerStageState(
  document: ShellLayoutDocumentV2,
  state: PersistedRegionGeometry,
): ShellLayoutDocumentV2 {
  if (Object.keys(state).length === 0) {
    const { lowerStage: _lowerStage, ...rest } = document;
    return rest;
  }
  return { ...document, lowerStage: state };
}

function isResponsiveSidebar(
  region: ResizableShellRegion,
): region is ResponsiveSidebarRegion {
  return region === "left-sidebar" || region === "right-sidebar";
}

function isNarrowViewport(viewport: ShellViewport | null): boolean {
  return (
    viewport !== null &&
    viewport.widthPx > 0 &&
    viewport.widthPx < RESPONSIVE_SIDEBAR_BREAKPOINT_PX
  );
}

export function createShellLayoutStore(options: ShellLayoutStoreOptions = {}) {
  const persistence =
    options.persistence ?? createLocalShellLayoutPersistence();
  const constraints = options.constraints ?? DOCK_REGION_CONSTRAINTS;
  const resizePersistDelayMs =
    options.resizePersistDelayMs ?? DEFAULT_RESIZE_PERSIST_DELAY_MS;

  return create<ShellLayoutState>()((set, get) => {
    let pendingWrite: ReturnType<typeof setTimeout> | null = null;

    const resolve = (
      document: ShellLayoutDocumentV2,
      panels: readonly ShellPanelDescriptor[],
      viewport: ShellViewport | null,
      responsiveExpandedRegion: ResponsiveSidebarRegion | null,
    ): ResolvedShellLayout =>
      resolveShellLayout({
        panels,
        document,
        viewport,
        constraints,
        responsiveExpandedRegion,
      });

    const cancelPendingWrite = (): void => {
      if (pendingWrite === null) return;
      clearTimeout(pendingWrite);
      pendingWrite = null;
    };

    const persistNow = (): void => {
      cancelPendingWrite();
      persistence.write(get().document);
    };

    const persistSoon = (): void => {
      if (pendingWrite !== null) return;
      pendingWrite = setTimeout(() => {
        pendingWrite = null;
        persistence.write(get().document);
      }, resizePersistDelayMs);
    };

    /**
     * The one place a document change becomes visible. Resolving inside the
     * same `set` keeps the transaction atomic: subscribers never see a new
     * document paired with a stale resolution.
     */
    const commit = (
      document: ShellLayoutDocumentV2,
      persist: "now" | "debounced",
      responsiveExpandedRegion = get().responsiveExpandedRegion,
    ): void => {
      const state = get();
      set({
        document,
        responsiveExpandedRegion,
        resolved: resolve(
          document,
          state.panels,
          state.viewport,
          responsiveExpandedRegion,
        ),
      });
      if (persist === "now") persistNow();
      else persistSoon();
    };

    const findDescriptor = (viewId: string): ShellPanelDescriptor | undefined =>
      get().panels.find((descriptor) => descriptor.id === viewId);

    const initialDocument = persistence.read();
    const initialPanels = options.panels ?? [];
    const initialViewport = options.viewport ?? null;

    return {
      document: initialDocument,
      panels: initialPanels,
      viewport: initialViewport,
      responsiveExpandedRegion: null,
      resolved: resolve(initialDocument, initialPanels, initialViewport, null),

      setPanelDescriptors: (panels) => {
        const state = get();
        if (arePanelDescriptorsEqual(state.panels, panels)) return;
        set({
          panels,
          resolved: resolve(
            state.document,
            panels,
            state.viewport,
            state.responsiveExpandedRegion,
          ),
        });
      },

      setViewport: (viewport) => {
        const state = get();
        if (
          state.viewport?.widthPx === viewport?.widthPx &&
          state.viewport?.heightPx === viewport?.heightPx
        ) {
          return;
        }
        const responsiveExpandedRegion = isNarrowViewport(viewport)
          ? state.responsiveExpandedRegion
          : null;
        set({
          viewport,
          responsiveExpandedRegion,
          resolved: resolve(
            state.document,
            state.panels,
            viewport,
            responsiveExpandedRegion,
          ),
        });
      },

      movePanel: (viewId, region) => {
        const descriptor = findDescriptor(viewId);
        if (!descriptor || !descriptor.allowedRegions.includes(region)) {
          return false;
        }
        const state = get();
        const from = state.resolved.panelRegions[viewId];
        if (from === region) return true;
        const placement: DraftPlacement = { ...state.document.panels[viewId] };
        // An ordering index only means something inside the region it was
        // recorded for, so a move drops it and the panel lands on its
        // registration order in the new region.
        delete placement.order;
        // Naming a panel and choosing where to put it is a request to see it
        // there. Carrying an older hide across the move would land it out of
        // sight, with nothing selected and no way to toggle it back on.
        delete placement.visible;
        if (region === descriptor.defaultRegion) delete placement.region;
        else placement.region = region;
        // A move is one transaction: the panel changes region, is revealed
        // where it landed, and stops being the source region's selection. The
        // resolver would ignore the stale ID anyway, but leaving it recorded
        // would resurrect it the moment the panel came back.
        const regions = { ...state.document.regions };
        const wasSelected =
          from !== undefined &&
          state.resolved.regions[from].selectedViewId === viewId;
        if (wasSelected) {
          regions[from] = { ...regions[from], selectedViewId: null };
        }
        const target: DraftRegionState = { ...regions[region] };
        target.selectedViewId = viewId;
        delete target.collapsed;
        regions[region] = target;
        // Below the responsive breakpoint a sidebar's visibility is the
        // transient overlay rather than the persisted collapse flag, so
        // clearing that flag alone would reveal nothing.
        const responsiveExpandedRegion =
          isResponsiveSidebar(region) && isNarrowViewport(state.viewport)
            ? region
            : state.responsiveExpandedRegion;
        commit(
          {
            ...withPlacement(state.document, viewId, placement),
            regions,
          },
          "now",
          responsiveExpandedRegion,
        );
        return true;
      },

      reorderPanel: (viewId, delta) => {
        const state = get();
        const region = state.resolved.panelRegions[viewId];
        if (region === undefined) return false;
        const ids = [...state.resolved.regions[region].placedViewIds];
        const current = ids.indexOf(viewId);
        if (current < 0) return false;
        const target = Math.min(Math.max(current + delta, 0), ids.length - 1);
        if (target === current) return false;
        ids.splice(current, 1);
        ids.splice(target, 0, viewId);
        // One transaction rewrites the whole region, so the stored indices stay
        // dense and independent of whichever panels happened to have one.
        const panels = { ...state.document.panels };
        ids.forEach((id, index) => {
          panels[id] = { ...panels[id], order: index };
        });
        commit({ ...state.document, panels }, "now");
        return true;
      },

      setPanelVisible: (viewId, visible) => {
        const state = get();
        if ((state.document.panels[viewId]?.visible !== false) === visible) {
          return;
        }
        const placement: DraftPlacement = { ...state.document.panels[viewId] };
        if (visible) delete placement.visible;
        else placement.visible = false;
        const document = withPlacement(state.document, viewId, placement);
        if (visible) {
          commit(document, "now");
          return;
        }
        // Hiding the active panel has to give up the selection with it. The
        // resolver falls back either way, but a selection left recorded would
        // become valid again the moment the panel is shown, snapping the
        // region back to it instead of leaving the user where they were.
        const regions = { ...document.regions };
        let released = false;
        for (const [regionId, regionState] of Object.entries(regions)) {
          if (regionState?.selectedViewId !== viewId) continue;
          regions[regionId as DockRegion] = {
            ...regionState,
            selectedViewId: null,
          };
          released = true;
        }
        commit(released ? { ...document, regions } : document, "now");
      },

      selectView: (region, viewId) => {
        const state = get();
        if (!state.resolved.regions[region].orderedViewIds.includes(viewId)) {
          return false;
        }
        if (state.resolved.regions[region].selectedViewId === viewId) {
          return true;
        }
        commit(
          withRegionState(state.document, region, {
            ...state.document.regions[region],
            selectedViewId: viewId,
          }),
          "now",
        );
        return true;
      },

      closeRegion: (region) => {
        const state = get();
        if (state.document.regions[region]?.selectedViewId === null) return;
        commit(
          withRegionState(state.document, region, {
            ...state.document.regions[region],
            selectedViewId: null,
          }),
          "now",
        );
      },

      setRegionCollapsed: (region, collapsed) => {
        const state = get();
        if (isResponsiveSidebar(region) && isNarrowViewport(state.viewport)) {
          const responsiveExpandedRegion = collapsed ? null : region;
          if (
            state.responsiveExpandedRegion === responsiveExpandedRegion &&
            state.resolved.regions[region].collapsed === collapsed
          ) {
            return;
          }
          set({
            responsiveExpandedRegion,
            resolved: resolve(
              state.document,
              state.panels,
              state.viewport,
              responsiveExpandedRegion,
            ),
          });
          return;
        }
        const regionConstraints =
          region === "lower-stage" ? LOWER_STAGE_CONSTRAINTS : constraints[region];
        if (!regionConstraints.collapsible) return;
        const resolved =
          region === "lower-stage"
            ? state.resolved.lowerStage
            : state.resolved.regions[region];
        if (resolved.collapsed === collapsed) return;
        const persisted =
          region === "lower-stage"
            ? state.document.lowerStage
            : state.document.regions[region];
        const next: DraftRegionState = { ...persisted };
        if (collapsed) next.collapsed = true;
        else delete next.collapsed;
        commit(
          region === "lower-stage"
            ? withLowerStageState(state.document, next)
            : withRegionState(state.document, region, next),
          "now",
        );
      },

      resizeRegion: (region, sizePx) => {
        if (!Number.isFinite(sizePx) || sizePx <= 0) return;
        const state = get();
        const resolved =
          region === "lower-stage"
            ? state.resolved.lowerStage
            : state.resolved.regions[region];
        // Clamp before storing: a drag past the edge must not persist a size
        // the region could never honour.
        const clamped = Math.min(
          Math.max(sizePx, resolved.minimumSizePx),
          resolved.maximumSizePx,
        );
        const persisted =
          region === "lower-stage"
            ? state.document.lowerStage
            : state.document.regions[region];
        if (persisted?.sizePx === clamped) return;
        const next = { ...persisted, sizePx: clamped };
        commit(
          region === "lower-stage"
            ? withLowerStageState(state.document, next)
            : withRegionState(state.document, region, next),
          "debounced",
        );
      },

      resetRegion: (region) => {
        const state = get();
        if (region === "lower-stage") {
          commit(withLowerStageState(state.document, {}), "now");
          return;
        }
        const panels = { ...state.document.panels };
        for (const descriptor of state.panels) {
          if (
            descriptor.defaultRegion === region ||
            state.resolved.panelRegions[descriptor.id] === region
          ) {
            delete panels[descriptor.id];
          }
        }
        const regions = { ...state.document.regions };
        delete regions[region];
        commit({ ...state.document, panels, regions }, "now");
      },

      resetRegionSize: (region) => {
        const state = get();
        if (region === "lower-stage") {
          if (state.document.lowerStage?.sizePx === undefined) return;
          const next = { ...state.document.lowerStage };
          delete next.sizePx;
          commit(withLowerStageState(state.document, next), "now");
          return;
        }
        if (state.document.regions[region]?.sizePx === undefined) return;
        const next: DraftRegionState = { ...state.document.regions[region] };
        delete next.sizePx;
        commit(withRegionState(state.document, region, next), "now");
      },

      resetLayout: () => {
        const state = get();
        commit(
          {
            version: 2,
            panels: {},
            regions: {},
            // Saved workspace overrides are a separate, explicitly-managed
            // scope; resetting the everyday layout must not discard them.
            workspaceLayouts: state.document.workspaceLayouts,
            // A reset is a deliberate "start from defaults", so the version 1
            // preferences must stay folded in rather than reappearing on the
            // next read.
            legacyPanelsMerged: true,
          },
          "now",
          null,
        );
      },

      flushPersistence: () => {
        if (pendingWrite === null) return;
        persistNow();
      },
    };
  });
}

/** Application-wide layout store. */
function getInitialViewport(): ShellViewport | null {
  const widthPx = globalThis.innerWidth;
  const heightPx = globalThis.innerHeight;
  return Number.isFinite(widthPx) &&
    widthPx > 0 &&
    Number.isFinite(heightPx) &&
    heightPx > 0
    ? { widthPx, heightPx }
    : null;
}

export const useShellLayoutStore = createShellLayoutStore({
  viewport: getInitialViewport(),
});

/**
 * The application store follows the live registry directly. Views register
 * during module evaluation and extensions register at activation, both outside
 * React, and placement is now the answer to "where does this panel live" for
 * every caller — so the table cannot depend on a component being mounted.
 */
observeShellPanels((panels) => {
  useShellLayoutStore.getState().setPanelDescriptors(panels);
});

/**
 * ...and owns dock selection in return, so a caller addressing a view by region
 * through the registry reaches the same state the shell renders.
 */
hostViewRegistry.attachDockSelectionAuthority({
  select: (region, viewId) => {
    const store = useShellLayoutStore.getState();
    if (!store.selectView(region, viewId)) return false;
    // Selecting a view inside a collapsed region has to reveal it, or the
    // command silently does nothing the user can see.
    store.setRegionCollapsed(region, false);
    return true;
  },
  getSelected: (region) =>
    useShellLayoutStore.getState().resolved.regions[region].selectedViewId,
  clearSelection: (region) => {
    useShellLayoutStore.getState().closeRegion(region);
  },
});
