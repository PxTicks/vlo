import { describe, it, expect } from "vitest";
import {
  countDedupedDecodes,
  planFrameDecodes,
  type PlannedClipJob,
} from "../RenderFramePlanner";
import type { SourceFrameSyncRef } from "../../utils/sourceFrameSync";
import type { TimelineClip } from "../../../../types/TimelineTypes";

/**
 * Phase 4 planning kernel: group a tick's resolved clip jobs by the decoded
 * source frame they share. Pure — no decode, no GPU. Jobs carry only the fields
 * the planner reads (decodeKey); the rest is preserved opaquely.
 */

function job(trackId: string, decodeKey: string | null): PlannedClipJob {
  return {
    trackId,
    activeClip: { id: `clip-${trackId}` } as TimelineClip,
    sourceFrame: { decodeKey } as SourceFrameSyncRef,
    maskClips: [],
  };
}

describe("planFrameDecodes", () => {
  it("groups duplicate clips at the same decodeKey into one shared decode", () => {
    const a = job("t1", "asset-1:2:30:0.066");
    const b = job("t2", "asset-1:2:30:0.066");

    const plan = planFrameDecodes([a, b]);

    expect(plan.decodeGroups).toHaveLength(1);
    expect(plan.decodeGroups[0].decodeKey).toBe("asset-1:2:30:0.066");
    expect(plan.decodeGroups[0].jobs).toEqual([a, b]);
    expect(countDedupedDecodes(plan)).toBe(1);
  });

  it("keeps distinct decodeKeys as separate groups in first-seen order", () => {
    const a = job("t1", "asset-1:2:30:0.066");
    const b = job("t2", "asset-2:2:30:0.066");

    const plan = planFrameDecodes([a, b]);

    expect(plan.decodeGroups.map((g) => g.decodeKey)).toEqual([
      "asset-1:2:30:0.066",
      "asset-2:2:30:0.066",
    ]);
    expect(countDedupedDecodes(plan)).toBe(0);
  });

  it("excludes null-decodeKey (text/brush) jobs from groups but keeps them in jobs", () => {
    const asset = job("t1", "asset-1:2:30:0.066");
    const text = job("t2", null);

    const plan = planFrameDecodes([asset, text]);

    expect(plan.jobs).toEqual([asset, text]);
    expect(plan.decodeGroups).toHaveLength(1);
    expect(plan.decodeGroups[0].jobs).toEqual([asset]);
  });

  it("treats a single asset job as a group of one (one decode, no sharing)", () => {
    const a = job("t1", "asset-1:2:30:0.066");

    const plan = planFrameDecodes([a]);

    expect(plan.decodeGroups).toHaveLength(1);
    expect(plan.decodeGroups[0].jobs).toEqual([a]);
    expect(countDedupedDecodes(plan)).toBe(0);
  });

  it("preserves input (track/z) order in jobs regardless of grouping", () => {
    const a = job("t1", "asset-1:2:30:0.066");
    const b = job("t2", "asset-2:2:30:0.066");
    const c = job("t3", "asset-1:2:30:0.066"); // same key as a

    const plan = planFrameDecodes([a, b, c]);

    expect(plan.jobs).toEqual([a, b, c]);
    // a and c share a group; b is its own.
    expect(plan.decodeGroups).toHaveLength(2);
    expect(plan.decodeGroups[0].jobs).toEqual([a, c]);
    expect(plan.decodeGroups[1].jobs).toEqual([b]);
    expect(countDedupedDecodes(plan)).toBe(1);
  });

  it("counts saved decodes across multiple multi-job groups", () => {
    const plan = planFrameDecodes([
      job("t1", "k1"),
      job("t2", "k1"),
      job("t3", "k1"), // 3 jobs on k1 -> saves 2
      job("t4", "k2"),
      job("t5", "k2"), // 2 jobs on k2 -> saves 1
      job("t6", null), // text -> no group
    ]);

    expect(countDedupedDecodes(plan)).toBe(3);
    expect(plan.decodeGroups).toHaveLength(2);
  });

  it("returns an empty plan for no jobs", () => {
    const plan = planFrameDecodes([]);
    expect(plan.jobs).toEqual([]);
    expect(plan.decodeGroups).toEqual([]);
    expect(countDedupedDecodes(plan)).toBe(0);
  });
});
