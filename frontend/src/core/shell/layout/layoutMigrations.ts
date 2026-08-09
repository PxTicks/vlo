/**
 * Validation and version migration for the persisted shell layout
 * (plan §4.3). Every field that reaches the resolver passes through here, so a
 * corrupt, truncated, or hostile storage value degrades to "no preference"
 * rather than breaking shell startup.
 */
import {
  EMPTY_SHELL_LAYOUT_DOCUMENT,
  isDockRegion,
  type DockRegion,
  type PersistedPanelPlacement,
  type PersistedRegionGeometry,
  type PersistedRegionState,
  type ShellLayoutDocumentV2,
  type WorkspaceLayoutOverride,
} from "./layoutTypes";

/** Where version 2 documents live. */
export const SHELL_LAYOUT_STORAGE_KEY = "vlo.shell.layout.v2";

/**
 * Where HostViewRegistry's hidden/order preferences live. The migration reads
 * this key and never writes or deletes it: `projects-page.main` is not a dock
 * region, so the legacy registry stays the owner of its ordering.
 */
export const LEGACY_VIEW_LAYOUT_STORAGE_KEY = "vlo.shell.view-layout.v1";

/**
 * Bounds on how much corrupt input we are willing to carry forward. Unknown
 * IDs are retained on purpose (a disabled extension must be able to recover its
 * placement), so without a cap a junk document would grow without limit.
 */
const MAX_PERSISTED_PANELS = 500;
const MAX_PERSISTED_WORKSPACES = 100;
const MAX_VIEW_ID_LENGTH = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUsableViewId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_VIEW_ID_LENGTH;
}

function readPlacement(value: unknown): PersistedPanelPlacement | null {
  if (!isPlainObject(value)) return null;
  const placement: {
    region?: DockRegion;
    visible?: boolean;
    order?: number;
  } = {};
  if (isDockRegion(value.region)) placement.region = value.region;
  if (typeof value.visible === "boolean") placement.visible = value.visible;
  if (typeof value.order === "number" && Number.isFinite(value.order)) {
    placement.order = value.order;
  }
  // An entry that survived validation with nothing left in it carries no
  // intent; dropping it keeps the document from accumulating empty records.
  return Object.keys(placement).length === 0 ? null : placement;
}

function readPanels(
  value: unknown,
): Record<string, PersistedPanelPlacement> {
  const panels: Record<string, PersistedPanelPlacement> = {};
  if (!isPlainObject(value)) return panels;
  let kept = 0;
  for (const [viewId, raw] of Object.entries(value)) {
    if (kept >= MAX_PERSISTED_PANELS) break;
    if (!isUsableViewId(viewId)) continue;
    const placement = readPlacement(raw);
    if (!placement) continue;
    panels[viewId] = placement;
    kept += 1;
  }
  return panels;
}

function readRegionState(value: unknown): PersistedRegionState | null {
  if (!isPlainObject(value)) return null;
  const state: {
    selectedViewId?: string | null;
    collapsed?: boolean;
    sizePx?: number;
  } = {};
  if (value.selectedViewId === null) {
    state.selectedViewId = null;
  } else if (
    typeof value.selectedViewId === "string" &&
    isUsableViewId(value.selectedViewId)
  ) {
    state.selectedViewId = value.selectedViewId;
  }
  if (typeof value.collapsed === "boolean") state.collapsed = value.collapsed;
  if (
    typeof value.sizePx === "number" &&
    Number.isFinite(value.sizePx) &&
    value.sizePx > 0
  ) {
    state.sizePx = value.sizePx;
  }
  return Object.keys(state).length === 0 ? null : state;
}

function readRegionGeometry(value: unknown): PersistedRegionGeometry | null {
  const state = readRegionState(value);
  if (state === null) return null;
  const geometry: { collapsed?: boolean; sizePx?: number } = {};
  if (state.collapsed !== undefined) geometry.collapsed = state.collapsed;
  if (state.sizePx !== undefined) geometry.sizePx = state.sizePx;
  return Object.keys(geometry).length === 0 ? null : geometry;
}

