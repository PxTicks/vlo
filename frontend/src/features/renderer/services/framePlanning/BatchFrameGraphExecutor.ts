import { Texture } from "pixi.js";
import { destroyTexture } from "../../utils/retiredTextureQueue";
import {
  RenderFramePlanner,
  countDedupedDecodes,
  type PlannedClipJob,
} from "../RenderFramePlanner";
import {
  SharedTextureHandle,
  SharedTextureStore,
} from "../SharedTextureStore";
import type { CompositeSceneFrameRenderer } from "../CompositeSceneRuntime";
import { SourceFrameDecodeScheduler } from "../SourceFrameDecodeScheduler";
import { validateFrameResolutionGraph } from "./FrameResolutionGraph";
import {
  createEmptyFramePlanningDiagnostics,
  type FrameExecutionPolicy,
  type FramePlanningDiagnostics,
  type FrameResolutionGraph,
  type ResolvedClipFrameJob,
} from "./framePlanningTypes";
import type {
  FrameJobResolutionResult,
  FrameJobResolutionTrack,
} from "./FrameJobResolver";
import { publishFramePlanningDiagnostics } from "./framePlanningDiagnostics";

interface DecodedSourceFrame {
  bitmap: ImageBitmap | null;
}

export interface BatchFrameGraphExecutionResult {
  committedJobIds: ReadonlySet<string>;
  diagnostics: FramePlanningDiagnostics;
}

