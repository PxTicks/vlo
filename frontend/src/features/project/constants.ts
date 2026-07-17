export const CURRENT_PROJECT_SCHEMA_VERSION = 2;
const STABLE_APP_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function normalizeAppVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!STABLE_APP_VERSION_PATTERN.test(normalized) || normalized === "0.0.0") {
    return null;
  }
  return normalized;
}

/** Unknown build metadata is explicit; it must not become compatibility data. */
export const VLO_APP_VERSION = normalizeAppVersion(
  import.meta.env.VITE_APP_VERSION,
);

export const PROJECT_MANIFEST_SCHEMA_VERSION = 3;
export const TIMELINE_DOCUMENT_SCHEMA_VERSION = 3;
export const ASSET_INDEX_DOCUMENT_SCHEMA_VERSION = 1;
export const ASSET_METADATA_DOCUMENT_SCHEMA_VERSION = 1;
export const COMPOSITE_LIBRARY_DOCUMENT_SCHEMA_VERSION = 2;