function readRegions(
  value: unknown,
): Partial<Record<DockRegion, PersistedRegionState>> {
  const regions: Partial<Record<DockRegion, PersistedRegionState>> = {};
  if (!isPlainObject(value)) return regions;
  for (const [regionId, raw] of Object.entries(value)) {
    if (!isDockRegion(regionId)) continue;
    const state = readRegionState(raw);
    if (!state) continue;
    regions[regionId] = state;
  }
  return regions;
}

function readWorkspaceLayouts(
  value: unknown,
): Record<string, WorkspaceLayoutOverride> {
  const overrides: Record<string, WorkspaceLayoutOverride> = {};
  if (!isPlainObject(value)) return overrides;
  let kept = 0;
  for (const [workspaceId, raw] of Object.entries(value)) {
    if (kept >= MAX_PERSISTED_WORKSPACES) break;
    if (!isUsableViewId(workspaceId) || !isPlainObject(raw)) continue;
    overrides[workspaceId] = {
      panels: readPanels(raw.panels),
      regions: readRegions(raw.regions),
    };
    kept += 1;
  }
  return overrides;
}

/**
 * Version 1 stored a flat hidden list plus a per-region ordering of view IDs.
 * Both are user intent that must survive with no visible change.
 *
 * Visibility is region-independent, so every hidden ID carries over. Ordering
 * only carries over for dock regions: the legacy key is left intact, so
 * `projects-page.main` keeps its ordering where the legacy registry reads it.
 */
export function migrateLegacyViewLayout(
  raw: unknown,
): ShellLayoutDocumentV2 | null {
  if (!isPlainObject(raw) || raw.version !== 1) return null;
  const panels: Record<string, { visible?: boolean; order?: number }> = {};

  if (Array.isArray(raw.hidden)) {
    for (const viewId of raw.hidden) {
      if (typeof viewId !== "string" || !isUsableViewId(viewId)) continue;
      if (Object.keys(panels).length >= MAX_PERSISTED_PANELS) break;
      panels[viewId] = { ...panels[viewId], visible: false };
    }
  }

  if (isPlainObject(raw.order)) {
    for (const [regionId, ids] of Object.entries(raw.order)) {
      if (!isDockRegion(regionId) || !Array.isArray(ids)) continue;
      let index = 0;
      for (const viewId of ids) {
        if (typeof viewId !== "string" || !isUsableViewId(viewId)) continue;
        if (
          panels[viewId] === undefined &&
          Object.keys(panels).length >= MAX_PERSISTED_PANELS
        ) {
          break;
        }
        panels[viewId] = { ...panels[viewId], order: index };
        index += 1;
      }
    }
  }

  return {
    version: 2,
    panels,
    regions: {},
    workspaceLayouts: {},
  };
}

/**
 * Normalizes an already-parsed JSON value into a usable document, migrating a
 * version 1 payload on the way. Returns `null` when the value is not a
 * recognizable layout document at all, so a caller can fall back to another
 * source before settling for defaults.
 */
export function parseShellLayoutDocument(
  raw: unknown,
): ShellLayoutDocumentV2 | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version === 1) return migrateLegacyViewLayout(raw);
  if (raw.version !== 2) return null;
  const lowerStage = readRegionGeometry(raw.lowerStage);
  return {
    version: 2,
    panels: readPanels(raw.panels),
    regions: readRegions(raw.regions),
    ...(lowerStage === null ? {} : { lowerStage }),
    workspaceLayouts: readWorkspaceLayouts(raw.workspaceLayouts),
  };
}

/**
 * Resolves the document to use from the version 2 payload and, only when that
 * is missing or unusable, the legacy payload. Never throws.
 */
export function selectShellLayoutDocument(sources: {
  readonly current?: unknown;
  readonly legacy?: unknown;
}): ShellLayoutDocumentV2 {
  return (
    parseShellLayoutDocument(sources.current) ??
    parseShellLayoutDocument(sources.legacy) ??
    EMPTY_SHELL_LAYOUT_DOCUMENT
  );
}
