import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { SourceFrameSyncRef } from "../../utils/sourceFrameSync";
import {
  FrameGraphValidationError,
  FrameResolutionGraphBuilder,
  buildFrameResolutionGraph,
  buildScenePresentationPlan,
  createEffectChainWorkKey,
  createSourceFrameWorkKey,
  validateFrameResolutionGraph,
  type ResolvedClipFrameJob,
} from "../framePlanning";

function job(
  id: string,
  trackId: string,
  clipId: string,
  decodeKey: string | null,
): ResolvedClipFrameJob {
  const activeClip = {
    id: clipId,
    trackId,
    type: "video",
    assetId: "asset",
    start: 0,
    timelineDuration: 100,
    transformations: [],
  } as unknown as TimelineClip;
  return {
    id,
    trackId,
    activeClip,
    effectiveTrackTick: 10,
    rawClipTick: 10,
    sourceFrame: {
      clipId,
      assetId: decodeKey ? "asset" : null,
      effectiveTrackTick: 10,
      rawClipTick: 10,
      sourceTimeSeconds: 0,
      snappedTimeSeconds: 0,
      frameIndex: 0,
      fps: 30,
      key: `${clipId}:frame`,
      decodeKey,
      generation: 1,
    } as SourceFrameSyncRef,
    maskClips: [],
    logicalDimensions: { width: 1920, height: 1080 },
    contentSize: { width: 1920, height: 1080 },
    fps: 30,
  };
}

