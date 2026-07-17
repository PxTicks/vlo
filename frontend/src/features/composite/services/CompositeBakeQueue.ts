import type { CompositeContent } from "../../../types/TimelineTypes";
import { registerProjectClosingHook } from "../../../core/project/projectLifecycleHooks";
import { resetCompositeRenderRuntimeState } from "../useCompositeRenderStatusStore";
import {
  bakeComposite,
  type BakeCompositeOptions,
  type BakedComposite,
} from "./bakeComposite";

export interface CompositeBakeRequest {
  compositeId: string;
  projectId: string | null;
  revision: number;
  requestedKey: string;
  content: CompositeContent;
  signal?: AbortSignal;
  onProgress?: (percentage: number) => void;
}

export interface CompositeBakeQueueCallbacks {
  onQueued?: (request: CompositeBakeRequest) => void;
  onStarted?: (request: CompositeBakeRequest) => void | Promise<void>;
  onProgress?: (request: CompositeBakeRequest, percentage: number) => void;
  onCompleted: (
    request: CompositeBakeRequest,
    result: BakedComposite,
  ) => void | Promise<void>;
  onFailed: (
    request: CompositeBakeRequest,
    error: unknown,
  ) => void | Promise<void>;
  onCancelled?: (request: CompositeBakeRequest) => void;
  disposeResult: (result: BakedComposite) => void | Promise<void>;
}

export interface CompositeBakeQueueOptions {
  maxConcurrent?: number;
  bake?: (
    content: CompositeContent,
    options: BakeCompositeOptions,
  ) => Promise<BakedComposite>;
}

interface QueuedBake {
  request: CompositeBakeRequest;
  callbacks: CompositeBakeQueueCallbacks;
  controller: AbortController;
  removeExternalAbortListener: () => void;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/**
 * Runtime-only bake scheduler. It bounds encoder concurrency and keeps at most
 * one latest request per composite; durable publication remains owned by the
 * composite library's compare-and-swap transaction.
 */
export class CompositeBakeQueue {
  private readonly maxConcurrent: number;
  private readonly bake: NonNullable<CompositeBakeQueueOptions["bake"]>;
  private readonly pending: QueuedBake[] = [];
  private readonly latestByCompositeId = new Map<string, QueuedBake>();
  private readonly activeByCompositeId = new Map<string, QueuedBake>();
  private readonly idleWaiters = new Set<() => void>();
  private activeCount = 0;

