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
  readonly "masks.add.options": {
    readonly slot: "masks.add.options";
    /** The clip the new mask would attach to. */
    readonly target: {
      readonly clipId: string;
      readonly maskCount: number;
    };
  };
  readonly "transformations.path.add": {
    readonly slot: "transformations.path.add";
    /** The clip a position path would be created for. */
    readonly target: {
      readonly clipId: string;
      readonly trackableMaskCount: number;
    };
  };
  readonly "generation.generate.options": {
    readonly slot: "generation.generate.options";
    readonly generation: {
      readonly workflowId: string | null;
    };
  };
  readonly "app.view.select": {
    readonly slot: "app.view.select";
    readonly region: {
      readonly id: string;
      readonly selectedViewId: string | null;
    };
  };
  /** Placement targets for one panel (docking plan §4.7). */
  readonly "app.view.move": {
    readonly slot: "app.view.move";
    readonly view: {
      readonly id: string;
      /** The region the panel is in now. */
      readonly region: string;
    };
  };
  readonly "library.item.actions": {
    readonly slot: "library.item.actions";
    readonly asset: ExtensionEntityAssetSnapshot;
  };
  readonly "library.composite.actions": {
    readonly slot: "library.composite.actions";
    readonly composite: {
      readonly id: string;
      readonly name: string;
      readonly durationTicks: number;
      readonly bakeStatus: string;
    };
  };
  readonly "library.sort.options": {
    readonly slot: "library.sort.options";
    readonly browser: {
      readonly sortOption: string;
    };
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
  readonly "app.settings": {
    readonly slot: "app.settings";
    /**
     * Application-scoped runtime state, detached. Persisted install-wide in
     * `app_settings.json`, so this subject is deliberately project-free.
     */
    readonly app: {
      readonly workflowMode: string;
      readonly comfyuiConfigured: boolean;
    };
  };
  readonly "projects.item.context": {
    readonly slot: "projects.item.context";
    readonly project: {
      readonly id: string;
      readonly name: string;
      readonly lastOpened: number;
      /** Opaque recent-project lookup token; never a file handle. */
      readonly pathToken: string;
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

/** Subject: `{ slot, target: { clipId, maskCount } }`. */
function validateMasksAddSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "masks.add.options") return false;
  const target = subject.target;
  return (
    isRecord(target) &&
    typeof target.clipId === "string" &&
    Number.isInteger(target.maskCount) &&
    Number(target.maskCount) >= 0
  );
}

/** Subject: `{ slot, target: { clipId, trackableMaskCount } }`. */
function validatePathAddSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "transformations.path.add") {
    return false;
  }
  const target = subject.target;
  return (
    isRecord(target) &&
    typeof target.clipId === "string" &&
    Number.isInteger(target.trackableMaskCount) &&
    Number(target.trackableMaskCount) >= 0
  );
}

/** Subject: `{ slot, generation: { workflowId } }`. */
function validateGenerateOptionsSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "generation.generate.options") {
    return false;
  }
  const generation = subject.generation;
  return (
    isRecord(generation) &&
    (typeof generation.workflowId === "string" ||
      generation.workflowId === null)
  );
}

/** Subject: `{ slot, region: { id, selectedViewId } }`. */
function validateViewSelectSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "app.view.select") {
    return false;
  }
  const region = subject.region;
  return (
    isRecord(region) &&
    typeof region.id === "string" &&
    (typeof region.selectedViewId === "string" ||
      region.selectedViewId === null)
  );
}

/** Subject: `{ slot, view: { id, region } }`. */
function validateViewMoveSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "app.view.move") return false;
  const view = subject.view;
  return isRecord(view) && hasStringFields(view, ["id", "region"]);
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

/** Subject: `{ slot, composite: detached composite library item }`. */
function validateLibraryCompositeSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "library.composite.actions") {
    return false;
  }
  const composite = subject.composite;
  return (
    isRecord(composite) &&
    hasStringFields(composite, ["id", "name", "bakeStatus"]) &&
    typeof composite.durationTicks === "number" &&
    Number.isFinite(composite.durationTicks)
  );
}

/** Subject: `{ slot, browser: { sortOption } }`. */
function validateLibrarySortSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "library.sort.options") {
    return false;
  }
  const browser = subject.browser;
  return isRecord(browser) && typeof browser.sortOption === "string";
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

/** Subject: `{ slot, app: install-wide runtime snapshot }`. */
function validateAppSettingsSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "app.settings") {
    return false;
  }
  const app = subject.app;
  return (
    isRecord(app) &&
    typeof app.workflowMode === "string" &&
    typeof app.comfyuiConfigured === "boolean"
  );
}

/** Subject: `{ slot, project: detached recent-project descriptor }`. */
function validateProjectsItemSubject(subject: unknown): boolean {
  if (!isRecord(subject) || subject.slot !== "projects.item.context") {
    return false;
  }
  const project = subject.project;
  return (
    isRecord(project) &&
    hasStringFields(project, ["id", "name", "pathToken"]) &&
    typeof project.lastOpened === "number" &&
    Number.isFinite(project.lastOpened)
  );
}

// Exhaustive over HostMenuSubjectMap: a subject-map entry without a validator
// (or a validator for an unmapped menu) fails to compile.
const HOST_MENU_SUBJECT_VALIDATORS = {
  "timeline.clip.context": validateClipContextSubject,
  "timeline.marker.context": validateMarkerContextSubject,
  "timeline.track.context": validateTrackContextSubject,
  "masks.add.options": validateMasksAddSubject,
  "transformations.path.add": validatePathAddSubject,
  "generation.generate.options": validateGenerateOptionsSubject,
  "app.view.select": validateViewSelectSubject,
  "app.view.move": validateViewMoveSubject,
  "library.item.actions": validateLibraryItemSubject,
  "library.composite.actions": validateLibraryCompositeSubject,
  "library.sort.options": validateLibrarySortSubject,
  "library.browser.context": validateLibraryBrowserSubject,
  "player.canvas.context": validatePlayerCanvasSubject,
  "app.project.settings": validateProjectSettingsSubject,
  "app.settings": validateAppSettingsSubject,
  "projects.item.context": validateProjectsItemSubject,
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
  "masks.add.options": {
    slot: "'masks.add.options'",
    target: { clipId: "string", maskCount: "number" },
  },
  "transformations.path.add": {
    slot: "'transformations.path.add'",
    target: { clipId: "string", trackableMaskCount: "number" },
  },
  "generation.generate.options": {
    slot: "'generation.generate.options'",
    generation: { workflowId: "string | null" },
  },
  "app.view.select": {
    slot: "'app.view.select'",
    region: { id: "string", selectedViewId: "string | null" },
  },
  "app.view.move": {
    slot: "'app.view.move'",
    view: { id: "string", region: "string" },
  },
  "library.item.actions": {
    slot: "'library.item.actions'",
    asset: { id: "string", name: "string", type: "string" },
  },
  "library.composite.actions": {
    slot: "'library.composite.actions'",
    composite: {
      id: "string",
      name: "string",
      durationTicks: "number",
      bakeStatus: "string",
    },
  },
  "library.sort.options": {
    slot: "'library.sort.options'",
    browser: { sortOption: "string" },
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
  "app.settings": {
    slot: "'app.settings'",
    app: {
      workflowMode: "'default' | 'high_vram'",
      comfyuiConfigured: "boolean",
    },
  },
  "projects.item.context": {
    slot: "'projects.item.context'",
    project: {
      id: "string",
      name: "string",
      lastOpened: "number",
      pathToken: "string (opaque)",
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
