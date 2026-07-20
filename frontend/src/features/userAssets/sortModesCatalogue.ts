import { hostOptionCatalog } from "../../core/shell/optionCatalog";
import type { Asset } from "../../types/Asset";

/**
 * The `library.sort-modes` option catalogue (plan §3.7): sorting strategies
 * for the asset browser as data. A mode's value names an asset field and a
 * direction the host executes — extensions contribute new orderings over
 * those fields declaratively; richer, storage-driven keys (e.g. sort by an
 * extension's tags) need a dedicated contract and are not modelled here.
 */
export const LIBRARY_SORT_MODES_CATALOGUE = "library.sort-modes";

const SORT_FIELDS = ["createdAt", "name"] as const;
type SortField = (typeof SORT_FIELDS)[number];

export interface LibrarySortMode {
  readonly field: SortField;
  readonly direction: "asc" | "desc";
}

export function isLibrarySortMode(value: unknown): value is LibrarySortMode {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { field?: unknown; direction?: unknown };
  return (
    (SORT_FIELDS as readonly unknown[]).includes(candidate.field) &&
    (candidate.direction === "asc" || candidate.direction === "desc")
  );
}

export const DEFAULT_LIBRARY_SORT_MODE_ID = "date-desc";

let declared = false;

/**
 * Populates the catalogue. Idempotent; executed value-level by the asset
 * browser module so consumers never depend on bootstrap import order (the
 * same pattern as `declareHostMenus`).
 */
export function declareLibrarySortModes(): void {
  if (declared) return;
  declared = true;
  hostOptionCatalog.declare({
    id: LIBRARY_SORT_MODES_CATALOGUE,
    validateValue: isLibrarySortMode,
    valueSchema: {
      field: "'createdAt' | 'name'",
      direction: "'asc' | 'desc'",
    },
  });
  hostOptionCatalog.registerHostOption(LIBRARY_SORT_MODES_CATALOGUE, {
    id: "date-desc",
    label: "Newest First",
    value: { field: "createdAt", direction: "desc" },
    order: 0,
  });
  hostOptionCatalog.registerHostOption(LIBRARY_SORT_MODES_CATALOGUE, {
    id: "date-asc",
    label: "Oldest First",
    value: { field: "createdAt", direction: "asc" },
    order: 1,
  });
  hostOptionCatalog.registerHostOption(LIBRARY_SORT_MODES_CATALOGUE, {
    id: "name-asc",
    label: "Name (A-Z)",
    value: { field: "name", direction: "asc" },
    order: 2,
  });
}

const FALLBACK_MODE: LibrarySortMode = { field: "createdAt", direction: "desc" };

/**
 * Comparator for one resolved sort-mode value. An unknown or missing value
 * (e.g. a mode whose providing extension is gone) falls back to newest-first
 * without the consumer discarding its selected ID — selection state stays
 * recoverable.
 */
export function compareAssetsBySortValue(
  value: unknown,
  left: Asset,
  right: Asset,
): number {
  const mode = isLibrarySortMode(value) ? value : FALLBACK_MODE;
  const direction = mode.direction === "asc" ? 1 : -1;
  if (mode.field === "name") {
    return direction * left.name.localeCompare(right.name);
  }
  return direction * ((left.createdAt || 0) - (right.createdAt || 0));
}
