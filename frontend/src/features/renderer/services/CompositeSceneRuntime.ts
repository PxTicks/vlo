import { Container, RenderTexture, type Renderer, type Texture } from "pixi.js";
import type { Asset } from "../../../types/Asset";
import {
  isCompositeClip,
  type MaskTimelineClip,
  type TimelineClip,
  type TimelineTrack,
  type Transition,
} from "../../../types/TimelineTypes";
import { resolveTransitionFrame } from "../../transitions/rendering/TransitionResolver";
import { namespaceCompositeRuntimeContent } from "../utils/compositeRuntimeNamespace";
import { sortTrackClipsByStart } from "../utils/clipLookup";
import { AdjustmentEffectResolver } from "./AdjustmentEffectResolver";
import type { DecoderWorkerPool } from "./DecoderWorkerPool";
import { RenderGroupOrchestrator } from "./RenderGroupOrchestrator";
import { TrackRenderEngine } from "./TrackRenderEngine";
import { TemporalRenderCoordinator } from "./TemporalRenderCoordinator";
import { collectTemporalFrameScope } from "./TemporalFrameScopeResolver";
import { BatchFrameGraphExecutor } from "./framePlanning/BatchFrameGraphExecutor";
import {
  FrameJobResolver,
  type FrameJobResolutionTrack,
} from "./framePlanning/FrameJobResolver";
import { buildFrameResolutionGraph } from "./framePlanning/FrameResolutionGraph";
import { buildScenePresentationPlan } from "./framePlanning/ScenePresentationPlanner";
import type {
  FrameExecutionPolicy,
  ResolvedCompositeSource,
} from "./framePlanning/framePlanningTypes";
import type { FilterRenderContext } from "../../transformations/catalogue/types";

export interface CompositeSceneFrameRenderer {
  renderCompositeScene(
    source: ResolvedCompositeSource,
    assets: readonly Asset[],
    policy: FrameExecutionPolicy,
  ): Promise<Texture>;
  dispose(): void;
}

interface RuntimeIdentity {
  revision: number;
  bakeKey: string;
  width: number;
  height: number;
  fps: number;
}

function identityFor(source: ResolvedCompositeSource): RuntimeIdentity {
  return {
    revision: source.revision,
    bakeKey: source.bakeKey,
    width: source.logicalDimensions.width,
    height: source.logicalDimensions.height,
    fps: source.fps,
  };
}

function sameIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return (
    left.revision === right.revision &&
    left.bakeKey === right.bakeKey &&
    left.width === right.width &&
    left.height === right.height &&
    left.fps === right.fps
  );
}

function buildMaskLookup(clips: readonly TimelineClip[]) {
  const clipsById = new Map(clips.map((clip) => [clip.id, clip] as const));
  const result = new Map<string, MaskTimelineClip[]>();
  for (const clip of clips) {
    if (clip.type === "mask") continue;
    const masks = (clip.components ?? [])
      .filter((component) => component.type === "mask_ref")
      .map((component) => clipsById.get(component.parameters.maskClipId))
      .filter((candidate): candidate is MaskTimelineClip =>
        candidate?.type === "mask",
      );
    if (masks.length > 0) {
      result.set(clip.id, masks);
    }
  }
  return result;
}

function withRenderContext(
  policy: FrameExecutionPolicy,
  render: FilterRenderContext,
): FrameExecutionPolicy {
  return policy.mode === "export"
    ? { ...policy, render }
    : { ...policy, render };
}

class CompositePlacementRuntime {
  private readonly root = new Container();
  private readonly output: RenderTexture;
  private readonly resolver = new FrameJobResolver();
  private readonly executor = new BatchFrameGraphExecutor();
  private readonly adjustmentResolver = new AdjustmentEffectResolver();
  private readonly orchestrator: RenderGroupOrchestrator;
  private readonly engines: TrackRenderEngine[];
  private readonly resolutionTracks: FrameJobResolutionTrack[];
  private readonly visualTrackOrder: string[];
  private readonly tracks: TimelineTrack[];
  private readonly clips: TimelineClip[];
  private readonly transitions: Transition[];
  private readonly renderer: Renderer;
  private readonly source: ResolvedCompositeSource;
  private readonly temporal = new TemporalRenderCoordinator();
  private epoch = 0;

  constructor(
    renderer: Renderer,
    source: ResolvedCompositeSource,
    identity: RuntimeIdentity,
    decoderPool?: DecoderWorkerPool,
  ) {
    this.renderer = renderer;
    this.source = source;
    if (source.content.clips.some((clip) => isCompositeClip(clip))) {
      throw new Error(
        `Nested composite content is not supported for '${source.compositeId}'.`,
      );
    }
    const content = namespaceCompositeRuntimeContent(
      source.content,
      source.placementId,
    );
    this.tracks = content.tracks;
    this.clips = content.clips;
    this.transitions = content.transitions;
    this.root.sortableChildren = true;
    this.output = RenderTexture.create({
      width: Math.max(1, identity.width),
      height: Math.max(1, identity.height),
      dynamic: true,
    });
    this.adjustmentResolver.setAdjustmentSource(
      this.tracks,
      this.clips,
      identity.fps,
    );
    this.orchestrator = new RenderGroupOrchestrator(this.root, {
      logicalDimensions: source.logicalDimensions,
      adjustmentEffectResolver: this.adjustmentResolver,
    });
    const visualTracks = this.tracks.filter(
      (track) => track.type === "visual" && track.isVisible,
    );
    this.visualTrackOrder = visualTracks.map((track) => track.id);
    const maskClipsByParent = buildMaskLookup(this.clips);
    this.engines = visualTracks.map((track, index) => {
      const engine = new TrackRenderEngine(
        visualTracks.length - 1 - index,
        undefined,
        renderer,
        {
          trackId: track.id,
          adjustmentEffectResolver: this.adjustmentResolver,
          ...(decoderPool ? { decoderPool } : {}),
        },
      );
      this.orchestrator.registerTrack(track.id, engine.container);
      return engine;
    });
    this.resolutionTracks = visualTracks.map((track, index) => ({
      trackId: track.id,
      engine: this.engines[index],
      trackClips: sortTrackClipsByStart(
        this.clips.filter(
          (clip) => clip.trackId === track.id && clip.type !== "mask",
        ),
      ),
      maskClipsByParent,
    }));
  }

