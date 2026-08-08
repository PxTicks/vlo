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
import { arePanelDescriptorsEqual } from "./layoutDescriptors";
import { resolveShellLayout } from "./layoutResolver";
import {
  DOCK_REGION_CONSTRAINTS,
  type DockRegion,
  type DockRegionConstraints,
  type PersistedPanelPlacement,
  type PersistedRegionState,
  type ResolvedShellLayout,
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
  readonly resolved: ResolvedShellLayout;

  setPanelDescriptors(panels: readonly ShellPanelDescriptor[]): void;
  setViewport(viewport: ShellViewport | null): void;

  /** Returns false when the panel does not permit the target region. */
  movePanel(viewId: string, region: DockRegion): boolean;
  /** Moves a panel one slot within its region, hidden siblings included. */
  reorderPanel(viewId: string, delta: -1 | 1): boolean;
  setPanelVisible(viewId: string, visible: boolean): void;
  /** Returns false when the view is not selectable in that region right now. */
  selectView(region: DockRegion, viewId: string): boolean;
  /** Drops a region's selection. Auto-selecting regions fall back immediately. */
  closeRegion(region: DockRegion): void;
  setRegionCollapsed(region: DockRegion, collapsed: boolean): void;
  resizeRegion(region: DockRegion, sizePx: number): void;
  resetRegion(region: DockRegion): void;
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
    ): ResolvedShellLayout =>
      resolveShellLayout({ panels, document, viewport, constraints });

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
    ): void => {
      const state = get();
      set({ document, resolved: resolve(document, state.panels, state.viewport) });
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
      resolved: resolve(initialDocument, initialPanels, initialViewport),

      setPanelDescriptors: (panels) => {
        const state = get();
        if (arePanelDescriptorsEqual(state.panels, panels)) return;
        set({
          panels,
          resolved: resolve(state.document, panels, state.viewport),
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
        set({
          viewport,
          resolved: resolve(state.document, state.panels, viewport),
        });
      },

      movePanel: (viewId, region) => {
        const descriptor = findDescriptor(viewId);
        if (!descriptor || !descriptor.allowedRegions.includes(region)) {
          return false;
        }
        const state = get();
        if (state.resolved.panelRegions[viewId] === region) return true;
        const placement: DraftPlacement = { ...state.document.panels[viewId] };
        // An ordering index only means something inside the region it was
        // recorded for, so a move drops it and the panel lands on its
        // registration order in the new region.
        delete placement.order;
        if (region === descriptor.defaultRegion) delete placement.region;
        else placement.region = region;
        commit(withPlacement(state.document, viewId, placement), "now");
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
        commit(withPlacement(state.document, viewId, placement), "now");
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
        if (!constraints[region].collapsible) return;
        const state = get();
        if (state.resolved.regions[region].collapsed === collapsed) return;
        const next: DraftRegionState = { ...state.document.regions[region] };
        if (collapsed) next.collapsed = true;
        else delete next.collapsed;
        commit(withRegionState(state.document, region, next), "now");
      },

      resizeRegion: (region, sizePx) => {
        if (!Number.isFinite(sizePx) || sizePx <= 0) return;
        const state = get();
        const resolved = state.resolved.regions[region];
        // Clamp before storing: a drag past the edge must not persist a size
        // the region could never honour.
        const clamped = Math.min(
          Math.max(sizePx, resolved.minimumSizePx),
          resolved.maximumSizePx,
        );
        if (state.document.regions[region]?.sizePx === clamped) return;
        commit(
          withRegionState(state.document, region, {
            ...state.document.regions[region],
            sizePx: clamped,
          }),
          "debounced",
        );
      },

      resetRegion: (region) => {
        const state = get();
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
          },
          "now",
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
export const useShellLayoutStore = createShellLayoutStore();
