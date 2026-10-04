import { projectMutationGuard } from "../../../core/project/projectMutationGuard";
import { registerProjectClosingHook } from "../../../core/project/projectLifecycleHooks";
import type { Asset } from "../../../types/Asset";
import { mediaProcessingService } from "./MediaProcessingService";

type AssetCreationSource = NonNullable<Asset["creationMetadata"]>["source"];

/** Masks feed the compositor and never draw a filmstrip, so they skip it. */
const PROXY_EXEMPT_SOURCES = new Set<AssetCreationSource>([
  "sam2_mask",
  "brush_mask",
  "generation_mask",
]);

/**
 * Whether an asset still lacks a proxy it should have. A video whose proxy
 * file failed to load counts as missing, so it is regenerated over the path.
 */
export function needsProxy(asset: Asset): boolean {
  if (asset.type !== "video" || asset.proxyFile) {
    return false;
  }
  const source = asset.creationMetadata?.source;
  return !source || !PROXY_EXEMPT_SOURCES.has(source);
}

export function resolveProxyStoragePath(assetName: string): string {
  return `.vloproject/proxies/${assetName}_proxy.mp4`;
}

export interface ProxyJob {
  assetId: string;
  assetName: string;
  /** Resolves the bytes to transcode, read when the job starts. */
  loadSource: () => Promise<File>;
  /**
   * Stores the finished proxy. `signal` aborts when the asset is deleted or
   * the project closes, so it must be checked after every await.
   */
  commit: (proxy: Blob, signal: AbortSignal) => Promise<void>;
}

interface QueuedProxyJob extends ProxyJob {
  /** Aborts for good: the asset was deleted or the project closed. */
  controller: AbortController;
}

/** A transcode an export interrupted; the job runs again after it. */
const PAUSED_FOR_EXPORT = Symbol("paused-for-export");

/**
 * Generates proxies after import, one at a time, off the asset ingest queue.
 *
 * The proxy only feeds timeline filmstrips, which fall back to the source
 * until it lands, so an asset is usable as soon as its metadata is read.
 * Transcoding is the slowest part of an import by far, and running it inside
 * ingest held every later import (generated outputs included) behind it.
 */
export class ProxyGenerationService {
  private pending: QueuedProxyJob[] = [];
  private active: QueuedProxyJob | null = null;
  private draining: Promise<void> | null = null;
  // Retried on the next session rather than on every enqueue, so a source the
  // encoder cannot handle is not transcoded again on each project load.
  private readonly failedAssetIds = new Set<string>();

  enqueue(job: ProxyJob): void {
    if (this.failedAssetIds.has(job.assetId) || this.has(job.assetId)) {
      return;
    }
    this.pending.push({ ...job, controller: new AbortController() });
    this.drain();
  }

  has(assetId: string): boolean {
    return (
      this.active?.assetId === assetId ||
      this.pending.some((job) => job.assetId === assetId)
    );
  }

  cancel(assetId: string): void {
    this.pending = this.pending.filter((job) => {
      if (job.assetId !== assetId) return true;
      job.controller.abort();
      return false;
    });
    if (this.active?.assetId === assetId) {
      this.active.controller.abort();
    }
  }

  cancelAll(): void {
    for (const job of this.pending) {
      job.controller.abort();
    }
    this.pending = [];
    this.active?.controller.abort();
  }

  /** Settles once the queue has run dry. */
  whenIdle(): Promise<void> {
    return this.draining ?? Promise.resolve();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = (async () => {
      try {
        while (this.pending.length > 0) {
          // An export renders in this tab and wants the encoder; the proxy
          // can wait for it to finish.
          while (projectMutationGuard.isFrozen()) {
            await projectMutationGuard.untilUnfrozen();
          }
          const job = this.pending.shift();
          if (!job) break;
          this.active = job;
          try {
            await this.run(job);
          } finally {
            this.active = null;
          }
        }
      } finally {
        this.draining = null;
      }
    })();
  }

  private async run(job: QueuedProxyJob): Promise<void> {
    const { signal } = job.controller;
    const startedAt = performance.now();
    console.log(`[Proxy] Generating proxy for ${job.assetName}...`);

    try {
      const proxy = await this.transcode(job);
      if (signal.aborted) return;
      if (proxy === PAUSED_FOR_EXPORT) {
        console.log(`[Proxy] Paused ${job.assetName} for an export`);
        this.pending.unshift(job);
        return;
      }
      if (!proxy) {
        this.failedAssetIds.add(job.assetId);
        console.warn(`[Proxy] No proxy produced for ${job.assetName}`);
        return;
      }

      await job.commit(proxy, signal);
      if (signal.aborted) return;
      console.log(
        `[Proxy] Proxy ready for ${job.assetName} in ${Math.round(
          performance.now() - startedAt,
        )}ms`,
      );
    } catch (error) {
      if (signal.aborted) return;
      this.failedAssetIds.add(job.assetId);
      console.warn(`[Proxy] Failed to generate proxy for ${job.assetName}`, error);
    }
  }

  /**
   * Reads and converts the source. The queue only starts a job while no
   * export runs, but an export that starts mid-transcode would compete with
   * it for the encoder, so the conversion stops and the job starts over after.
   */
  private async transcode(
    job: QueuedProxyJob,
  ): Promise<Blob | null | typeof PAUSED_FOR_EXPORT> {
    const cancelled = job.controller.signal;
    const conversion = new AbortController();
    const stop = () => conversion.abort();
    cancelled.addEventListener("abort", stop, { once: true });
    const unsubscribeFreeze = projectMutationGuard.onFreeze(stop);

    try {
      const source = await job.loadSource();
      const proxy = await mediaProcessingService.generateProxyVideo(source, {
        signal: conversion.signal,
      });
      // A proxy that finished as the export began is kept: committing it
      // already waits for the export to end.
      if (!proxy && conversion.signal.aborted && !cancelled.aborted) {
        return PAUSED_FOR_EXPORT;
      }
      return proxy;
    } finally {
      unsubscribeFreeze();
      cancelled.removeEventListener("abort", stop);
    }
  }
}

export const proxyGenerationService = new ProxyGenerationService();

registerProjectClosingHook(() => proxyGenerationService.cancelAll());
