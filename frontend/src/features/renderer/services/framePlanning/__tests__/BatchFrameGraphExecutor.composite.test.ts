import { Texture } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../../../../../types/TimelineTypes";
import type { CompositeSceneFrameRenderer } from "../../CompositeSceneRuntime";
import type { TrackRenderEngine } from "../../TrackRenderEngine";
import type { SharedTextureHandle } from "../../SharedTextureStore";
import { BatchFrameGraphExecutor } from "../BatchFrameGraphExecutor";
import type { FrameJobResolutionResult } from "../FrameJobResolver";
import { buildFrameResolutionGraph } from "../FrameResolutionGraph";
import type { ResolvedClipFrameJob } from "../framePlanningTypes";

function compositeJob(): ResolvedClipFrameJob {
  return {
    id: "1:track:placement",
    trackId: "track",
    activeClip: {
      id: "placement",
      trackId: "track",
      type: "video",
      assetId: "legacy-bake",
      compositeId: "composite",
      transformations: [],
    } as unknown as TimelineClip,
    effectiveTrackTick: 25,
    rawClipTick: 25,
    sourceFrame: {
      key: "placement:generated",
      decodeKey: null,
      generation: 1,
      sourceTimeTicks: 25,
    } as ResolvedClipFrameJob["sourceFrame"],
    maskClips: [],
    logicalDimensions: { width: 1920, height: 1080 },
    contentSize: { width: 1920, height: 1080 },
    fps: 30,
    compositeSource: {
      mode: "live",
      fallbackReason: "not-ready",
      sourceChanged: false,
      switchLatencyMs: null,
      compositeId: "composite",
      placementId: "placement",
      revision: 1,
      bakeKey: "key",
      localPresentationTick: 25,
      logicalDimensions: { width: 1920, height: 1080 },
      fps: 30,
      content: { durationTicks: 100, clips: [] },
      fallbackAssetId: null,
    },
  };
}

function resolution(
  job: ResolvedClipFrameJob,
  present: TrackRenderEngine["presentResolvedFrameJob"],
  engineOverrides: Partial<TrackRenderEngine> = {},
): FrameJobResolutionResult {
  const engine = {
    presentResolvedFrameJob: present,
    ...engineOverrides,
  } as unknown as TrackRenderEngine;
  return {
    jobs: [job],
    assetsById: new Map(),
    engineByJobId: new Map([[job.id, engine]]),
    trackInputByJobId: new Map(),
  };
}

