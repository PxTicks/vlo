import { Container } from "pixi.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { TimelineGroup } from "../../../../types/TimelineTypes";
import { RenderGroupOrchestrator } from "../RenderGroupOrchestrator";

function group(overrides: Partial<TimelineGroup> & Pick<TimelineGroup, "id">): TimelineGroup {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    trackIds: overrides.trackIds ?? [],
    start: overrides.start ?? 0,
    timelineDuration: overrides.timelineDuration ?? 100,
    transformations: overrides.transformations ?? [],
    isVisible: overrides.isVisible ?? true,
  };
}

interface Fixture {
  root: Container;
  orchestrator: RenderGroupOrchestrator;
  engineByTrackId: Map<string, Container>;
}

function makeFixture(trackIds: string[]): Fixture {
  const root = new Container();
  root.sortableChildren = true;
  const orchestrator = new RenderGroupOrchestrator(root);
  const engineByTrackId = new Map<string, Container>();
  for (const trackId of trackIds) {
    const engineContainer = new Container();
    engineByTrackId.set(trackId, engineContainer);
    orchestrator.registerTrack(trackId, engineContainer);
  }
  return { root, orchestrator, engineByTrackId };
}

describe("RenderGroupOrchestrator", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture(["track-1", "track-2", "track-3"]);
  });

  it("registerTrack parents engine containers under root immediately", () => {
    for (const engineContainer of fx.engineByTrackId.values()) {
      expect(engineContainer.parent).toBe(fx.root);
    }
  });

  it("initial sync with no groups leaves every track parented under root", () => {
    fx.orchestrator.sync(0, ["track-1", "track-2", "track-3"]);
    for (const engineContainer of fx.engineByTrackId.values()) {
      expect(engineContainer.parent).toBe(fx.root);
    }
    // No group containers spawned.
    expect(
      fx.root.children.filter((c) => c !== fx.engineByTrackId.get("track-1")
        && c !== fx.engineByTrackId.get("track-2")
        && c !== fx.engineByTrackId.get("track-3")),
    ).toEqual([]);
  });

  it("assigns zIndex following the top-track = highest-zIndex convention", () => {
    fx.orchestrator.sync(0, ["track-1", "track-2", "track-3"]);
    expect(fx.engineByTrackId.get("track-1")!.zIndex).toBe(2);
    expect(fx.engineByTrackId.get("track-2")!.zIndex).toBe(1);
    expect(fx.engineByTrackId.get("track-3")!.zIndex).toBe(0);
  });

  it("activating a group reparents member engines into a fresh container", () => {
    fx.orchestrator.setGroups([
      group({ id: "g1", trackIds: ["track-1", "track-2"], start: 0, timelineDuration: 100 }),
    ]);
    fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);

    const groupContainer = fx.orchestrator.getGroupContainer("g1");
    expect(groupContainer).not.toBeNull();
    expect(groupContainer!.parent).toBe(fx.root);
    expect(fx.engineByTrackId.get("track-1")!.parent).toBe(groupContainer);
    expect(fx.engineByTrackId.get("track-2")!.parent).toBe(groupContainer);
    // Non-member stays under root.
    expect(fx.engineByTrackId.get("track-3")!.parent).toBe(fx.root);
    // The group container is sortableChildren.
    expect(groupContainer!.sortableChildren).toBe(true);
  });

  it("group container zIndex matches top-most member's z slot", () => {
    fx.orchestrator.setGroups([
      group({ id: "g1", trackIds: ["track-2", "track-3"], start: 0, timelineDuration: 100 }),
    ]);
    fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
    const container = fx.orchestrator.getGroupContainer("g1")!;
    // Top-most member is track-2, visual index 1 -> zIndex = (3 - 1 - 1) = 1.
    expect(container.zIndex).toBe(1);
  });

  it("deactivating a group detaches the container but preserves the instance", () => {
    fx.orchestrator.setGroups([
      group({ id: "g1", trackIds: ["track-1"], start: 0, timelineDuration: 100 }),
    ]);
    fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
    const activeContainer = fx.orchestrator.getGroupContainer("g1");
    expect(activeContainer!.parent).toBe(fx.root);

    fx.orchestrator.sync(200, ["track-1", "track-2", "track-3"]);
    // Same container instance, but detached and child reparented to root.
    expect(fx.orchestrator.getGroupContainer("g1")).toBe(activeContainer);
    expect(activeContainer!.parent).toBeNull();
    expect(activeContainer!.destroyed).toBe(false);
    expect(fx.engineByTrackId.get("track-1")!.parent).toBe(fx.root);
  });

  it("a track participating in two disjoint groups flips parents at the boundary, engine instance stable", () => {
    fx.orchestrator.setGroups([
      group({ id: "early", trackIds: ["track-1", "track-2"], start: 0, timelineDuration: 100 }),
      group({ id: "late",  trackIds: ["track-1", "track-2"], start: 100, timelineDuration: 100 }),
    ]);

    const engine = fx.engineByTrackId.get("track-1")!;

    fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
    const earlyContainer = fx.orchestrator.getGroupContainer("early")!;
    expect(engine.parent).toBe(earlyContainer);

    fx.orchestrator.sync(150, ["track-1", "track-2", "track-3"]);
    const lateContainer = fx.orchestrator.getGroupContainer("late")!;
    expect(engine.parent).toBe(lateContainer);
    // early detaches, late attaches.
    expect(earlyContainer.parent).toBeNull();
    expect(lateContainer.parent).toBe(fx.root);
    // Engine instance unchanged.
    expect(fx.engineByTrackId.get("track-1")).toBe(engine);
  });

  it("setGroups removing a group destroys its container and frees the children on next sync", () => {
    fx.orchestrator.setGroups([
      group({ id: "g1", trackIds: ["track-1"], start: 0, timelineDuration: 100 }),
    ]);
    fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
    const container = fx.orchestrator.getGroupContainer("g1")!;
    expect(container.destroyed).toBe(false);

    fx.orchestrator.setGroups([]);
    expect(fx.orchestrator.getGroupContainer("g1")).toBeNull();
    expect(container.destroyed).toBe(true);

    // Next sync reparents the engine back under root.
    fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
    expect(fx.engineByTrackId.get("track-1")!.parent).toBe(fx.root);
  });

  it("a group with no registered member tracks stays inactive (container detached)", () => {
    fx.orchestrator.setGroups([
      group({ id: "ghost", trackIds: ["nope"], start: 0, timelineDuration: 100 }),
    ]);
    fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
    expect(fx.orchestrator.getGroupContainer("ghost")).toBeNull();
  });

  it("toggling group.isVisible flips container.visible on the next sync", () => {
    fx.orchestrator.setGroups([
      group({
        id: "g1",
        trackIds: ["track-1"],
        start: 0,
        timelineDuration: 100,
        isVisible: false,
      }),
    ]);
    fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
    const container = fx.orchestrator.getGroupContainer("g1")!;
    expect(container.visible).toBe(false);

    fx.orchestrator.setGroups([
      group({ id: "g1", trackIds: ["track-1"], start: 0, timelineDuration: 100, isVisible: true }),
    ]);
    fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
    expect(container.visible).toBe(true);
  });

  it("registerTrack is idempotent for the same (trackId, container) pair", () => {
    const engine = fx.engineByTrackId.get("track-1")!;
    fx.orchestrator.registerTrack("track-1", engine); // double-register
    expect(engine.parent).toBe(fx.root);
    // Only attached once.
    expect(fx.root.children.filter((c) => c === engine)).toHaveLength(1);
  });

  it("registerTrack with a new container for an existing trackId detaches the previous container", () => {
    const oldEngine = fx.engineByTrackId.get("track-1")!;
    const newEngine = new Container();
    expect(oldEngine.parent).toBe(fx.root);

    // Simulate a remount where the fresh engine registers before the old
    // engine's cleanup has run.
    fx.orchestrator.registerTrack("track-1", newEngine);

    expect(newEngine.parent).toBe(fx.root);
    expect(oldEngine.parent).toBeNull();
    // The old container must NOT be the one mapped to track-1 anymore.
    expect(fx.root.children.filter((c) => c === newEngine)).toHaveLength(1);
    expect(fx.root.children.filter((c) => c === oldEngine)).toHaveLength(0);
  });

  it("unregisterTrack with a stale container reference does not detach the replacement", () => {
    const oldEngine = fx.engineByTrackId.get("track-1")!;
    const newEngine = new Container();
    fx.orchestrator.registerTrack("track-1", newEngine);

    // A late cleanup from the old engine fires; it must not yank `newEngine`.
    fx.orchestrator.unregisterTrack("track-1", oldEngine);

    expect(newEngine.parent).toBe(fx.root);
  });

  it("unregisterTrack removes the engine from its parent and tolerates a second call", () => {
    const engine = fx.engineByTrackId.get("track-1")!;
    fx.orchestrator.unregisterTrack("track-1");
    expect(engine.parent).toBeNull();
    expect(() => fx.orchestrator.unregisterTrack("track-1")).not.toThrow();
  });

  it("dispose detaches and destroys every cached group container", () => {
    fx.orchestrator.setGroups([
      group({ id: "g1", trackIds: ["track-1"], start: 0, timelineDuration: 100 }),
    ]);
    fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
    const container = fx.orchestrator.getGroupContainer("g1")!;

    fx.orchestrator.dispose();
    expect(container.destroyed).toBe(true);
    expect(fx.orchestrator.getGroupContainer("g1")).toBeNull();
    // Further calls are inert.
    expect(() => fx.orchestrator.sync(50, ["track-1"])).not.toThrow();
  });
});
