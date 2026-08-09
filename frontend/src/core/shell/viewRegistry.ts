import type { ReactNode } from "react";
import type { ExtensionContextKeyExpression } from "@vlo/extension-sdk";
import {
  assertContextKeyExpression,
  hostContextKeys,
  type HostContextKeyService,
} from "./contextKeys";
import {
  DOCK_REGIONS,
  isDockRegion,
  type DockRegion,
} from "./layout/layoutTypes";
import type { ShellDisposable } from "./hostMenuCatalog";

export const HOST_VIEW_REGIONS = [
  "left-sidebar",
  "right-sidebar",
  "projects-page.main",
  /**
   * A narrow column beside the player canvas. Its host mount occupies no space
   * until a visible view is registered, so an editor with none is unchanged.
   */
  "player-aside",
  /**
   * The dock between the player and the timeline, where the video scopes live.
   * It is user-toggled: unlike the sidebars, an empty selection means closed
   * rather than "fall back to the first tab".
   */
  "bottom-dock",
] as const;

export type HostViewRegion = (typeof HOST_VIEW_REGIONS)[number];

export interface ShellViewComponentProps {
  readonly viewId: string;
  readonly region: HostViewRegion;
  readonly active: boolean;
}

export interface HostViewDefinition {
  readonly id: string;
  readonly title: string;
  readonly icon?: () => ReactNode;
  readonly defaultRegion: HostViewRegion;
  /**
   * Dock regions the user may move this panel to. Must contain
   * `defaultRegion`, which must itself be a dock region. Omitted means the
   * panel stays where it registered, which is what every non-portable view and
   * every extension view does today (plan §6).
   */
  readonly allowedRegions?: readonly DockRegion[];
  readonly order?: number;
  readonly when?: ExtensionContextKeyExpression;
  readonly keepMounted?: boolean;
  /** Mount even before the first activation (for stateful built-in defaults). */
  readonly eager?: boolean;
  readonly component: (props: ShellViewComponentProps) => ReactNode;
}

export interface ShellViewEntry extends HostViewDefinition {
  readonly order: number;
  readonly keepMounted: boolean;
  readonly eager: boolean;
  /**
   * Normalized, deduplicated, and ordered by `DOCK_REGIONS`. Empty for a view
   * outside the docking model, such as one in `projects-page.main`. More than
   * one entry marks the panel as portable, which is what earns it a stable
   * mount host and a move control.
   */
  readonly allowedRegions: readonly DockRegion[];
  readonly source: "host" | "extension";
}

interface PersistedViewLayout {
  readonly version: 1;
  readonly hidden: readonly string[];
  readonly order: Readonly<Partial<Record<HostViewRegion, readonly string[]>>>;
}

interface ViewLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const HOST_VIEW_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;
const CONTRIBUTED_VIEW_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const LAYOUT_STORAGE_KEY = "vlo.shell.view-layout.v1";

function getDefaultStorage(): ViewLayoutStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isRegion(value: unknown): value is HostViewRegion {
  return HOST_VIEW_REGIONS.includes(value as HostViewRegion);
}

function readLayout(storage: ViewLayoutStorage | null): PersistedViewLayout {
  const empty: PersistedViewLayout = { version: 1, hidden: [], order: {} };
  if (!storage) return empty;
  try {
    const raw = storage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return empty;
    }
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1 || !Array.isArray(candidate.hidden)) return empty;
    const hidden = candidate.hidden.filter(
      (id): id is string => typeof id === "string",
    );
    const orderValue = candidate.order;
    const order: Partial<Record<HostViewRegion, readonly string[]>> = {};
    if (typeof orderValue === "object" && orderValue !== null) {
      for (const [region, ids] of Object.entries(orderValue)) {
        if (!isRegion(region) || !Array.isArray(ids)) continue;
        order[region] = ids.filter(
          (id): id is string => typeof id === "string",
        );
      }
    }
    return { version: 1, hidden, order };
  } catch {
    return empty;
  }
}

/**
 * Portability is opt-in and validated once, here, so the layout kernel can
 * treat `allowedRegions` as trustworthy and the resolver never has to reason
 * about a default the panel does not permit.
 */
function normalizeAllowedRegions(
  definition: HostViewDefinition,
  id: string,
): readonly DockRegion[] {
  const { allowedRegions, defaultRegion } = definition;
  if (allowedRegions === undefined) {
    return isDockRegion(defaultRegion) ? Object.freeze([defaultRegion]) : [];
  }
  if (!Array.isArray(allowedRegions) || allowedRegions.length === 0) {
    throw new Error(`View '${id}' allowedRegions must be a non-empty array.`);
  }
  for (const region of allowedRegions) {
    if (!isDockRegion(region)) {
      throw new Error(`View '${id}' cannot be moved to region '${region}'.`);
    }
  }
  if (!isDockRegion(defaultRegion)) {
    throw new Error(
      `View '${id}' cannot declare allowedRegions outside the dock regions.`,
    );
  }
  if (!allowedRegions.includes(defaultRegion)) {
    throw new Error(
      `View '${id}' allowedRegions must include its default region '${defaultRegion}'.`,
    );
  }
  // Canonical order keeps move menus and descriptor comparisons stable no
  // matter how the registration happened to spell the list.
  return Object.freeze(
    DOCK_REGIONS.filter((region) => allowedRegions.includes(region)),
  );
}

