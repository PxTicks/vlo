import { Container } from "pixi.js";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AdjustmentTimelineClip,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { RenderGroupOrchestrator } from "../RenderGroupOrchestrator";

function visualTrack(id: string): TimelineTrack {
  return {
    id,
    type: "visual",
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function adjustmentTrack(id: string): TimelineTrack {
  return {
    id,
    type: "adjustment",
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function adjustmentClip(overrides: {
  id: string;
  trackId: string;
  start: number;
  timelineDuration: number;
  depth: number;
}): AdjustmentTimelineClip {
  return {
    id: overrides.id,
    type: "adjustment",
    name: overrides.id,
    trackId: overrides.trackId,
    start: overrides.start,
    timelineDuration: overrides.timelineDuration,
    sourceDuration: null,
    transformedDuration: overrides.timelineDuration,
    transformedOffset: 0,
    croppedSourceDuration: overrides.timelineDuration,
    offset: 0,
    transformations: [],
    depth: overrides.depth,
  };
}

interface Fixture {
  root: Container;
  orchestrator: RenderGroupOrchestrator;
  engineByTrackId: Map<string, Container>;
  visualTracks: TimelineTrack[];
}

function makeFixture(visualTrackIds: string[]): Fixture {
  const root = new Container();
  root.sortableChildren = true;
  const orchestrator = new RenderGroupOrchestrator(root);
  const engineByTrackId = new Map<string, Container>();
  const visualTracks = visualTrackIds.map(visualTrack);
  for (const trackId of visualTrackIds) {
    const engineContainer = new Container();
    engineByTrackId.set(trackId, engineContainer);
    orchestrator.registerTrack(trackId, engineContainer);
  }
  return { root, orchestrator, engineByTrackId, visualTracks };
}

describe("RenderGroupOrchestrator", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture(["track-1", "track-2", "track-3"]);
  });

  describe("track lifecycle", () => {
    it("registerTrack parents engine containers under root immediately", () => {
      for (const engineContainer of fx.engineByTrackId.values()) {
        expect(engineContainer.parent).toBe(fx.root);
      }
    });

    it("initial sync with no adjustment clips leaves every track parented under root", () => {
      fx.orchestrator.setAdjustmentSource(fx.visualTracks, []);
      fx.orchestrator.sync(0, ["track-1", "track-2", "track-3"]);
      for (const engineContainer of fx.engineByTrackId.values()) {
        expect(engineContainer.parent).toBe(fx.root);
      }
    });

    it("assigns zIndex following the top-track = highest-zIndex convention", () => {
      fx.orchestrator.setAdjustmentSource(fx.visualTracks, []);
      fx.orchestrator.sync(0, ["track-1", "track-2", "track-3"]);
      expect(fx.engineByTrackId.get("track-1")!.zIndex).toBe(2);
      expect(fx.engineByTrackId.get("track-2")!.zIndex).toBe(1);
      expect(fx.engineByTrackId.get("track-3")!.zIndex).toBe(0);
    });

    it("registerTrack is idempotent for the same (trackId, container) pair", () => {
      const engine = fx.engineByTrackId.get("track-1")!;
      fx.orchestrator.registerTrack("track-1", engine); // double-register
      expect(engine.parent).toBe(fx.root);
      expect(fx.root.children.filter((c) => c === engine)).toHaveLength(1);
    });

    it("registerTrack with a new container for an existing trackId detaches the previous container", () => {
      const oldEngine = fx.engineByTrackId.get("track-1")!;
      const newEngine = new Container();
      expect(oldEngine.parent).toBe(fx.root);
      fx.orchestrator.registerTrack("track-1", newEngine);
      expect(newEngine.parent).toBe(fx.root);
      expect(oldEngine.parent).toBeNull();
    });

    it("unregisterTrack with a stale container reference does not detach the replacement", () => {
      const oldEngine = fx.engineByTrackId.get("track-1")!;
      const newEngine = new Container();
      fx.orchestrator.registerTrack("track-1", newEngine);
      fx.orchestrator.unregisterTrack("track-1", oldEngine);
      expect(newEngine.parent).toBe(fx.root);
    });

    it("unregisterTrack removes the engine from its parent and tolerates a second call", () => {
      const engine = fx.engineByTrackId.get("track-1")!;
      fx.orchestrator.unregisterTrack("track-1");
      expect(engine.parent).toBeNull();
      expect(() => fx.orchestrator.unregisterTrack("track-1")).not.toThrow();
    });
  });

  describe("adjustment-clip activation", () => {
    it("activating a single adjustment reparents reached engines into a fresh container", () => {
      // Adjustment track on top, then track-1 and track-2 visual, track-3 visual.
      const adj = adjustmentTrack("adj");
      const tracks = [adj, ...fx.visualTracks];
      const adjustment = adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 2,
      });
      fx.orchestrator.setAdjustmentSource(tracks, [adjustment]);
      fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);

      const groupContainer = fx.orchestrator.getGroupContainer(
        "a@track-1",
      );
      expect(groupContainer).not.toBeNull();
      expect(groupContainer!.parent).toBe(fx.root);
      expect(fx.engineByTrackId.get("track-1")!.parent).toBe(groupContainer);
      expect(fx.engineByTrackId.get("track-2")!.parent).toBe(groupContainer);
      expect(fx.engineByTrackId.get("track-3")!.parent).toBe(fx.root);
      expect(groupContainer!.sortableChildren).toBe(true);
    });

    it("group container zIndex matches top-most member's z slot", () => {
      const adj = adjustmentTrack("adj");
      // adj is at the top of the stack; depth=2 reaches track-2+track-3
      // (the next two visual tracks); track-1 sits above adj so it's
      // unaffected. The group's top-most member is track-2 (visual index 1).
      const tracks = [
        visualTrack("track-1"),
        adj,
        visualTrack("track-2"),
        visualTrack("track-3"),
      ];
      const adjustment = adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 2,
      });
      fx.orchestrator.setAdjustmentSource(tracks, [adjustment]);
      fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
      const container = fx.orchestrator.getGroupContainer("a@track-2")!;
      // visualTrackOrder length 3; top-most member track-2 at visual index 1
      // → zIndex = 3 - 1 - 1 = 1.
      expect(container.zIndex).toBe(1);
    });

    it("deactivating an adjustment detaches its container but preserves the instance", () => {
      const tracks = [adjustmentTrack("adj"), ...fx.visualTracks];
      const adjustment = adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 1,
      });
      fx.orchestrator.setAdjustmentSource(tracks, [adjustment]);
      fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
      const activeContainer = fx.orchestrator.getGroupContainer("a@track-1");
      expect(activeContainer!.parent).toBe(fx.root);

      fx.orchestrator.sync(200, ["track-1", "track-2", "track-3"]);
      // Same container instance, but detached.
      expect(fx.orchestrator.getGroupContainer("a@track-1")).toBe(
        activeContainer,
      );
      expect(activeContainer!.parent).toBeNull();
      expect(activeContainer!.destroyed).toBe(false);
      expect(fx.engineByTrackId.get("track-1")!.parent).toBe(fx.root);
    });

    it("a track covered by two disjoint-window adjustments flips parents at the boundary", () => {
      const tracks = [adjustmentTrack("adj"), ...fx.visualTracks];
      const early = adjustmentClip({
        id: "early",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 2,
      });
      const late = adjustmentClip({
        id: "late",
        trackId: "adj",
        start: 100,
        timelineDuration: 100,
        depth: 2,
      });
      fx.orchestrator.setAdjustmentSource(tracks, [early, late]);

      const engine = fx.engineByTrackId.get("track-1")!;

      fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
      const earlyContainer = fx.orchestrator.getGroupContainer(
        "early@track-1",
      )!;
      expect(engine.parent).toBe(earlyContainer);

      fx.orchestrator.sync(150, ["track-1", "track-2", "track-3"]);
      const lateContainer = fx.orchestrator.getGroupContainer("late@track-1")!;
      expect(engine.parent).toBe(lateContainer);
      expect(earlyContainer.parent).toBeNull();
      expect(lateContainer.parent).toBe(fx.root);
      // Engine instance stable across the boundary.
      expect(fx.engineByTrackId.get("track-1")).toBe(engine);
    });

    it("an adjustment with no reachable visual tracks spawns no containers", () => {
      // adj is below all visual tracks → no tracks below it → empty reach.
      const tracks = [...fx.visualTracks, adjustmentTrack("adj")];
      const adjustment = adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 5,
      });
      fx.orchestrator.setAdjustmentSource(tracks, [adjustment]);
      fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
      expect(fx.orchestrator.getGroupContainer("a@track-1")).toBeNull();
    });

    it("creates and attaches an empty container when an adjustment's reach contains no registered tracks", () => {
      // Selection-export simulation: the project has track-1+track-2+track-3
      // as visual tracks, but only track-3 is registered (e.g. only it was
      // included in the export selection). An adjustment reaches track-1
      // and track-2 — neither registered — but the derivation still emits
      // a derived group, and the orchestrator still spawns a container.
      // We tolerate the empty-container cost; documented in ExportRenderer.
      const adj = adjustmentTrack("adj");
      const tracks = [
        adj,
        visualTrack("track-1"),
        visualTrack("track-2"),
        visualTrack("track-3"),
      ];
      const adjustment = adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        // Reaches track-1 + track-2 only.
        depth: 2,
      });

      // Fresh fixture with only track-3 registered.
      const root = new Container();
      root.sortableChildren = true;
      const orchestrator = new RenderGroupOrchestrator(root);
      const engine3 = new Container();
      orchestrator.registerTrack("track-3", engine3);

      orchestrator.setAdjustmentSource(tracks, [adjustment]);
      // visualTrackOrder only contains the registered track.
      orchestrator.sync(50, ["track-3"]);

      const groupContainer = orchestrator.getGroupContainer("a@track-1");
      expect(groupContainer).not.toBeNull();
      // Attached to root, but holds no engine children — the rendered
      // pixels are unchanged from a no-group baseline.
      expect(groupContainer!.parent).toBe(root);
      expect(groupContainer!.children).toEqual([]);
      // The lone registered engine stays under root (its track is outside
      // the adjustment's reach).
      expect(engine3.parent).toBe(root);

      orchestrator.dispose();
    });
  });

  describe("nested forest (partial overlap)", () => {
    it("decomposes partial overlap into outer + inner + sibling containers", () => {
      // adjA at pos 0, depth 3 → reaches positions 1,2,3 → adjB at pos 1
      //   (no contribution) + track-1 at pos 2 + track-2 at pos 3 = {t1, t2}
      // adjB at pos 1, depth 3 → reaches positions 2,3,4 → track-1, track-2,
      //   track-3.
      // Per-track stacks (innermost→outermost):
      //   track-1: [B, A], track-2: [B, A], track-3: [B]
      // Expected forest:
      //   A wraps [track-1, track-2]
      //     └── B wraps [track-1, track-2]
      //   B wraps [track-3]
      const tracks = [
        adjustmentTrack("adjA"),
        adjustmentTrack("adjB"),
        ...fx.visualTracks,
      ];
      const A = adjustmentClip({
        id: "A",
        trackId: "adjA",
        start: 0,
        timelineDuration: 100,
        depth: 3,
      });
      const B = adjustmentClip({
        id: "B",
        trackId: "adjB",
        start: 0,
        timelineDuration: 100,
        depth: 3,
      });
      fx.orchestrator.setAdjustmentSource(tracks, [A, B]);
      fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);

      const outerA = fx.orchestrator.getGroupContainer("A@track-1");
      const innerB = fx.orchestrator.getGroupContainer("B@track-1");
      const tailB = fx.orchestrator.getGroupContainer("B@track-3");

      expect(outerA).not.toBeNull();
      expect(innerB).not.toBeNull();
      expect(tailB).not.toBeNull();

      // Outer A wraps [t1, t2]; sits under root.
      expect(outerA!.parent).toBe(fx.root);
      // Inner B (covering t1+t2) is nested inside outer A.
      expect(innerB!.parent).toBe(outerA);
      // Sibling B (covering t3) sits under root.
      expect(tailB!.parent).toBe(fx.root);

      // Engine parenting: t1 and t2 land in innerB (innermost); t3 lands
      // in tailB.
      expect(fx.engineByTrackId.get("track-1")!.parent).toBe(innerB);
      expect(fx.engineByTrackId.get("track-2")!.parent).toBe(innerB);
      expect(fx.engineByTrackId.get("track-3")!.parent).toBe(tailB);
    });
  });

  describe("topology change eviction", () => {
    it("destroys cached containers whose source adjustment clip is removed from setAdjustmentSource", () => {
      const tracks = [adjustmentTrack("adj"), ...fx.visualTracks];
      const adjustment = adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 2,
      });
      fx.orchestrator.setAdjustmentSource(tracks, [adjustment]);
      fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
      const container = fx.orchestrator.getGroupContainer("a@track-1")!;
      expect(container.destroyed).toBe(false);

      // Remove the adjustment clip from the source.
      fx.orchestrator.setAdjustmentSource(tracks, []);
      expect(container.destroyed).toBe(true);
      expect(fx.orchestrator.getGroupContainer("a@track-1")).toBeNull();

      // Next sync reparents reachable engines back to root.
      fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
      expect(fx.engineByTrackId.get("track-1")!.parent).toBe(fx.root);
      expect(fx.engineByTrackId.get("track-2")!.parent).toBe(fx.root);
    });

    it("preserves cached containers whose source clip is still live across reach changes", () => {
      const tracks = [adjustmentTrack("adj"), ...fx.visualTracks];
      let adjustment = adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 2,
      });
      fx.orchestrator.setAdjustmentSource(tracks, [adjustment]);
      fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
      const before = fx.orchestrator.getGroupContainer("a@track-1");
      expect(before).not.toBeNull();

      // Edit depth — same clip id, same first-track-in-run → same cached
      // container.
      adjustment = { ...adjustment, depth: 3 };
      fx.orchestrator.setAdjustmentSource(tracks, [adjustment]);
      fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
      const after = fx.orchestrator.getGroupContainer("a@track-1");
      expect(after).toBe(before);
      expect(after!.destroyed).toBe(false);
    });
  });

  describe("dispose", () => {
    it("detaches and destroys every cached group container", () => {
      const tracks = [adjustmentTrack("adj"), ...fx.visualTracks];
      const adjustment = adjustmentClip({
        id: "a",
        trackId: "adj",
        start: 0,
        timelineDuration: 100,
        depth: 1,
      });
      fx.orchestrator.setAdjustmentSource(tracks, [adjustment]);
      fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]);
      const container = fx.orchestrator.getGroupContainer("a@track-1")!;

      fx.orchestrator.dispose();
      expect(container.destroyed).toBe(true);
      expect(fx.orchestrator.getGroupContainer("a@track-1")).toBeNull();
      // Further calls are inert.
      expect(() =>
        fx.orchestrator.sync(50, ["track-1"]),
      ).not.toThrow();
    });
  });

  it("an unused TimelineClip type import keeps tree-shake honest", () => {
    // Sanity: the orchestrator's public API accepts TimelineClip[] but we
    // mostly construct AdjustmentTimelineClip; this asserts that a mixed
    // clips array (with a non-adjustment clip in it) doesn't blow up the
    // derivation step.
    const tracks = [adjustmentTrack("adj"), ...fx.visualTracks];
    const adjustment = adjustmentClip({
      id: "a",
      trackId: "adj",
      start: 0,
      timelineDuration: 100,
      depth: 1,
    });
    const videoClip = {
      id: "v1",
      type: "video",
      name: "video",
      trackId: "track-1",
      assetId: "asset",
      start: 0,
      timelineDuration: 100,
      sourceDuration: 100,
      transformedDuration: 100,
      transformedOffset: 0,
      croppedSourceDuration: 100,
      offset: 0,
      transformations: [],
    } as unknown as TimelineClip;
    fx.orchestrator.setAdjustmentSource(tracks, [adjustment, videoClip]);
    expect(() =>
      fx.orchestrator.sync(50, ["track-1", "track-2", "track-3"]),
    ).not.toThrow();
  });
});
