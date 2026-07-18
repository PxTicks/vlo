import { hostMenuCatalog } from "../../../core/shell/hostMenuCatalog";

/**
 * The host menu catalogue. Every menu rendered through `AppMenu` (or shown
 * via the shell context-menu service) is declared here — one entry per menu,
 * with a structural schema for the detached subject it carries. Declaring is
 * what makes a menu a valid target for extension `ui.registerMenuItem`
 * contributions; adding a menu touches only this file, never SDK types. Menu
 * IDs are contract once shipped: they become registration targets and
 * documentation references, so rename them with the same care as SDK types.
 */
export const HOST_MENU_IDS = [
  "timeline.clip.context",
  "library.item.actions",
] as const;

export type HostMenuId = (typeof HOST_MENU_IDS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStringFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => typeof value[field] === "string");
}

/** Subject: `{ slot, clip: ExtensionTimelineClipSnapshot }`. */
function validateClipContextSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "timeline.clip.context") {
    return false;
  }
  const clip = subject.clip;
  return (
    isRecord(clip) &&
    hasStringFields(clip, ["id", "type", "name"]) &&
    typeof clip.startTicks === "number" &&
    typeof clip.durationTicks === "number" &&
    Array.isArray(clip.transformations)
  );
}

/** Subject: `{ slot, asset: ExtensionEntityAssetSnapshot }`. */
function validateLibraryItemSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "library.item.actions") {
    return false;
  }
  const asset = subject.asset;
  return isRecord(asset) && hasStringFields(asset, ["id", "name", "type"]);
}

hostMenuCatalog.declare({
  id: "timeline.clip.context",
  validateSubject: validateClipContextSubject,
});
hostMenuCatalog.declare({
  id: "library.item.actions",
  validateSubject: validateLibraryItemSubject,
});