function assertTitle(title: string, id: string): string {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error(`View '${id}' title must be a non-empty string.`);
  }
  const normalized = title.trim();
  if (normalized.length > 80) {
    throw new Error(`View '${id}' title must be at most 80 characters.`);
  }
  return normalized;
}

/**
 * Selection for the dock regions, once the layout kernel owns placement.
 *
 * A dock panel's region is resolved state from Phase C onwards, so its
 * selection has to live with the resolution rather than in this table — but
 * callers still address a view as "this ID, in this region". Attaching an
 * authority keeps that spelling working while leaving exactly one owner. The
 * dependency points this way, from registry to injected implementation, so the
 * layout kernel can keep reading the registry without a module cycle.
 */
export interface DockRegionSelectionAuthority {
  select(region: DockRegion, viewId: string): boolean;
  getSelected(region: DockRegion): string | null;
  clearSelection(region: DockRegion): void;
}

/**
 * Shell-owned view table and user layout overrides. Features register host
 * views; the extensions adapter registers already-qualified trusted views.
 * The shell knows neither feature ownership nor extension activation scopes.
 */
export class HostViewRegistry {
  private readonly entries = new Map<string, ShellViewEntry>();
  private readonly selected = new Map<HostViewRegion, string>();
  private readonly listeners = new Set<() => void>();
  private readonly storage: ViewLayoutStorage | null;
  private readonly contextKeys: HostContextKeyService;
  private layout: PersistedViewLayout;
  private revision = 0;
  private dockSelection: DockRegionSelectionAuthority | null = null;

  constructor(
    contextKeys: HostContextKeyService = hostContextKeys,
    storage: ViewLayoutStorage | null = getDefaultStorage(),
  ) {
    this.contextKeys = contextKeys;
    this.storage = storage;
    this.layout = readLayout(storage);
  }

  registerHostView(definition: HostViewDefinition): ShellDisposable {
    if (!HOST_VIEW_ID_PATTERN.test(definition.id) || !definition.id.includes(".")) {
      throw new Error(`Invalid host view ID '${definition.id}'.`);
    }
    return this.registerEntry({ ...definition, source: "host" });
  }

