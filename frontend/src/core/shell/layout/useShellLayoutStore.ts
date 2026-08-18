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
import { cancelEditorSurfaceInteractions } from "../editorSurfaces";
import { hostViewRegistry } from "../viewRegistry";
import {
  arePanelDescriptorsEqual,
  areSurfaceDescriptorsEqual,
  observeEditorSurfaces,
  observeShellPanels,
} from "./layoutDescriptors";
import { resolveShellLayout } from "./layoutResolver";
import {
  captureWorkspaceLayoutOverride,
  createWorkspaceLayoutDocument,
  getWorkspaceStageSurfaces,
} from "../workspaces/workspaceLayout";
import type {
  ActiveWorkspaceLayout,
  WorkspaceComposition,
} from "../workspaces/workspaceTypes";
import {
  DOCK_REGION_CONSTRAINTS,
  EDITOR_STAGES,
  isPanelVisible,
  LOWER_STAGE_CONSTRAINTS,
  RESPONSIVE_SIDEBAR_BREAKPOINT_PX,
  type DockRegion,
  type DockRegionConstraints,
  type EditorStage,
  type EditorStageSurfaces,
  type PersistedPanelPlacement,
  type PersistedRegionGeometry,
  type PersistedRegionState,
  type ResolvedShellLayout,
  type ResizableShellRegion,
  type ResponsiveSidebarRegion,
  type ShellLayoutDocumentV2,
  type ShellPanelDescriptor,
  type ShellSurfaceDescriptor,
  type ShellViewport,
} from "./layoutTypes";

/** Long enough to swallow a drag, short enough to survive a quick reload. */
const DEFAULT_RESIZE_PERSIST_DELAY_MS = 250;

export interface ShellLayoutState {
  /** Persisted user intent. Never read directly by components. */
  readonly document: ShellLayoutDocumentV2;
  /** Session-only document; null while the everyday layout is active. */
  readonly activeWorkspaceLayout: ActiveWorkspaceLayout | null;
  /** Live panel table, pushed in by the registry adapter. */
  readonly panels: readonly ShellPanelDescriptor[];
  /** Live editor-surface table, pushed in by the registry adapter. */
  readonly surfaces: readonly ShellSurfaceDescriptor[];
  /** Session-only stage composition. Never persisted (plan §3.3). */
  readonly stageSurfaces: EditorStageSurfaces;
  readonly viewport: ShellViewport | null;
  readonly responsiveExpandedRegion: ResponsiveSidebarRegion | null;
  readonly resolved: ResolvedShellLayout;

  setPanelDescriptors(panels: readonly ShellPanelDescriptor[]): void;
  setSurfaceDescriptors(surfaces: readonly ShellSurfaceDescriptor[]): void;
  setViewport(viewport: ShellViewport | null): void;