describe("BatchFrameGraphExecutor composite scenes", () => {
  it("feeds the isolated scene texture into the ordinary parent clip path", async () => {
    const job = compositeJob();
    const present = vi.fn(
      async (
        _job: ResolvedClipFrameJob,
        _handle: SharedTextureHandle | null,
      ) => true,
    );
    const release = vi.fn();
    const renderer = {
      renderCompositeScene: vi.fn(async () => ({
        key: "composite-output",
        value: Texture.EMPTY,
        release,
      })),
      dispose: vi.fn(),
    } satisfies CompositeSceneFrameRenderer;
    const onCompositeSceneRendered = vi.fn();
    const executor = new BatchFrameGraphExecutor({
      compositeSceneRenderer: renderer,
      onCompositeSceneRendered,
    });

    const result = await executor.execute(
      buildFrameResolutionGraph(1, [job]),
      resolution(job, present),
      { mode: "export" },
    );

    expect(renderer.renderCompositeScene).toHaveBeenCalledWith(
      job.compositeSource,
      [],
      { mode: "export" },
    );
    expect(onCompositeSceneRendered).toHaveBeenCalledWith(
      job,
      Texture.EMPTY,
    );
    expect(present).toHaveBeenCalledWith(
      job,
      expect.objectContaining({ texture: Texture.EMPTY }),
      expect.any(Map),
      { mode: "export" },
    );
    expect(result.committedJobIds).toEqual(new Set([job.id]));
    expect(result.diagnostics.nodesExecutedByKind["composite-scene"]).toBe(1);
    expect(result.diagnostics).toMatchObject({
      compositeLiveJobs: 1,
      compositeBakedJobs: 0,
      compositeFallbackReasons: { "not-ready": 1 },
    });
    expect(result.compositeSourceCommits).toEqual([
      expect.objectContaining({
        compositeId: "composite",
        placementId: "placement",
        mode: "live",
        assetId: null,
      }),
    ]);
    const presentedHandle = present.mock.calls[0][1];
    presentedHandle?.release();
    expect(release).toHaveBeenCalledOnce();

    executor.dispose();
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });

  it("keeps live preview non-fatal and reports an error without a fallback", async () => {
    const job = compositeJob();
    const failure = new Error("child failed");
    const present = vi.fn(async () => true);
    const onCompositeSceneError = vi.fn();
    const executor = new BatchFrameGraphExecutor({
      compositeSceneRenderer: {
        renderCompositeScene: vi.fn(async () => {
          throw failure;
        }),
        dispose: vi.fn(),
      },
      onCompositeSceneError,
    });

    await executor.execute(
      buildFrameResolutionGraph(1, [job]),
      resolution(job, present),
      { mode: "live", epoch: 1 },
    );

    expect(onCompositeSceneError).toHaveBeenCalledWith(failure, job);
    expect(present).toHaveBeenCalledWith(
      job,
      null,
      expect.any(Map),
      { mode: "live", epoch: 1 },
    );
    executor.dispose();
  });

  it("fails export when live rendering fails without a valid bake", async () => {
    const job = compositeJob();
    const failure = new Error("child failed");
    const present = vi.fn(async () => true);
    const executor = new BatchFrameGraphExecutor({
      compositeSceneRenderer: {
        renderCompositeScene: vi.fn(async () => {
          throw failure;
        }),
        dispose: vi.fn(),
      },
    });

    await expect(
      executor.execute(
        buildFrameResolutionGraph(1, [job]),
        resolution(job, present),
        { mode: "export" },
      ),
    ).rejects.toThrow(/failed to render live during export/);
    expect(present).not.toHaveBeenCalled();
    executor.dispose();
  });

  it("uses the validated baked source when direct rendering fails", async () => {
    const job = compositeJob();
    job.compositeSource = {
      ...job.compositeSource!,
      fallbackAssetId: "legacy-bake",
    };
    job.sourceFrame = {
      ...job.sourceFrame,
      key: "placement:legacy-bake:0",
      decodeKey: "legacy-bake:0:30:0",
    };
    const present = vi.fn(async (_job, handle) => {
      handle?.release();
      return true;
    });
    const decodeResolvedSourceFrame = vi.fn(async () => null);
    const executor = new BatchFrameGraphExecutor({
      compositeSceneRenderer: {
        renderCompositeScene: vi.fn(async () => {
          throw new Error("direct failed");
        }),
        dispose: vi.fn(),
      },
      onCompositeSceneError: vi.fn(),
    });

    await executor.execute(
      buildFrameResolutionGraph(1, [job]),
      resolution(job, present, {
        decodeResolvedSourceFrame,
        getCurrentPlannedSourceFrameIntent: vi.fn(() => ({
          key: job.sourceFrame.key,
          generation: job.sourceFrame.generation,
        })),
      }),
      { mode: "export" },
    );

    expect(decodeResolvedSourceFrame).toHaveBeenCalledWith(job, {
      signal: undefined,
    });
    expect(present).toHaveBeenCalledWith(
      job,
      expect.objectContaining({ texture: Texture.EMPTY }),
      expect.any(Map),
      { mode: "export" },
    );
    executor.dispose();
  });

  it("decodes a selected bake without invoking the composite scene renderer", async () => {
    const job = compositeJob();
    job.compositeSource = {
      ...job.compositeSource!,
      mode: "baked",
      fallbackAssetId: "legacy-bake",
    };
    job.sourceFrame = {
      ...job.sourceFrame,
      key: "placement:legacy-bake:0",
      decodeKey: "legacy-bake:0:30:0",
    };
    const present = vi.fn(async (_job, handle) => {
      handle?.release();
      return true;
    });
    const decodeResolvedSourceFrame = vi.fn(async () => null);
    const compositeSceneRenderer = {
      renderCompositeScene: vi.fn(async () => ({
        key: "unused",
        value: Texture.EMPTY,
        release: vi.fn(),
      })),
      dispose: vi.fn(),
    } satisfies CompositeSceneFrameRenderer;
    const executor = new BatchFrameGraphExecutor({ compositeSceneRenderer });

    const result = await executor.execute(
      buildFrameResolutionGraph(1, [job]),
      resolution(job, present, {
        decodeResolvedSourceFrame,
        getCurrentPlannedSourceFrameIntent: vi.fn(() => ({
          key: job.sourceFrame.key,
          generation: job.sourceFrame.generation,
        })),
      }),
      { mode: "export" },
    );

    expect(decodeResolvedSourceFrame).toHaveBeenCalledWith(job, {
      signal: undefined,
    });
    expect(compositeSceneRenderer.renderCompositeScene).not.toHaveBeenCalled();
    expect(result.diagnostics.nodesExecutedByKind["composite-scene"]).toBe(0);
    expect(result.diagnostics).toMatchObject({
      compositeLiveJobs: 0,
      compositeBakedJobs: 1,
    });
    // A null decode retains the prior live frame and must not be advertised as
    // a committed baked presentation.
    expect(result.compositeSourceCommits).toEqual([]);
    executor.dispose();
  });
});