  registerEntry(
    definition: HostViewDefinition & { readonly source: "host" | "extension" },
  ): ShellDisposable {
    const { id, source } = definition;
    if (
      (source === "host" && !HOST_VIEW_ID_PATTERN.test(id)) ||
      (source === "extension" && !CONTRIBUTED_VIEW_ID_PATTERN.test(id))
    ) {
      throw new Error(`Invalid ${source} view ID '${id}'.`);
    }
    if (this.entries.has(id)) {
      throw new Error(`View '${id}' is already registered.`);
    }
    if (!isRegion(definition.defaultRegion)) {
      throw new Error(
        `View '${id}' targets unsupported region '${definition.defaultRegion}'.`,
      );
    }
    if (typeof definition.component !== "function") {
      throw new Error(`View '${id}' must provide a component function.`);
    }
    if (definition.icon !== undefined && typeof definition.icon !== "function") {
      throw new Error(`View '${id}' icon must be a component function.`);
    }
    if (definition.when !== undefined) {
      assertContextKeyExpression(definition.when, `View '${id}'`);
    }
    const order = definition.order ?? 0;
    if (!Number.isFinite(order)) {
      throw new Error(`View '${id}' order must be finite.`);
    }
    const entry: ShellViewEntry = Object.freeze({
      ...definition,
      title: assertTitle(definition.title, id),
      order,
      keepMounted: definition.keepMounted ?? source === "extension",
      eager: definition.eager ?? false,
      allowedRegions: normalizeAllowedRegions(definition, id),
    });
    this.entries.set(id, entry);
    this.emitChange();
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.entries.get(id) !== entry) return;
        this.entries.delete(id);
        if (this.selected.get(entry.defaultRegion) === id) {
          this.selected.delete(entry.defaultRegion);
        }
        this.emitChange();
      },
    });
  }

  has(viewId: string): boolean {
    return this.entries.has(viewId);
  }

  get(viewId: string): ShellViewEntry | undefined {
    return this.entries.get(viewId);
  }

  list(
    region: HostViewRegion,
    options: { readonly includeHidden?: boolean; readonly includeUnavailable?: boolean } = {},
  ): readonly ShellViewEntry[] {
    const hidden = new Set(this.layout.hidden);
    const configuredOrder = this.layout.order[region] ?? [];
    const configuredIndex = new Map(
      configuredOrder.map((id, index) => [id, index] as const),
    );
    return [...this.entries.values()]
      .filter((entry) => entry.defaultRegion === region)
      .filter((entry) => options.includeHidden || !hidden.has(entry.id))
      .filter(
        (entry) =>
          options.includeUnavailable ||
          entry.when === undefined ||
          this.contextKeys.evaluate(entry.when),
      )
      .sort((left, right) => {
        const leftIndex = configuredIndex.get(left.id);
        const rightIndex = configuredIndex.get(right.id);
        if (leftIndex !== undefined || rightIndex !== undefined) {
          if (leftIndex === undefined) return 1;
          if (rightIndex === undefined) return -1;
          if (leftIndex !== rightIndex) return leftIndex - rightIndex;
        }
        return left.order - right.order || left.id.localeCompare(right.id);
      });
  }

  isUserVisible(viewId: string): boolean {
    return !this.layout.hidden.includes(viewId);
  }

  setUserVisible(viewId: string, visible: boolean): void {
    const entry = this.entries.get(viewId);
    if (!entry) throw new Error(`View '${viewId}' is not registered.`);
    const hidden = new Set(this.layout.hidden);
    if (visible) hidden.delete(viewId);
    else hidden.add(viewId);
    if (hidden.size === this.layout.hidden.length) return;
    this.layout = { ...this.layout, hidden: [...hidden] };
    if (!visible && this.selected.get(entry.defaultRegion) === viewId) {
      this.selected.delete(entry.defaultRegion);
    }
    this.persistAndEmit();
  }

  move(viewId: string, delta: -1 | 1): void {
    const entry = this.entries.get(viewId);
    if (!entry) throw new Error(`View '${viewId}' is not registered.`);
    const ids = this.list(entry.defaultRegion, {
      includeHidden: true,
      includeUnavailable: true,
    }).map((candidate) => candidate.id);
    const current = ids.indexOf(viewId);
    const target = Math.max(0, Math.min(ids.length - 1, current + delta));
    if (current < 0 || current === target) return;
    ids.splice(current, 1);
    ids.splice(target, 0, viewId);
    this.layout = {
      ...this.layout,
      order: { ...this.layout.order, [entry.defaultRegion]: ids },
    };
    this.persistAndEmit();
  }

  resetRegion(region: HostViewRegion): void {
    const ids = new Set(
      this.list(region, { includeHidden: true, includeUnavailable: true }).map(
        (entry) => entry.id,
      ),
    );
    const order = { ...this.layout.order };
    delete order[region];
    this.layout = {
      version: 1,
      hidden: this.layout.hidden.filter((id) => !ids.has(id)),
      order,
    };
    this.persistAndEmit();
  }

  /**
   * Hands dock-region selection to the layout kernel. Called once for the
   * application registry; a registry constructed for a test keeps the built-in
   * behaviour so it stays self-contained.
   */
  attachDockSelectionAuthority(authority: DockRegionSelectionAuthority): void {
    this.dockSelection = authority;
  }

  select(region: HostViewRegion, viewId: string): boolean {
    if (this.dockSelection && isDockRegion(region)) {
      return this.dockSelection.select(region, viewId);
    }
    const entry = this.entries.get(viewId);
    if (
      !entry ||
      entry.defaultRegion !== region ||
      !this.isUserVisible(viewId) ||
      (entry.when !== undefined && !this.contextKeys.evaluate(entry.when))
    ) {
      return false;
    }
    if (this.selected.get(region) === viewId) return true;
    this.selected.set(region, viewId);
    this.emitChange();
    return true;
  }

  getSelected(region: HostViewRegion): string | null {
    if (this.dockSelection && isDockRegion(region)) {
      return this.dockSelection.getSelected(region);
    }
    const id = this.selected.get(region);
    if (!id) return null;
    return this.list(region).some((entry) => entry.id === id) ? id : null;
  }

  /** Host lifecycle/test seam; contributed APIs can only select their own view. */
  clearSelection(region: HostViewRegion): void {
    if (this.dockSelection && isDockRegion(region)) {
      this.dockSelection.clearSelection(region);
      return;
    }
    if (!this.selected.delete(region)) return;
    this.emitChange();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.revision;
  }

  private persistAndEmit(): void {
    try {
      this.storage?.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(this.layout));
    } catch {
      // The in-memory user layout still works if storage is unavailable.
    }
    this.emitChange();
  }

  private emitChange(): void {
    this.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // View observers are derived render notifications only.
      }
    }
  }
}

export const hostViewRegistry = new HostViewRegistry();
