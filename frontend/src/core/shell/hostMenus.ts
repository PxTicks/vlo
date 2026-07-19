import type {
  ExtensionEntityAssetSnapshot,
  ExtensionTimelineClipSnapshot,
  JsonValue,
} from "@vlo/extension-sdk";
import { hostMenuCatalog } from "./hostMenuCatalog";

/**
 * The host menu catalogue declarations. Every menu rendered through `AppMenu`
 * (or shown via the shell context-menu service) is declared here — one entry
 * per menu, with a structural schema for the detached subject it carries.
 * Declaring is what makes a menu a valid target for extension menu
 * placements (`ui.menus.addItem`); adding a menu touches only this file,
 * never SDK types. Menu IDs are contract once shipped: they become
 * registration targets and documentation references, so rename them with the
 * same care as SDK types.
 */

/**
 * Host-side source of truth for each catalogued menu's subject type
 * (§3.10 review finding 2). The SDK carries no closed union of menu
 * subjects: new menus are typed by adding an entry here (plus a validator
 * and schema description below) and resolve without touching the SDK.
 * Subjects must stay detached and JSON-serialisable — they cross the
 * extension boundary as `JsonValue`.
 */
export interface HostMenuSubjectMap {
  readonly "timeline.clip.context": {
    readonly slot: "timeline.clip.context";
    readonly clip: ExtensionTimelineClipSnapshot;
  };
  readonly "library.item.actions": {
    readonly slot: "library.item.actions";
    readonly asset: ExtensionEntityAssetSnapshot;
  };
}

export type HostMenuId = keyof HostMenuSubjectMap;

/** The subject shape belonging to one catalogued menu ID. */
export type HostMenuSubject<TMenuId extends HostMenuId> =
  HostMenuSubjectMap[TMenuId];

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

// Exhaustive over HostMenuSubjectMap: a subject-map entry without a validator
// (or a validator for an unmapped menu) fails to compile.
const HOST_MENU_SUBJECT_VALIDATORS = {
  "timeline.clip.context": validateClipContextSubject,
  "library.item.actions": validateLibraryItemSubject,
} satisfies Record<HostMenuId, (subject: unknown) => boolean>;

// Serialisable subject descriptions surfaced through `menus.listMenus()`
// discovery. Documentation-grade (field path → type name); the validators
// above are authoritative.
const HOST_MENU_SUBJECT_SCHEMAS = {
  "timeline.clip.context": {
    slot: "'timeline.clip.context'",
    clip: {
      id: "string",
      type: "string",
      name: "string",
      trackId: "string",
      startTicks: "number",
      durationTicks: "number",
      transformations: "array",
    },
  },
  "library.item.actions": {
    slot: "'library.item.actions'",
    asset: { id: "string", name: "string", type: "string" },
  },
} satisfies Record<HostMenuId, JsonValue>;

export const HOST_MENU_IDS = Object.freeze(
  Object.keys(HOST_MENU_SUBJECT_VALIDATORS) as HostMenuId[],
);

let declared = false;

/**
 * Populates the shell menu catalogue (§3.10 review finding 1). Idempotent;
 * every shell menu entry point (`AppMenu`, `showHostContextMenu`) executes it
 * value-level at module scope, so a core-only menu render never depends on
 * feature or bootstrap import order.
 */
export function declareHostMenus(): void {
  if (declared) return;
  declared = true;
  for (const id of HOST_MENU_IDS) {
    hostMenuCatalog.declare({
      id,
      validateSubject: HOST_MENU_SUBJECT_VALIDATORS[id],
      subjectSchema: HOST_MENU_SUBJECT_SCHEMAS[id],
    });
  }
}
