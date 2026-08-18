/**
 * The pure layout resolver (plan §4.4). It combines registry defaults, the
 * user's saved layout, live availability, and the viewport into one complete
 * `ResolvedShellLayout`.
 *
 * Purity is the point: migrations, fallback behaviour, missing extensions, and
 * viewport adaptation are all testable without rendering React, and no
 * component gets to decide a panel's effective location on its own.
 */
import {
  DOCK_REGIONS,
  DOCK_REGION_CONSTRAINTS,
  EDITOR_STAGES,
  LOWER_STAGE_CONSTRAINTS,
  RESPONSIVE_SIDEBAR_BREAKPOINT_PX,
  isPanelVisible,
  type DockRegion,
  type DockRegionConstraints,
  type EditorStage,
  type EditorStageSurfaces,
  type PersistedPanelPlacement,
  type ResolvedDockRegion,
  type ResolvedEditorStage,
  type ResolvedLowerStage,
  type ResolvedShellLayout,
  type ResponsiveSidebarRegion,
  type ShellLayoutDocumentV2,
  type ShellPanelDescriptor,
  type ShellSurfaceDescriptor,
  type ShellViewport,
} from "./layoutTypes";

export interface ShellLayoutResolutionInput {
  readonly panels: readonly ShellPanelDescriptor[];
  /** Registered editor surfaces. Omitted leaves both stages empty. */
  readonly surfaces?: readonly ShellSurfaceDescriptor[];
  readonly document: ShellLayoutDocumentV2;
  /** Omitted or null skips viewport clamping (server render, tests, headless). */
  readonly viewport?: ShellViewport | null;
  readonly constraints?: Readonly<Record<DockRegion, DockRegionConstraints>>;
  /** Session-only sidebar opened over a narrow viewport. */
  readonly responsiveExpandedRegion?: ResponsiveSidebarRegion | null;
  /** Session-only stage composition, e.g. an active dedicated workspace. */
  readonly stageSurfaces?: EditorStageSurfaces;
}