describe("FrameResolutionGraph", () => {
  it("folds duplicate source work while keeping clip-local output nodes", () => {
    const first = job("1:t1:c1", "t1", "c1", "asset:0:30:0");
    const second = job("1:t2:c2", "t2", "c2", "asset:0:30:0");

    const graph = buildFrameResolutionGraph(1, [first, second]);
    const sourceNodes = graph.nodes.filter((node) => node.kind === "source");
    const outputNodes = graph.nodes.filter(
      (node) => node.kind === "clip-output",
    );

    expect(sourceNodes).toHaveLength(1);
    expect(sourceNodes[0]).toMatchObject({
      jobIds: [first.id, second.id],
    });
    expect(outputNodes).toHaveLength(2);
    expect(graph.outputByJobId.size).toBe(2);
  });

  it("returns deterministic dependency-first order", () => {
    const graph = buildFrameResolutionGraph(7, [
      job("7:t1:c1", "t1", "c1", "asset:0:30:0"),
      job("7:t2:c2", "t2", "c2", "asset:1:30:0.033"),
    ]);

    expect(validateFrameResolutionGraph(graph).map((node) => node.id)).toEqual(
      graph.nodes.map((node) => node.id),
    );
  });

  it("inserts a placement-private composite scene between fallback source and parent effects", () => {
    const compositeJob = job(
      "3:t1:placement",
      "t1",
      "placement",
      "bake:0:30:0",
    );
    compositeJob.compositeSource = {
      mode: "live",
      fallbackReason: "not-ready",
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "composite-1",
      placementId: "placement",
      revision: 2,
      bakeKey: "key-2",
      localPresentationTick: 25,
      logicalDimensions: { width: 1920, height: 1080 },
      fps: 30,
      content: { durationTicks: 100, clips: [] },
      fallbackAssetId: "bake",
    };

    const graph = buildFrameResolutionGraph(3, [compositeJob]);
    const ordered = validateFrameResolutionGraph(graph);
    const compositeNode = ordered.find(
      (node) => node.kind === "composite-scene",
    );
    const effectNode = ordered.find((node) => node.kind === "effect-chain");

    expect(compositeNode).toMatchObject({
      placementId: "placement",
      compositeId: "composite-1",
      revision: 2,
      localPresentationTick: 25,
    });
    expect(compositeNode?.inputs).toHaveLength(1);
    expect(effectNode?.inputs).toContain(compositeNode?.id);
    expect(ordered.map((node) => node.kind)).toEqual([
      "source",
      "composite-scene",
      "mask-sync",
      "mask-coverage",
      "effect-chain",
      "clip-output",
    ]);
  });

  it("routes a selected bake through the ordinary asset graph", () => {
    const compositeJob = job(
      "3:t1:placement",
      "t1",
      "placement",
      "bake:0:30:0",
    );
    compositeJob.compositeSource = {
      mode: "baked",
      fallbackReason: null,
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "composite-1",
      placementId: "placement",
      revision: 2,
      bakeKey: "key-2",
      localPresentationTick: 25,
      logicalDimensions: { width: 1920, height: 1080 },
      fps: 30,
      content: { durationTicks: 100, clips: [] },
      fallbackAssetId: "bake",
    };

    const ordered = validateFrameResolutionGraph(
      buildFrameResolutionGraph(3, [compositeJob]),
    );

    expect(ordered.map((node) => node.kind)).toEqual([
      "source",
      "mask-sync",
      "mask-coverage",
      "effect-chain",
      "clip-output",
    ]);
  });

  it("shares complete stateless composite work keys but isolates temporal placements", () => {
    const first = job("4:t1:p1", "t1", "p1", null);
    const second = job("4:t2:p2", "t2", "p2", null);
    const source = {
      mode: "live" as const,
      fallbackReason: "not-ready" as const,
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "composite",
      placementId: "p1",
      revision: 1,
      bakeKey: "key",
      localPresentationTick: 10,
      logicalDimensions: { width: 1920, height: 1080 },
      fps: 30,
      content: { durationTicks: 100, clips: [] },
      fallbackAssetId: null,
      isStateless: true,
    };
    first.compositeSource = source;
    second.compositeSource = { ...source, placementId: "p2" };

    const statelessNodes = buildFrameResolutionGraph(4, [first, second]).nodes
      .filter((node) => node.kind === "composite-scene");
    expect(statelessNodes[0].workKey).toBe(statelessNodes[1].workKey);

    second.compositeSource = {
      ...second.compositeSource,
      isStateless: false,
    };
    const temporalNodes = buildFrameResolutionGraph(4, [first, second]).nodes
      .filter((node) => node.kind === "composite-scene");
    expect(temporalNodes[0].workKey).not.toBe(temporalNodes[1].workKey);
  });

  it("rejects missing inputs", () => {
    const frameJob = job("1:t1:c1", "t1", "c1", "asset:0:30:0");
    const builder = new FrameResolutionGraphBuilder(1, [frameJob]);
    builder.addNode({
      id: "output",
      kind: "clip-output",
      workKey: "output",
      inputs: ["missing"],
      jobId: frameJob.id,
    });
    builder.setOutput(frameJob.id, "output");

    expect(() => builder.build()).toThrow(FrameGraphValidationError);
    expect(() => builder.build()).toThrow("missing input");
  });

  it("rejects cycles", () => {
    const frameJob = job("1:t1:c1", "t1", "c1", "asset:0:30:0");
    const graph = {
      epoch: 1,
      jobs: [frameJob],
      nodes: [
        {
          id: "a",
          kind: "mask-sync" as const,
          workKey: "a",
          inputs: ["b"],
          jobId: frameJob.id,
        },
        {
          id: "b",
          kind: "clip-output" as const,
          workKey: "b",
          inputs: ["a"],
          jobId: frameJob.id,
        },
      ],
      outputByJobId: new Map([[frameJob.id, "b"]]),
    };

    expect(() => validateFrameResolutionGraph(graph)).toThrow("Cycle");
  });

  it("shares source keys by content but separates frame-local effect work", () => {
    const first = job("2:t1:c1", "t1", "c1", "asset:0:30:0");
    const second = job("2:t2:c2", "t2", "c2", "asset:0:30:0");

    expect(createSourceFrameWorkKey(first)).toBe(
      createSourceFrameWorkKey(second),
    );
    expect(createEffectChainWorkKey(2, first)).not.toBe(
      createEffectChainWorkKey(2, second),
    );
    expect(createEffectChainWorkKey(2, first)).not.toBe(
      createEffectChainWorkKey(3, first),
    );
  });

  it("builds track visibility, nesting, z-order, and encoder sinks once", () => {
    const active = job("1:t2:c2", "t2", "c2", "asset:0:30:0");
    const plan = buildScenePresentationPlan({
      epoch: 1,
      visualTrackOrder: ["t1", "t2"],
      jobs: [active],
      adjustmentForest: [
        {
          id: "adjustment@t2",
          sourceClipId: "adjustment",
          transformations: [],
          start: 0,
          timelineDuration: 100,
          trackIds: ["t2"],
          children: [],
        },
      ],
      outputIds: ["video", "mask"],
    });

    expect(plan.tracks).toEqual([
      {
        trackId: "t1",
        jobId: null,
        visible: false,
        parentGroupId: null,
        zIndex: 1,
      },
      {
        trackId: "t2",
        jobId: active.id,
        visible: true,
        parentGroupId: "adjustment@t2",
        zIndex: 0,
      },
    ]);
    expect(plan.encoderSinks.map((sink) => sink.id)).toEqual([
      "video",
      "mask",
    ]);
  });
});