  /**
   * Mounts a surface in a stage for this session, or returns to the stage's
   * registered default when passed null. Returns false when the surface is
   * unknown, unavailable, or does not permit the stage.
   */
  setStageSurface(stage: EditorStage, surfaceId: string | null): boolean;
  /** Returns every stage to its registered default. */
  clearStageSurfaces(): void;
  /** Atomically applies every dock and stage slot in a workspace composition. */
  activateWorkspaceLayout(
    workspaceId: string,
    composition: WorkspaceComposition,
  ): void;
  /** Restores the current base document against the live registries. */
  deactivateWorkspaceLayout(): void;
  saveActiveWorkspaceLayoutOverride(): boolean;
  clearWorkspaceLayoutOverride(workspaceId: string): boolean;

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
  readonly surfaces?: readonly ShellSurfaceDescriptor[];
  readonly viewport?: ShellViewport | null;
  /** Seam for tests; defaults to the registered surface's own canceller. */
  readonly cancelSurfaceInteractions?: (surfaceId: string) => void;
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

/**
 * Records visibility only where it departs from the registration's default, so
 * a panel the user never disagreed with keeps following its default and a
 * reset that drops the placement lands back on it. Every writer goes through
 * this: deleting the flag is not "show it" for a panel that registered hidden.
 */
function draftVisibility(
  placement: DraftPlacement,
  descriptor: ShellPanelDescriptor | undefined,
  visible: boolean,
): void {
  if (visible === (descriptor?.defaultVisible ?? true)) delete placement.visible;
  else placement.visible = visible;
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

/** Everything the resolver reads. A superset of it is the store's own state. */
interface LayoutResolutionInputs {
  readonly document: ShellLayoutDocumentV2;
  readonly panels: readonly ShellPanelDescriptor[];
  readonly surfaces: readonly ShellSurfaceDescriptor[];
  readonly viewport: ShellViewport | null;
  readonly responsiveExpandedRegion: ResponsiveSidebarRegion | null;
  readonly stageSurfaces: EditorStageSurfaces;
}

function currentLayoutDocument(
  state: Pick<ShellLayoutState, "document" | "activeWorkspaceLayout">,
): ShellLayoutDocumentV2 {
  return state.activeWorkspaceLayout?.document ?? state.document;
}

export function createShellLayoutStore(options: ShellLayoutStoreOptions = {}) {
  const persistence =
    options.persistence ?? createLocalShellLayoutPersistence();
  const constraints = options.constraints ?? DOCK_REGION_CONSTRAINTS;
  const resizePersistDelayMs =
    options.resizePersistDelayMs ?? DEFAULT_RESIZE_PERSIST_DELAY_MS;
  const cancelSurfaceInteractions =
    options.cancelSurfaceInteractions ??
    ((surfaceId: string) => cancelEditorSurfaceInteractions(surfaceId));

  return create<ShellLayoutState>()((set, get) => {
    let pendingWrite: ReturnType<typeof setTimeout> | null = null;

    const resolve = (inputs: LayoutResolutionInputs): ResolvedShellLayout =>
      resolveShellLayout({ ...inputs, constraints });

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
      if (state.activeWorkspaceLayout !== null) {
        cancelPendingWrite();
        const activeWorkspaceLayout = {
          ...state.activeWorkspaceLayout,
          document,
        };
        set({
          activeWorkspaceLayout,
          responsiveExpandedRegion,
          resolved: resolve({
            ...state,
            document,
            responsiveExpandedRegion,
          }),
        });
        return;
      }
      set({
        document,
        responsiveExpandedRegion,
        resolved: resolve({ ...state, document, responsiveExpandedRegion }),
      });
      if (persist === "now") persistNow();
      else persistSoon();
    };

    const findDescriptor = (viewId: string): ShellPanelDescriptor | undefined =>
      get().panels.find((descriptor) => descriptor.id === viewId);

    const initialInputs: LayoutResolutionInputs = {
      document: persistence.read(),
      panels: options.panels ?? [],
      surfaces: options.surfaces ?? [],
      viewport: options.viewport ?? null,
      responsiveExpandedRegion: null,
      stageSurfaces: {},
    };

    return {
      ...initialInputs,
      activeWorkspaceLayout: null,
      resolved: resolve(initialInputs),

      setPanelDescriptors: (panels) => {
        const state = get();
        if (arePanelDescriptorsEqual(state.panels, panels)) return;
        set({
          panels,
          resolved: resolve({
            ...state,
            panels,
            document: currentLayoutDocument(state),
          }),
        });
      },

      setSurfaceDescriptors: (surfaces) => {
        const state = get();
        if (areSurfaceDescriptorsEqual(state.surfaces, surfaces)) return;
        set({
          surfaces,
          resolved: resolve({
            ...state,
            surfaces,
            document: currentLayoutDocument(state),
          }),
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
          resolved: resolve({
            ...state,
            document: currentLayoutDocument(state),
            viewport,
            responsiveExpandedRegion,
          }),
        });
      },

      setStageSurface: (stage, surfaceId) => {
        const state = get();
        if (surfaceId !== null) {
          const descriptor = state.surfaces.find(
            (candidate) => candidate.id === surfaceId,
          );
          if (
            !descriptor ||
            !descriptor.available ||
            !descriptor.allowedStages.includes(stage)
          ) {
            return false;
          }
        }
        if ((state.stageSurfaces[stage] ?? null) === surfaceId) return true;
        const outgoing = state.resolved.stages[stage].surfaceId;
        const stageSurfaces = { ...state.stageSurfaces };
        if (surfaceId === null) delete stageSurfaces[stage];
        else stageSurfaces[stage] = surfaceId;
        const resolved = resolve({
          ...state,
          document: currentLayoutDocument(state),
          stageSurfaces,
        });
        // Nothing the outgoing surface was dragging may outlive it, and the
        // mount's own cleanup runs after the swap has already been committed
        // (plan §4.8). Cancelling here means the guarantee holds even for a
        // caller that changes the composition with no shell rendered at all.
        if (outgoing !== null && outgoing !== resolved.stages[stage].surfaceId) {
          cancelSurfaceInteractions(outgoing);
        }
        set({ stageSurfaces, resolved });
        return true;
      },

      clearStageSurfaces: () => {
        const state = get();
        if (Object.keys(state.stageSurfaces).length === 0) return;
        const stageSurfaces: EditorStageSurfaces = {};
        const resolved = resolve({
          ...state,
          document: currentLayoutDocument(state),
          stageSurfaces,
        });
        for (const stage of EDITOR_STAGES) {
          const outgoing = state.resolved.stages[stage].surfaceId;
          if (
            outgoing !== null &&
            outgoing !== resolved.stages[stage].surfaceId
          ) {
            cancelSurfaceInteractions(outgoing);
          }
        }
        set({ stageSurfaces, resolved });
      },

      activateWorkspaceLayout: (workspaceId, composition) => {
        const state = get();
        // A base resize waiting on its debounce belongs to the everyday layout
        // and must land before the session starts suppressing persistence.
        if (pendingWrite !== null) persistNow();
        const stageSurfaces = getWorkspaceStageSurfaces(composition);
        const document = createWorkspaceLayoutDocument({
          base: state.document,
          override: state.document.workspaceLayouts[workspaceId],
          composition,
          panels: state.panels,
        });
        const resolved = resolve({
          ...state,
          document,
          stageSurfaces,
          responsiveExpandedRegion: null,
        });
        for (const stage of EDITOR_STAGES) {
          const outgoing = state.resolved.stages[stage].surfaceId;
          if (outgoing !== null && outgoing !== resolved.stages[stage].surfaceId) {
            cancelSurfaceInteractions(outgoing);
          }
        }
        set({
          activeWorkspaceLayout: {
            workspaceId,
            composition,
            document,
            restoreStageSurfaces:
              state.activeWorkspaceLayout?.restoreStageSurfaces ??
              state.stageSurfaces,
          },
          stageSurfaces,
          responsiveExpandedRegion: null,
          resolved,
        });
      },

      deactivateWorkspaceLayout: () => {
        const state = get();
        const active = state.activeWorkspaceLayout;
        if (active === null) return;
        const stageSurfaces = active.restoreStageSurfaces;
        const resolved = resolve({
          ...state,
          document: state.document,
          stageSurfaces,
          responsiveExpandedRegion: null,
        });
        for (const stage of EDITOR_STAGES) {
          const outgoing = state.resolved.stages[stage].surfaceId;
          if (outgoing !== null && outgoing !== resolved.stages[stage].surfaceId) {
            cancelSurfaceInteractions(outgoing);
          }
        }
        set({
          activeWorkspaceLayout: null,
          stageSurfaces,
          responsiveExpandedRegion: null,
          resolved,
        });
      },

      saveActiveWorkspaceLayoutOverride: () => {
        const state = get();
        const active = state.activeWorkspaceLayout;
        if (active === null) return false;
        const baselineDocument = createWorkspaceLayoutDocument({
          base: state.document,
          composition: active.composition,
          panels: state.panels,
        });
        const baselineResolved = resolve({
          ...state,
          document: baselineDocument,
          stageSurfaces: getWorkspaceStageSurfaces(active.composition),
        });
        const override = captureWorkspaceLayoutOverride({
          document: active.document,
          resolved: state.resolved,
          baselineDocument,
          baselineResolved,
          panels: state.panels,
        });
        const document = {
          ...state.document,
          workspaceLayouts: {
            ...state.document.workspaceLayouts,
            [active.workspaceId]: override,
          },
        };
        set({
          document,
          activeWorkspaceLayout: {
            ...active,
            document: { ...active.document, workspaceLayouts: document.workspaceLayouts },
          },
        });
        persistNow();
        return true;
      },

      clearWorkspaceLayoutOverride: (workspaceId) => {
        const state = get();
        if (state.document.workspaceLayouts[workspaceId] === undefined) {
          return false;
        }
        const workspaceLayouts = { ...state.document.workspaceLayouts };
        delete workspaceLayouts[workspaceId];
        const document = { ...state.document, workspaceLayouts };
        const active = state.activeWorkspaceLayout;
        if (active?.workspaceId === workspaceId) {
          const activeDocument = createWorkspaceLayoutDocument({
            base: document,
            composition: active.composition,
            panels: state.panels,
          });
          set({
            document,
            activeWorkspaceLayout: { ...active, document: activeDocument },
            resolved: resolve({ ...state, document: activeDocument }),
          });
        } else {
          set({ document });
        }
        persistNow();
        return true;
      },

      movePanel: (viewId, region) => {
        const descriptor = findDescriptor(viewId);
        if (!descriptor || !descriptor.allowedRegions.includes(region)) {
          return false;
        }
        const state = get();
        const document = currentLayoutDocument(state);
        const from = state.resolved.panelRegions[viewId];
        if (from === region) return true;
        const placement: DraftPlacement = { ...document.panels[viewId] };
        // An ordering index only means something inside the region it was
        // recorded for, so a move drops it and the panel lands on its
        // registration order in the new region.
        delete placement.order;
        // Naming a panel and choosing where to put it is a request to see it
        // there. Carrying an older hide across the move would land it out of
        // sight, with nothing selected and no way to toggle it back on.
        draftVisibility(placement, descriptor, true);
        if (region === descriptor.defaultRegion) delete placement.region;
        else placement.region = region;
        // A move is one transaction: the panel changes region, is revealed
        // where it landed, and stops being the source region's selection. The
        // resolver would ignore the stale ID anyway, but leaving it recorded
        // would resurrect it the moment the panel came back.
        const regions = { ...document.regions };
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
            ...withPlacement(document, viewId, placement),
            regions,
          },
          "now",
          responsiveExpandedRegion,
        );
        return true;
      },

      reorderPanel: (viewId, delta) => {
        const state = get();
        const document = currentLayoutDocument(state);
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
        const panels = { ...document.panels };
        ids.forEach((id, index) => {
          panels[id] = { ...panels[id], order: index };
        });
        commit({ ...document, panels }, "now");
        return true;
      },

      setPanelVisible: (viewId, visible) => {
        const state = get();
        const current = currentLayoutDocument(state);
        const descriptor = findDescriptor(viewId);
        if (isPanelVisible(descriptor, current.panels[viewId]) === visible) {
          return;
        }
        const placement: DraftPlacement = { ...current.panels[viewId] };
        draftVisibility(placement, descriptor, visible);
        const document = withPlacement(current, viewId, placement);
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
        const document = currentLayoutDocument(state);
        if (!state.resolved.regions[region].orderedViewIds.includes(viewId)) {
          return false;
        }
        if (state.resolved.regions[region].selectedViewId === viewId) {
          return true;
        }
        commit(
          withRegionState(document, region, {
            ...document.regions[region],
            selectedViewId: viewId,
          }),
          "now",
        );
        return true;
      },

      closeRegion: (region) => {
        const state = get();
        const document = currentLayoutDocument(state);
        if (document.regions[region]?.selectedViewId === null) return;
        commit(
          withRegionState(document, region, {
            ...document.regions[region],
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
            resolved: resolve({
              ...state,
              document: currentLayoutDocument(state),
              responsiveExpandedRegion,
            }),
          });
          return;
        }
        const regionConstraints =
          region === "lower-stage" ? LOWER_STAGE_CONSTRAINTS : constraints[region];
        if (!regionConstraints.collapsible) return;
        const document = currentLayoutDocument(state);
        const resolved =
          region === "lower-stage"
            ? state.resolved.lowerStage
            : state.resolved.regions[region];
        if (resolved.collapsed === collapsed) return;
        const persisted =
          region === "lower-stage"
            ? document.lowerStage
            : document.regions[region];
        const next: DraftRegionState = { ...persisted };
        if (collapsed) next.collapsed = true;
        else delete next.collapsed;
        commit(
          region === "lower-stage"
            ? withLowerStageState(document, next)
            : withRegionState(document, region, next),
          "now",
        );
      },

      resizeRegion: (region, sizePx) => {
        if (!Number.isFinite(sizePx) || sizePx <= 0) return;
        const state = get();
        const document = currentLayoutDocument(state);
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
            ? document.lowerStage
            : document.regions[region];
        if (persisted?.sizePx === clamped) return;
        const next = { ...persisted, sizePx: clamped };
        commit(
          region === "lower-stage"
            ? withLowerStageState(document, next)
            : withRegionState(document, region, next),
          "debounced",
        );
      },

      resetRegion: (region) => {
        const state = get();
        const document = currentLayoutDocument(state);
        const active = state.activeWorkspaceLayout;
        if (active !== null) {
          const baselineDocument = createWorkspaceLayoutDocument({
            base: state.document,
            override: state.document.workspaceLayouts[active.workspaceId],
            composition: active.composition,
            panels: state.panels,
          });
          if (region === "lower-stage") {
            commit(
              withLowerStageState(
                document,
                baselineDocument.lowerStage ?? {},
              ),
              "now",
            );
            return;
          }
          const baselineResolved = resolve({
            ...state,
            document: baselineDocument,
          });
          const panels = { ...document.panels };
          for (const descriptor of state.panels) {
            if (
              state.resolved.panelRegions[descriptor.id] !== region &&
              baselineResolved.panelRegions[descriptor.id] !== region
            ) {
              continue;
            }
            const baselinePlacement = baselineDocument.panels[descriptor.id];
            if (baselinePlacement === undefined) delete panels[descriptor.id];
            else panels[descriptor.id] = baselinePlacement;
          }
          const regions = { ...document.regions };
          const baselineRegion = baselineDocument.regions[region];
          if (baselineRegion === undefined) delete regions[region];
          else regions[region] = baselineRegion;
          commit({ ...document, panels, regions }, "now");
          return;
        }
        if (region === "lower-stage") {
          commit(withLowerStageState(document, {}), "now");
          return;
        }
        const panels = { ...document.panels };
        for (const descriptor of state.panels) {
          if (
            descriptor.defaultRegion === region ||
            state.resolved.panelRegions[descriptor.id] === region
          ) {
            delete panels[descriptor.id];
          }
        }
        const regions = { ...document.regions };
        delete regions[region];
        commit({ ...document, panels, regions }, "now");
      },

      resetRegionSize: (region) => {
        const state = get();
        const document = currentLayoutDocument(state);
        const active = state.activeWorkspaceLayout;
        const baselineDocument =
          active === null
            ? null
            : createWorkspaceLayoutDocument({
                base: state.document,
                override: state.document.workspaceLayouts[active.workspaceId],
                composition: active.composition,
                panels: state.panels,
              });
        if (region === "lower-stage") {
          if (document.lowerStage?.sizePx === undefined) return;
          const next = { ...document.lowerStage };
          const baselineSize = baselineDocument?.lowerStage?.sizePx;
          if (baselineSize === undefined) delete next.sizePx;
          else next.sizePx = baselineSize;
          commit(withLowerStageState(document, next), "now");
          return;
        }
        if (document.regions[region]?.sizePx === undefined) return;
        const next: DraftRegionState = { ...document.regions[region] };
        const baselineSize = baselineDocument?.regions[region]?.sizePx;
        if (baselineSize === undefined) delete next.sizePx;
        else next.sizePx = baselineSize;
        commit(withRegionState(document, region, next), "now");
      },

      resetLayout: () => {
        const state = get();
        const active = state.activeWorkspaceLayout;
        if (active !== null) {
          cancelPendingWrite();
          const document = createWorkspaceLayoutDocument({
            base: state.document,
            override: state.document.workspaceLayouts[active.workspaceId],
            composition: active.composition,
            panels: state.panels,
          });
          const stageSurfaces = getWorkspaceStageSurfaces(active.composition);
          const resolved = resolve({
            ...state,
            document,
            stageSurfaces,
            responsiveExpandedRegion: null,
          });
          for (const stage of EDITOR_STAGES) {
            const outgoing = state.resolved.stages[stage].surfaceId;
            if (
              outgoing !== null &&
              outgoing !== resolved.stages[stage].surfaceId
            ) {
              cancelSurfaceInteractions(outgoing);
            }
          }
          set({
            activeWorkspaceLayout: { ...active, document },
            stageSurfaces,
            responsiveExpandedRegion: null,
            resolved,
          });
          return;
        }
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

/** Editor surfaces follow the live registry for the same reasons. */
observeEditorSurfaces((surfaces) => {
  useShellLayoutStore.getState().setSurfaceDescriptors(surfaces);
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