function isResponsiveSidebar(
  region: DockRegion,
): region is ResponsiveSidebarRegion {
  return region === "left-sidebar" || region === "right-sidebar";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * A persisted placement only wins when the panel still permits it. Anything
 * else — an unknown region, a region the panel was never allowed in, a region
 * it lost when its registration changed — falls back to the registered default
 * so the layout stays deterministic.
 */
function resolveRegion(
  descriptor: ShellPanelDescriptor,
  placement: PersistedPanelPlacement | undefined,
): DockRegion {
  const requested = placement?.region;
  if (requested === undefined || requested === descriptor.defaultRegion) {
    return descriptor.defaultRegion;
  }
  return descriptor.allowedRegions.includes(requested)
    ? requested
    : descriptor.defaultRegion;
}

/**
 * Nearest visible and available sibling to a lost selection. Ties resolve
 * forward first, matching the way closing a tab hands over to the tab on its
 * right rather than jumping backwards.
 */
function findNearestSelectable(
  placedViewIds: readonly string[],
  selectable: ReadonlySet<string>,
  fromIndex: number,
): string | null {
  for (let offset = 1; offset < placedViewIds.length; offset += 1) {
    const after = placedViewIds[fromIndex + offset];
    if (after !== undefined && selectable.has(after)) return after;
    const before = placedViewIds[fromIndex - offset];
    if (before !== undefined && selectable.has(before)) return before;
  }
  return null;
}

/**
 * Deterministic selection fallback (plan §4.2):
 * 1. the persisted selection, when it is still visible and available;
 * 2. the nearest visible and available sibling;
 * 3. the region's first available default view, for auto-selecting regions; or
 * 4. an explicit empty-region state.
 *
 * A stale ID whose panel is gone entirely skips straight to step 3, which is
 * what closes the bottom dock when the extension owning its only view is
 * disposed.
 */
function resolveSelection(
  persistedSelection: string | null | undefined,
  placedViewIds: readonly string[],
  orderedViewIds: readonly string[],
  byId: ReadonlyMap<string, ShellPanelDescriptor>,
  autoSelect: boolean,
): string | null {
  const selectable = new Set(orderedViewIds);
  if (persistedSelection != null) {
    if (selectable.has(persistedSelection)) return persistedSelection;
    const staleIndex = placedViewIds.indexOf(persistedSelection);
    if (staleIndex >= 0) {
      const nearest = findNearestSelectable(
        placedViewIds,
        selectable,
        staleIndex,
      );
      if (nearest !== null) return nearest;
    }
  }
  if (!autoSelect) return null;
  // Built-in panels are a region's defaults; a contributed panel only becomes
  // the fallback when nothing native is left to show.
  return (
    orderedViewIds.find((id) => byId.get(id)?.source === "host") ??
    orderedViewIds[0] ??
    null
  );
}

function resolveSize(
  regionConstraints: DockRegionConstraints,
  persistedSizePx: number | undefined,
  selectedDescriptor: ShellPanelDescriptor | undefined,
  viewport: ShellViewport | null | undefined,
): Pick<
  ResolvedDockRegion,
  "sizePx" | "userSizePx" | "minimumSizePx" | "maximumSizePx"
> {
  // 1. The region's hard maximum is authoritative: it is the only bound the
  //    shell can actually honour, so it survives every other input. A region
  //    whose own bounds are inverted resolves in the maximum's favour.
  const regionMaximum = regionConstraints.maximumSizePx;
  const regionMinimum = Math.min(regionConstraints.minimumSizePx, regionMaximum);

  // 2. The selected view's constraints tighten — never loosen — the region's,
  //    which means a view asking for more than the region can give is pinned to
  //    the region band rather than widening it. Clamping the minimum first is
  //    what keeps the maximum below the region's, even when a descriptor's own
  //    bounds are contradictory or out of range.
  const minimumSizePx = clamp(
    Math.max(
      regionMinimum,
      finitePositive(selectedDescriptor?.minimumSizePx) ?? 0,
    ),
    regionMinimum,
    regionMaximum,
  );
  const declaredMaximum = Math.min(
    regionMaximum,
    finitePositive(selectedDescriptor?.maximumSizePx) ?? Number.POSITIVE_INFINITY,
  );
  // A view maximum below the effective minimum collapses the band rather than
  // breaching either region bound.
  const maximumSizePx = clamp(
    Math.max(declaredMaximum, minimumSizePx),
    regionMinimum,
    regionMaximum,
  );

  // 3. The user's preference wins over the view hint, which wins over the
  //    region default.
  const requested =
    finitePositive(persistedSizePx) ??
    finitePositive(selectedDescriptor?.preferredSizePx) ??
    regionConstraints.defaultSizePx;
  const userSizePx = clamp(requested, minimumSizePx, maximumSizePx);

  // 4. The viewport limits what we render but never what we remember, so a
  //    narrow window cannot overwrite a desktop preference. This is the one
  //    result allowed below `minimumSizePx`: a window too small for the band
  //    still has to render something.
  let sizePx = userSizePx;
  const extent =
    regionConstraints.axis === "width" ? viewport?.widthPx : viewport?.heightPx;
  if (typeof extent === "number" && Number.isFinite(extent) && extent > 0) {
    const viewportMaximum = Math.max(
      1,
      Math.floor(extent * regionConstraints.maximumViewportFraction),
    );
    sizePx = Math.min(userSizePx, viewportMaximum);
  }

  return { sizePx, userSizePx, minimumSizePx, maximumSizePx };
}

function resolveLowerStage(
  document: ShellLayoutDocumentV2,
  viewport: ShellViewport | null | undefined,
): ResolvedLowerStage {
  return Object.freeze({
    id: "lower-stage",
    collapsed: document.lowerStage?.collapsed === true,
    ...resolveSize(
      LOWER_STAGE_CONSTRAINTS,
      document.lowerStage?.sizePx,
      undefined,
      viewport,
    ),
  });
}

/**
 * Which surface each stage mounts.
 *
 * A stage's default is the available surface that *registered* for it, lowest
 * order first. Being merely allowed in a stage is not enough to be its default,
 * or unregistering the player would drop the timeline into the picture area.
 *
 * A session composition wins over the default, but only when the named surface
 * exists, is available, and permits that stage — so a workspace holding a
 * reference to a surface an extension took away resolves back to the editor's
 * own arrangement instead of blanking the stage.
 */
function resolveStages(
  surfaces: readonly ShellSurfaceDescriptor[],
  stageSurfaces: EditorStageSurfaces | undefined,
): Record<EditorStage, ResolvedEditorStage> {
  const seen = new Set<string>();
  const known: ShellSurfaceDescriptor[] = [];
  for (const descriptor of surfaces) {
    // Duplicate IDs cannot survive registration, but the resolver stays total
    // either way: first wins, exactly as it does for panels.
    if (seen.has(descriptor.id)) continue;
    seen.add(descriptor.id);
    known.push(descriptor);
  }
  known.sort(
    (left, right) =>
      left.defaultOrder - right.defaultOrder || left.id.localeCompare(right.id),
  );

  const stages = {} as Record<EditorStage, ResolvedEditorStage>;
  for (const stage of EDITOR_STAGES) {
    const candidates = known.filter(
      (descriptor) =>
        descriptor.available && descriptor.allowedStages.includes(stage),
    );
    const requested = stageSurfaces?.[stage];
    const requestedSurface =
      requested === undefined
        ? undefined
        : candidates.find((descriptor) => descriptor.id === requested);
    const surfaceId =
      requestedSurface?.id ??
      candidates.find((descriptor) => descriptor.defaultStage === stage)?.id ??
      null;
    stages[stage] = Object.freeze({
      id: stage,
      surfaceId,
      candidateSurfaceIds: Object.freeze(
        candidates.map((descriptor) => descriptor.id),
      ),
    });
  }
  return stages;
}

export function resolveShellLayout(
  input: ShellLayoutResolutionInput,
): ResolvedShellLayout {
  const constraints = input.constraints ?? DOCK_REGION_CONSTRAINTS;
  const { panels: placements, regions: regionStates } = input.document;

  // 1. Bind each panel to exactly one region. Duplicate IDs cannot survive
  //    registration, but the resolver stays total either way: first wins.
  const byId = new Map<string, ShellPanelDescriptor>();
  const placedByRegion = new Map<DockRegion, ShellPanelDescriptor[]>(
    DOCK_REGIONS.map((region) => [region, []]),
  );
  const panelRegions: Record<string, DockRegion> = {};
  for (const descriptor of input.panels) {
    if (byId.has(descriptor.id)) continue;
    byId.set(descriptor.id, descriptor);
    const region = resolveRegion(descriptor, placements[descriptor.id]);
    panelRegions[descriptor.id] = region;
    placedByRegion.get(region)?.push(descriptor);
  }

  // 2. Order within a region: an explicit user order first, then registration
  //    order, then ID. Mirrors the version 1 behaviour exactly, so migrated
  //    preferences produce the same tab strip they did before.
  const regions = {} as Record<DockRegion, ResolvedDockRegion>;
  for (const regionId of DOCK_REGIONS) {
    const regionConstraints = constraints[regionId];
    const placed = [...(placedByRegion.get(regionId) ?? [])].sort(
      (left, right) => {
        const leftOrder = placements[left.id]?.order;
        const rightOrder = placements[right.id]?.order;
        if (leftOrder !== undefined || rightOrder !== undefined) {
          if (leftOrder === undefined) return 1;
          if (rightOrder === undefined) return -1;
          if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        }
        return (
          left.defaultOrder - right.defaultOrder ||
          left.id.localeCompare(right.id)
        );
      },
    );
    const placedViewIds = placed.map((descriptor) => descriptor.id);
    const orderedViewIds = placed
      .filter(
        (descriptor) =>
          descriptor.available &&
          isPanelVisible(descriptor, placements[descriptor.id]),
      )
      .map((descriptor) => descriptor.id);

    const regionState = regionStates[regionId];
    const selectedViewId = resolveSelection(
      regionState?.selectedViewId,
      placedViewIds,
      orderedViewIds,
      byId,
      regionConstraints.autoSelect,
    );
    const userCollapsed =
      regionConstraints.collapsible && regionState?.collapsed === true;
    const responsiveCollapsed =
      regionConstraints.collapsible &&
      isResponsiveSidebar(regionId) &&
      input.viewport !== null &&
      input.viewport !== undefined &&
      Number.isFinite(input.viewport.widthPx) &&
      input.viewport.widthPx > 0 &&
      input.viewport.widthPx < RESPONSIVE_SIDEBAR_BREAKPOINT_PX;

    regions[regionId] = Object.freeze({
      id: regionId,
      orderedViewIds: Object.freeze(orderedViewIds),
      placedViewIds: Object.freeze(placedViewIds),
      selectedViewId,
      userCollapsed,
      collapsed: responsiveCollapsed
        ? input.responsiveExpandedRegion !== regionId
        : userCollapsed,
      ...resolveSize(
        regionConstraints,
        regionState?.sizePx,
        selectedViewId === null ? undefined : byId.get(selectedViewId),
        input.viewport,
      ),
    });
  }

  return Object.freeze({
    regions: Object.freeze(regions),
    stages: Object.freeze(
      resolveStages(input.surfaces ?? [], input.stageSurfaces),
    ),
    lowerStage: resolveLowerStage(input.document, input.viewport),
    panelRegions: Object.freeze(panelRegions),
  });
}