export interface BatchFrameGraphExecutorOptions {
  isLiveEpochCurrent?: (epoch: number) => boolean;
  onDiagnostics?: (diagnostics: FramePlanningDiagnostics) => void;
  compositeSceneRenderer?: CompositeSceneFrameRenderer;
  onCompositeSceneError?: (error: unknown, job: ResolvedClipFrameJob) => void;
  /** Pre-parent-operation seam used by diagnostics and the parity harness. */
  onCompositeSceneRendered?: (
    job: ResolvedClipFrameJob,
    texture: Texture,
  ) => void;
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfCancelled(
  policy: FrameExecutionPolicy,
  isLiveEpochCurrent?: (epoch: number) => boolean,
): void {
  if (policy.mode === "export" && policy.signal?.aborted) {
    throw createAbortError("Render cancelled");
  }
  if (
    policy.mode === "live" &&
    isLiveEpochCurrent &&
    !isLiveEpochCurrent(policy.epoch)
  ) {
    throw createAbortError("Stale live frame generation");
  }
}

function awaitAllUntilAborted(
  promises: Promise<unknown>[],
  signal?: AbortSignal,
): Promise<unknown> {
  const all = Promise.all(promises);
  if (!signal) {
    return all;
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError("Render cancelled"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError("Render cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    all.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function toPlannedJob(job: ResolvedClipFrameJob): PlannedClipJob {
  return {
    trackId: job.trackId,
    activeClip: job.activeClip,
    sourceFrame: job.sourceFrame,
    maskClips: [...job.maskClips],
  };
}

/**
 * Deterministic graph executor used by export and the synchronized live frame
 * barrier. Source nodes run concurrently through the decoder scheduler; all
 * Pixi/mask/effect nodes are visited serially in validated topological order.
 */
export class BatchFrameGraphExecutor {
  private readonly scheduler = new SourceFrameDecodeScheduler<DecodedSourceFrame>();
  private readonly store = new SharedTextureStore();
  private readonly planner = new RenderFramePlanner(this.scheduler, this.store);
  private readonly options: BatchFrameGraphExecutorOptions;
  private disposed = false;

  constructor(options: BatchFrameGraphExecutorOptions = {}) {
    this.options = options;
  }

  async execute(
    graph: FrameResolutionGraph,
    resolution: FrameJobResolutionResult,
    policy: FrameExecutionPolicy,
  ): Promise<BatchFrameGraphExecutionResult> {
    if (this.disposed) {
      throw new Error("Frame graph executor has been disposed");
    }
    throwIfCancelled(policy, this.options.isLiveEpochCurrent);

    const diagnostics = createEmptyFramePlanningDiagnostics(graph.epoch);
    diagnostics.jobsPlanned = graph.jobs.length;
    diagnostics.nodesPlanned = graph.nodes.length;
    const orderedNodes = validateFrameResolutionGraph(graph);
    const plannedByResolved = new Map<ResolvedClipFrameJob, PlannedClipJob>();
    const resolvedByPlanned = new Map<PlannedClipJob, ResolvedClipFrameJob>();
    const liveReadyJobs: PlannedClipJob[] = [];
    const exportPreparations: Promise<void>[] = [];
    const assetList = [...resolution.assetsById.values()];

    const fallbackSourceJobs = graph.jobs.filter(
      (job) => !job.compositeSource || job.compositeSource.fallbackAssetId,
    );
    for (const job of fallbackSourceJobs) {
      const planned = toPlannedJob(job);
      plannedByResolved.set(job, planned);
      resolvedByPlanned.set(planned, job);
      const trackInput = resolution.trackInputByJobId.get(job.id);
      const engine = resolution.engineByJobId.get(job.id);
      if (trackInput && engine) {
        const isPrepared = engine.prepareResolvedFrameJob(
          job,
          trackInput.trackClips,
          assetList,
        );
        if (policy.mode === "live") {
          // Lazy filesystem hydration must not block the whole live frame. The
          // asset-store update requests another frame once hydration settles.
          // Until then, omit only this source from strict decoding so healthy
          // tracks can still commit without a spurious missing-renderer error.
          if (isPrepared !== false) {
            liveReadyJobs.push(planned);
          }
        } else if (isPrepared === false) {
          exportPreparations.push(
            engine.awaitResolvedFrameJobPreparation(
              job,
              resolution.assetsById,
            ),
          );
        }
      }
    }
    if (policy.mode === "export" && exportPreparations.length > 0) {
      await awaitAllUntilAborted(exportPreparations, policy.signal);
      throwIfCancelled(policy, this.options.isLiveEpochCurrent);
    }

    const decodePlan = this.planner.plan(
      policy.mode === "live"
        ? liveReadyJobs
        : fallbackSourceJobs.map((job) => plannedByResolved.get(job)!),
    );
    diagnostics.withinFrameDedupHits = countDedupedDecodes(decodePlan);
    const cachedBefore = decodePlan.decodeGroups.filter((group) =>
      this.store.has(group.decodeKey),
    ).length;
    diagnostics.cacheHits = cachedBefore;
    diagnostics.cacheMisses = decodePlan.decodeGroups.length - cachedBefore;

    const decodeStart = performance.now();
    const handles = await this.planner.acquireFrameTextures(decodePlan, {
      decode: async (group) => {
        throwIfCancelled(policy, this.options.isLiveEpochCurrent);
        const planned = group.jobs[0];
        const job = resolvedByPlanned.get(planned);
        const engine = job
          ? resolution.engineByJobId.get(job.id)
          : undefined;
        if (!job || !engine) {
          throw new Error(`Missing source executor for '${planned.trackId}'`);
        }
        return {
          bitmap: await engine.decodeResolvedSourceFrame(job, {
            signal: policy.mode === "export" ? policy.signal : undefined,
          }),
        };
      },
      createResource: (_decodeKey, frame) => {
        if (!frame.bitmap) {
          return { texture: Texture.EMPTY, dispose: () => {} };
        }
        const bitmap = frame.bitmap;
        const texture = Texture.from(bitmap);
        return {
          texture,
          dispose: () => {
            destroyTexture(texture);
            if (typeof bitmap.close === "function") {
              bitmap.close();
            }
          },
        };
      },
      getCurrentIntent: (planned) => {
        const job = resolvedByPlanned.get(planned);
        const engine = job
          ? resolution.engineByJobId.get(job.id)
          : undefined;
        return engine?.getCurrentPlannedSourceFrameIntent() ?? null;
      },
      disposeUnclaimedFrame: (frame) => {
        if (frame.bitmap && typeof frame.bitmap.close === "function") {
          frame.bitmap.close();
        }
      },
    });
    diagnostics.decodeTimeMs = performance.now() - decodeStart;

    const handleByJobId = new Map<string, ReturnType<typeof handles.get>>();
    for (const [planned, handle] of handles) {
      const job = resolvedByPlanned.get(planned);
      if (job) {
        handleByJobId.set(job.id, handle);
      }
    }

    const committedJobIds = new Set<string>();
    const consumedHandles = new Set<string>();
    const gpuStart = performance.now();
    try {
      for (const node of orderedNodes) {
        throwIfCancelled(policy, this.options.isLiveEpochCurrent);
        diagnostics.nodesExecutedByKind[node.kind] += 1;
        if (node.kind === "composite-scene") {
          const job = graph.jobs.find(
            (candidate) => candidate.id === node.jobId,
          );
          const source = job?.compositeSource;
          if (!job || !source) {
            throw new Error(
              `Missing composite-scene source for '${node.jobId}'`,
            );
          }
          try {
            const texture = await this.options.compositeSceneRenderer
              ?.renderCompositeScene(source, assetList, policy);
            if (!texture) {
              throw new Error("Composite scene renderer is unavailable");
            }
            const fallbackHandle = handleByJobId.get(node.jobId);
            fallbackHandle?.release();
            handleByJobId.set(
              node.jobId,
              new SharedTextureHandle(node.workKey, texture, () => {}),
            );
            this.options.onCompositeSceneRendered?.(job, texture);
          } catch (error) {
            this.options.onCompositeSceneError?.(error, job);
            if (!source.fallbackAssetId) {
              handleByJobId.delete(node.jobId);
            }
          }
          continue;
        }
        if (node.kind !== "clip-output") {
          continue;
        }

        const job = graph.jobs.find((candidate) => candidate.id === node.jobId);
        const engine = resolution.engineByJobId.get(node.jobId);
        if (!job || !engine) {
          throw new Error(`Missing clip-output executor for '${node.jobId}'`);
        }
        const handle = handleByJobId.get(node.jobId) ?? null;
        const committed = await engine.presentResolvedFrameJob(
          job,
          handle ?? null,
          resolution.assetsById,
          policy,
        );
        if (handle) {
          consumedHandles.add(node.jobId);
        }
        if (committed) {
          committedJobIds.add(job.id);
        } else {
          diagnostics.staleGenerationsDropped += 1;
        }
      }
      throwIfCancelled(policy, this.options.isLiveEpochCurrent);
    } catch (error) {
      for (const [jobId, handle] of handleByJobId) {
        if (!consumedHandles.has(jobId)) {
          handle?.release();
        }
      }
      throw error;
    } finally {
      diagnostics.gpuTimeMs = performance.now() - gpuStart;
    }

    for (const [jobId, handle] of handleByJobId) {
      if (!consumedHandles.has(jobId)) {
        handle?.release();
      }
    }
    diagnostics.residentSourceResources = this.store.size;
    diagnostics.outstandingLeases = this.store.totalRefCount;
    publishFramePlanningDiagnostics(diagnostics);
    this.options.onDiagnostics?.(diagnostics);
    return { committedJobIds, diagnostics };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.store.dispose();
    this.options.compositeSceneRenderer?.dispose();
  }
}

export function getTrackInputForJob(
  resolution: FrameJobResolutionResult,
  jobId: string,
): FrameJobResolutionTrack | null {
  return resolution.trackInputByJobId.get(jobId) ?? null;
}