  async render(
    localPresentationTick: number,
    assets: readonly Asset[],
    policy: FrameExecutionPolicy,
  ): Promise<Texture> {
    const temporalScope = collectTemporalFrameScope({
      presentationTick: localPresentationTick,
      tracks: this.resolutionTracks.map((track) => ({
        trackId: track.trackId,
        trackClips: track.trackClips,
        activeClipResolver: track.engine,
      })),
      stableClips: this.clips,
      adjustmentEffectResolver: this.adjustmentResolver,
    });
    const temporalPlan = this.temporal.plan({
      presentationTick: localPresentationTick,
      fps: this.source.fps,
      mode:
        policy.render?.mode ??
        (policy.mode === "export" ? "export" : "preview"),
      requirements: temporalScope.requirements,
      earliestTick: temporalScope.earliestTick,
      topologyKey: temporalScope.topologyKey,
    });

    try {
      for (const warmup of temporalPlan.warmup) {
        await this.renderFrame(
          warmup.presentationTimeTicks,
          assets,
          withRenderContext(policy, warmup),
        );
      }
      await this.renderFrame(
        localPresentationTick,
        assets,
        withRenderContext(policy, temporalPlan.target),
      );
      return this.output;
    } catch (error) {
      this.temporal.invalidate();
      throw error;
    }
  }

  private async renderFrame(
    localPresentationTick: number,
    assets: readonly Asset[],
    policy: FrameExecutionPolicy,
  ): Promise<void> {
    this.epoch += 1;
    const adjustmentForest =
      this.adjustmentResolver.deriveGroups(localPresentationTick);
    const transitionFrame = resolveTransitionFrame({
      tracks: this.tracks,
      clips: this.clips,
      transitions: this.transitions,
      fps: this.source.fps,
      presentationTick: localPresentationTick,
      logicalDimensions: this.source.logicalDimensions,
      visualTrackOrder: this.visualTrackOrder,
      adjustmentForest,
    });
    const resolution = this.resolver.resolve({
      epoch: this.epoch,
      presentationTick: localPresentationTick,
      tracks: this.resolutionTracks,
      assets,
      composites: [],
      logicalDimensions: this.source.logicalDimensions,
      fps: this.source.fps,
      transitionTransformsByClipId: transitionFrame.transformsByClipId,
    });
    const graph = buildFrameResolutionGraph(this.epoch, resolution.jobs);
    const presentationPlan = buildScenePresentationPlan({
      epoch: this.epoch,
      visualTrackOrder: this.visualTrackOrder,
      jobs: resolution.jobs,
      adjustmentForest,
      zIndexOverrides: transitionFrame.zIndexOverrides,
      transitionColorLayers: transitionFrame.colorLayers,
    });
    await this.executor.execute(graph, resolution, policy);
    this.orchestrator.syncPresentationPlan(
      localPresentationTick,
      presentationPlan,
      policy.render,
    );
    this.renderer.render({
      container: this.root,
      target: this.output,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
  }

  dispose(): void {
    this.executor.dispose();
    this.orchestrator.dispose();
    this.engines.forEach((engine) => engine.dispose());
    this.output.destroy(true);
    if (!this.root.destroyed) {
      this.root.destroy({ children: true });
    }
  }
}

/** Owns one conservative child-scene runtime per parent placement. */
export class CompositeSceneRuntimeManager
  implements CompositeSceneFrameRenderer
{
  private readonly runtimes = new Map<
    string,
    { identity: RuntimeIdentity; runtime: CompositePlacementRuntime }
  >();
  private readonly renderer: Renderer;
  private readonly decoderPool?: DecoderWorkerPool;

  constructor(renderer: Renderer, decoderPool?: DecoderWorkerPool) {
    this.renderer = renderer;
    this.decoderPool = decoderPool;
  }

  async renderCompositeScene(
    source: ResolvedCompositeSource,
    assets: readonly Asset[],
    policy: FrameExecutionPolicy,
  ): Promise<Texture> {
    const identity = identityFor(source);
    let entry = this.runtimes.get(source.placementId);
    if (!entry || !sameIdentity(entry.identity, identity)) {
      entry?.runtime.dispose();
      entry = {
        identity,
        runtime: new CompositePlacementRuntime(
          this.renderer,
          source,
          identity,
          this.decoderPool,
        ),
      };
      this.runtimes.set(source.placementId, entry);
    }
    return entry.runtime.render(
      source.localPresentationTick,
      assets,
      policy,
    );
  }

  dispose(): void {
    for (const entry of this.runtimes.values()) {
      entry.runtime.dispose();
    }
    this.runtimes.clear();
  }
}
