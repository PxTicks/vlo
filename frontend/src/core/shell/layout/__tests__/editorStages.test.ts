/**
 * Stage resolution and the session composition that overrides it
 * (docs/configurable-docking-and-dedicated-workspaces-plan.md §7 Phase D, §8.1).
 */
import { describe, expect, it, vi } from "vitest";
import { createMemoryShellLayoutPersistence } from "../layoutPersistence";
import { resolveShellLayout } from "../layoutResolver";
import { createShellLayoutStore } from "../useShellLayoutStore";
import type {
  EditorStageSurfaces,
  ShellLayoutDocumentV2,
  ShellSurfaceDescriptor,
} from "../layoutTypes";

function surface(
  id: string,
  overrides: Partial<ShellSurfaceDescriptor> = {},
): ShellSurfaceDescriptor {
  const defaultStage = overrides.defaultStage ?? "main-stage";
  return {
    id,
    defaultStage,
    allowedStages: [defaultStage],
    defaultOrder: 0,
    available: true,
    ...overrides,
  };
}

const EMPTY_DOCUMENT: ShellLayoutDocumentV2 = {
  version: 2,
  panels: {},
  regions: {},
  workspaceLayouts: {},
};

function resolveStages(
  surfaces: readonly ShellSurfaceDescriptor[],
  stageSurfaces?: EditorStageSurfaces,
) {
  return resolveShellLayout({
    panels: [],
    surfaces,
    document: EMPTY_DOCUMENT,
    stageSurfaces,
  }).stages;
}

const PLAYER = surface("host.player", { defaultOrder: 0 });
const PREVIEW = surface("host.compact-preview", { defaultOrder: 10 });
const TIMELINE = surface("host.timeline", {
  defaultStage: "lower-stage",
  defaultOrder: 0,
});

describe("editor stage resolution", () => {
  it("mounts the lowest-ordered surface registered for each stage", () => {
    const stages = resolveStages([PREVIEW, TIMELINE, PLAYER]);

    expect(stages["main-stage"]).toEqual({
      id: "main-stage",
      surfaceId: "host.player",
      candidateSurfaceIds: ["host.player", "host.compact-preview"],
    });
    expect(stages["lower-stage"].surfaceId).toBe("host.timeline");
  });

  it("leaves a stage empty rather than borrowing another stage's surface", () => {
    // A surface merely *allowed* in a stage is a workspace's choice to make,
    // never the editor's default — otherwise unregistering the player would
    // drop the timeline into the picture area.
    const portable = surface("host.timeline", {
      defaultStage: "lower-stage",
      allowedStages: ["lower-stage", "main-stage"],
    });

    const stages = resolveStages([portable]);

    expect(stages["main-stage"]).toEqual({
      id: "main-stage",
      surfaceId: null,
      candidateSurfaceIds: ["host.timeline"],
    });
    expect(stages["lower-stage"].surfaceId).toBe("host.timeline");
  });

  it("honours a session composition over the stage default", () => {
    const stages = resolveStages([PLAYER, PREVIEW, TIMELINE], {
      "main-stage": "host.compact-preview",
    });

    expect(stages["main-stage"].surfaceId).toBe("host.compact-preview");
    expect(stages["lower-stage"].surfaceId).toBe("host.timeline");
  });

  it("falls back when a composition names a surface it cannot have", () => {
    const unavailable = surface("host.scopes-stage", { available: false });

    expect(
      resolveStages([PLAYER, unavailable], { "main-stage": "host.scopes-stage" })[
        "main-stage"
      ].surfaceId,
    ).toBe("host.player");
    expect(
      resolveStages([PLAYER, TIMELINE], { "main-stage": "host.timeline" })[
        "main-stage"
      ].surfaceId,
    ).toBe("host.player");
    expect(
      resolveStages([PLAYER], { "main-stage": "host.gone" })["main-stage"]
        .surfaceId,
    ).toBe("host.player");
  });

  it("skips unavailable surfaces entirely", () => {
    const stages = resolveStages([
      { ...PLAYER, available: false },
      PREVIEW,
      TIMELINE,
    ]);

    expect(stages["main-stage"]).toEqual({
      id: "main-stage",
      surfaceId: "host.compact-preview",
      candidateSurfaceIds: ["host.compact-preview"],
    });
  });

  it("resolves to empty stages with nothing registered", () => {
    const stages = resolveStages([]);

    expect(stages["main-stage"].surfaceId).toBeNull();
    expect(stages["lower-stage"].surfaceId).toBeNull();
  });
});

describe("stage composition actions", () => {
  function createStore(
    surfaces: readonly ShellSurfaceDescriptor[] = [PLAYER, PREVIEW, TIMELINE],
  ) {
    const cancelSurfaceInteractions = vi.fn();
    const store = createShellLayoutStore({
      persistence: createMemoryShellLayoutPersistence(),
      surfaces,
      cancelSurfaceInteractions,
    });
    return { store, cancelSurfaceInteractions };
  }

  it("mounts a permitted surface and returns to the default", () => {
    const { store } = createStore();

    expect(store.getState().setStageSurface("main-stage", "host.compact-preview"))
      .toBe(true);
    expect(store.getState().resolved.stages["main-stage"].surfaceId).toBe(
      "host.compact-preview",
    );

    expect(store.getState().setStageSurface("main-stage", null)).toBe(true);
    expect(store.getState().resolved.stages["main-stage"].surfaceId).toBe(
      "host.player",
    );
  });

  it("refuses a surface that does not permit the stage", () => {
    const { store } = createStore();

    expect(store.getState().setStageSurface("main-stage", "host.timeline")).toBe(
      false,
    );
    expect(store.getState().setStageSurface("main-stage", "host.missing")).toBe(
      false,
    );
    expect(store.getState().resolved.stages["main-stage"].surfaceId).toBe(
      "host.player",
    );
  });

  it("cancels the outgoing surface's interactions before the swap lands", () => {
    const { store, cancelSurfaceInteractions } = createStore();

    store.getState().setStageSurface("main-stage", "host.compact-preview");

    expect(cancelSurfaceInteractions).toHaveBeenCalledExactlyOnceWith(
      "host.player",
    );

    // Re-selecting what is already mounted changes nothing, so nothing is
    // cancelled: a no-op composition must not interrupt a live edit.
    cancelSurfaceInteractions.mockClear();
    store.getState().setStageSurface("main-stage", "host.compact-preview");
    expect(cancelSurfaceInteractions).not.toHaveBeenCalled();

    store.getState().clearStageSurfaces();
    expect(cancelSurfaceInteractions).toHaveBeenCalledExactlyOnceWith(
      "host.compact-preview",
    );
  });

  it("keeps the composition out of the persisted document", () => {
    const persistence = createMemoryShellLayoutPersistence();
    const store = createShellLayoutStore({
      persistence,
      surfaces: [PLAYER, PREVIEW, TIMELINE],
    });

    store.getState().setStageSurface("main-stage", "host.compact-preview");
    store.getState().flushPersistence();

    expect(JSON.stringify(persistence.read())).not.toContain("compact-preview");
  });

  it("re-resolves when a mounted surface is unregistered", () => {
    const { store } = createStore();
    store.getState().setStageSurface("main-stage", "host.compact-preview");

    store.getState().setSurfaceDescriptors([PLAYER, TIMELINE]);

    expect(store.getState().resolved.stages["main-stage"].surfaceId).toBe(
      "host.player",
    );
  });
});
