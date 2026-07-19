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
  readonly "timeline.marker.context": {
    readonly slot: "timeline.marker.context";
    readonly marker: {
      readonly id: string;
      readonly sourceTimeTicks: number;
      readonly kind: "marker" | "beat";
    };
    /** The clip carrying the marker. */
    readonly clip: ExtensionTimelineClipSnapshot;
  };
  readonly "timeline.track.context": {
    readonly slot: "timeline.track.context";
    readonly track: {
      readonly id: string;
      readonly label: string;
      readonly type: string;
      readonly isVisible: boolean;
      readonly isMuted: boolean;
      readonly isLocked: boolean;
    };
  };
  readonly "library.item.actions": {
    readonly slot: "library.item.actions";
    readonly asset: ExtensionEntityAssetSnapshot;
  };
  readonly "library.browser.context": {
    readonly slot: "library.browser.context";
    /** Detached view state of the browser pane the user right-clicked. */
    readonly browser: {
      readonly assetType: string;
      readonly assetCount: number;
      readonly showFavouritesOnly: boolean;
      readonly sortOption: string;
    };
  };
  readonly "player.canvas.context": {
    readonly slot: "player.canvas.context";
    readonly player: {
      readonly playing: boolean;
      readonly fullscreen: boolean;
    };
  };
  readonly "app.project.settings": {
    readonly slot: "app.project.settings";
    /** Effective settings (defaults applied), detached. */
    readonly project: {
      readonly fps: number;
      readonly aspectRatio: string;
      readonly fitMode: string;
      readonly layoutMode: string;
      readonly assetBrowserDisplay: string;
    };
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

function isClipSnapshot(clip: unknown): boolean {
  return (
    isRecord(clip) &&
    hasStringFields(clip, ["id", "type", "name"]) &&
    typeof clip.startTicks === "number" &&
    typeof clip.durationTicks === "number" &&
    Array.isArray(clip.transformations)
  );
}

/** Subject: `{ slot, clip: ExtensionTimelineClipSnapshot }`. */
function validateClipContextSubject(subject: unknown): boolean {
  return (
    isRecord(subject) &&
    subject.slot === "timeline.clip.context" &&
    isClipSnapshot(subject.clip)
  );
}

/** Subject: `{ slot, marker: { id, sourceTimeTicks, kind }, clip }`. */
function validateMarkerContextSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "timeline.marker.context") {
    return false;
  }
  const marker = subject.marker;
  return (
    isRecord(marker) &&
    typeof marker.id === "string" &&
    typeof marker.sourceTimeTicks === "number" &&
    (marker.kind === "marker" || marker.kind === "beat") &&
    isClipSnapshot(subject.clip)
  );
}

/** Subject: `{ slot, track: { id, label, type, flags } }`. */
function validateTrackContextSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "timeline.track.context") {
    return false;
  }
  const track = subject.track;
  return (
    isRecord(track) &&
    hasStringFields(track, ["id", "label", "type"]) &&
    typeof track.isVisible === "boolean" &&
    typeof track.isMuted === "boolean" &&
    typeof track.isLocked === "boolean"
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

/** Subject: `{ slot, browser: detached browser view state }`. */
function validateLibraryBrowserSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "library.browser.context") {
    return false;
  }
  const browser = subject.browser;
  return (
    isRecord(browser) &&
    hasStringFields(browser, ["assetType", "sortOption"]) &&
    typeof browser.assetCount === "number" &&
    typeof browser.showFavouritesOnly === "boolean"
  );
}

/** Subject: `{ slot, player: { playing, fullscreen } }`. */
function validatePlayerCanvasSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "player.canvas.context") {
    return false;
  }
  const player = subject.player;
  return (
    isRecord(player) &&
    typeof player.playing === "boolean" &&
    typeof player.fullscreen === "boolean"
  );
}

/** Subject: `{ slot, project: effective settings snapshot }`. */
function validateProjectSettingsSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "app.project.settings") {
    return false;
  }
  const project = subject.project;
  return (
    isRecord(project) &&
    typeof project.fps === "number" &&
    hasStringFields(project, [
      "aspectRatio",
      "fitMode",
      "layoutMode",
      "assetBrowserDisplay",
    ])
  );
}

// Exhaustive over HostMenuSubjectMap: a subject-map entry without a validator
// (or a validator for an unmapped menu) fails to compile.
const HOST_MENU_SUBJECT_VALIDATORS = {
  "timeline.clip.context": validateClipContextSubject,
  "timeline.marker.context": validateMarkerContextSubject,
  "timeline.track.context": validateTrackContextSubject,
  "library.item.actions": validateLibraryItemSubject,
  "library.browser.context": validateLibraryBrowserSubject,
  "player.canvas.context": validatePlayerCanvasSubject,
  "app.project.settings": validateProjectSettingsSubject,
} satisfies Record<HostMenuId, (subject: unknown) => boolean>;

const CLIP_SNAPSHOT_SCHEMA = {
  id: "string",
  type: "string",
  name: "string",
  trackId: "string",
  startTicks: "number",
  durationTicks: "number",
  transformations: "array",
};

// Serialisable subject descriptions surfaced through `menus.listMenus()`
// discovery. Documentation-grade (field path → type name); the validators
// above are authoritative.
const HOST_MENU_SUBJECT_SCHEMAS = {
  "timeline.clip.context": {
    slot: "'timeline.clip.context'",
    clip: CLIP_SNAPSHOT_SCHEMA,
  },
  "timeline.marker.context": {
    slot: "'timeline.marker.context'",
    marker: {
      id: "string",
      sourceTimeTicks: "number",
      kind: "'marker' | 'beat'",
    },
    clip: CLIP_SNAPSHOT_SCHEMA,
  },
  "timeline.track.context": {
    slot: "'timeline.track.context'",
    track: {
      id: "string",
      label: "string",
      type: "string",
      isVisible: "boolean",
      isMuted: "boolean",
      isLocked: "boolean",
    },
  },
  "library.item.actions": {
    slot: "'library.item.actions'",
    asset: { id: "string", name: "string", type: "string" },
  },
  "library.browser.context": {
    slot: "'library.browser.context'",
    browser: {
      assetType: "string",
      assetCount: "number",
      showFavouritesOnly: "boolean",
      sortOption: "string",
    },
  },
  "player.canvas.context": {
    slot: "'player.canvas.context'",
    player: { playing: "boolean", fullscreen: "boolean" },
  },
  "app.project.settings": {
    slot: "'app.project.settings'",
    project: {
      fps: "number",
      aspectRatio: "string",
      fitMode: "string",
      layoutMode: "string",
      assetBrowserDisplay: "string",
    },
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