  constructor(options: CompositeBakeQueueOptions = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 1));
    this.bake = options.bake ?? bakeComposite;
  }

  enqueue(
    request: CompositeBakeRequest,
    callbacks: CompositeBakeQueueCallbacks,
  ): void {
    this.cancel(request.compositeId);

    const controller = new AbortController();
    const handleExternalAbort = () => controller.abort();
    if (request.signal?.aborted) {
      controller.abort();
    } else {
      request.signal?.addEventListener("abort", handleExternalAbort, {
        once: true,
      });
    }

    const queued: QueuedBake = {
      request: {
        ...request,
        content: structuredClone(request.content),
      },
      callbacks,
      controller,
      removeExternalAbortListener: () =>
        request.signal?.removeEventListener("abort", handleExternalAbort),
    };
    this.latestByCompositeId.set(request.compositeId, queued);
    this.pending.push(queued);
    callbacks.onQueued?.(queued.request);
    this.pump();
  }

  cancel(compositeId: string): void {
    const latest = this.latestByCompositeId.get(compositeId);
    if (!latest) {
      return;
    }

    latest.controller.abort();
    const pendingIndex = this.pending.indexOf(latest);
    if (pendingIndex >= 0) {
      this.pending.splice(pendingIndex, 1);
      this.finishCancelled(latest);
      this.resolveIdleIfNeeded();
    }
  }

  cancelAll(): void {
    for (const compositeId of [...this.latestByCompositeId.keys()]) {
      this.cancel(compositeId);
    }
  }

  async cancelAllAndWait(): Promise<void> {
    this.cancelAll();
    await this.whenIdle();
  }

  whenIdle(): Promise<void> {
    if (this.activeCount === 0 && this.pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  get activeJobCount(): number {
    return this.activeCount;
  }

  get queuedJobCount(): number {
    return this.pending.length;
  }

  private pump(): void {
    while (this.activeCount < this.maxConcurrent && this.pending.length > 0) {
      const nextIndex = this.pending.findIndex(
        (candidate) =>
          candidate.controller.signal.aborted ||
          this.latestByCompositeId.get(candidate.request.compositeId) !==
            candidate ||
          !this.activeByCompositeId.has(candidate.request.compositeId),
      );
      if (nextIndex < 0) {
        break;
      }
      const [next] = this.pending.splice(nextIndex, 1);
      if (!next) {
        break;
      }
      if (
        next.controller.signal.aborted ||
        this.latestByCompositeId.get(next.request.compositeId) !== next
      ) {
        this.finishCancelled(next);
        continue;
      }
      this.activeCount += 1;
      this.activeByCompositeId.set(next.request.compositeId, next);
      void this.run(next).catch((error) => {
        console.error(
          `[CompositeBakeQueue] Job cleanup failed for '${next.request.compositeId}'`,
          error,
        );
      });
    }
    this.resolveIdleIfNeeded();
  }

  private async run(job: QueuedBake): Promise<void> {
    let result: BakedComposite | null = null;
    try {
      await job.callbacks.onStarted?.(job.request);
      if (job.controller.signal.aborted || !this.isLatest(job)) {
        this.finishCancelled(job);
        return;
      }

      result = await this.bake(job.request.content, {
        signal: job.controller.signal,
        compositeAssetId: job.request.compositeId,
        compositeRevision: job.request.revision,
        onProgress: (percentage) => {
          if (!job.controller.signal.aborted && this.isLatest(job)) {
            job.request.onProgress?.(percentage);
            job.callbacks.onProgress?.(job.request, percentage);
          }
        },
      });

      if (job.controller.signal.aborted || !this.isLatest(job)) {
        await job.callbacks.disposeResult(result);
        result = null;
        this.finishCancelled(job);
        return;
      }

      await job.callbacks.onCompleted(job.request, result);
      result = null;
    } catch (error) {
      if (result) {
        await job.callbacks.disposeResult(result);
      }
      if (
        job.controller.signal.aborted ||
        !this.isLatest(job) ||
        isAbortError(error)
      ) {
        this.finishCancelled(job);
      } else {
        await job.callbacks.onFailed(job.request, error);
      }
    } finally {
      job.removeExternalAbortListener();
      if (this.activeByCompositeId.get(job.request.compositeId) === job) {
        this.activeByCompositeId.delete(job.request.compositeId);
      }
      if (this.latestByCompositeId.get(job.request.compositeId) === job) {
        this.latestByCompositeId.delete(job.request.compositeId);
      }
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.pump();
    }
  }

  private isLatest(job: QueuedBake): boolean {
    return this.latestByCompositeId.get(job.request.compositeId) === job;
  }

  private finishCancelled(job: QueuedBake): void {
    job.removeExternalAbortListener();
    if (this.latestByCompositeId.get(job.request.compositeId) === job) {
      this.latestByCompositeId.delete(job.request.compositeId);
    }
    job.callbacks.onCancelled?.(job.request);
  }

  private resolveIdleIfNeeded(): void {
    if (this.activeCount > 0 || this.pending.length > 0) {
      return;
    }
    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }
}

export const compositeBakeQueue = new CompositeBakeQueue();

export function cancelCompositeBakeJobs(): void {
  compositeBakeQueue.cancelAll();
}

export async function cancelCompositeBakeJobsAndWait(): Promise<void> {
  await compositeBakeQueue.cancelAllAndWait();
}

registerProjectClosingHook(async () => {
  await cancelCompositeBakeJobsAndWait();
  resetCompositeRenderRuntimeState();
});
