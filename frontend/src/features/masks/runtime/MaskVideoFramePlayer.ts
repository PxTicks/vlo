import { Sprite, Texture } from "pixi.js";
import type { Asset } from "../../../types/Asset";
import {
  isSourceFrameIntentCurrent,
  type SourceFrameSyncIntent,
  type SourceFrameSyncRef,
} from "../../renderer/utils/sourceFrameSync";
import { hasEmbeddedAssetSource } from "../../renderer/utils/assetSource";
import {
  RetiredTextureQueue,
  destroyTexture,
} from "../../renderer/utils/retiredTextureQueue";
import {
  createDecoderRequestDiagnostics,
  logDecoderRequestAborted,
  logDecoderRequestSent,
  logDecoderRequestTimeout,
} from "../../renderer/utils/decoderDiagnostics";
import {
  getSharedDecoderWorkerPool,
  type DecoderLease,
  type DecoderStallResolution,
  type DecoderWorkerPool,
} from "../../renderer/services/DecoderWorkerPool";
import {
  awaitStrictFrame,
  type StrictFramePending,
} from "../../renderer/utils/strictFrameRequest";
import { ensureAssetSourceLoaded } from "../../userAssets";

function createMaskRenderAbortError(
  message: string = "Mask render cancelled",
): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function createMaskSourcePrepareTimeoutError(timeoutMs: number): Error {
  const error = new Error(
    `Timed out waiting ${timeoutMs}ms to prepare mask video source`,
  );
  error.name = "TimeoutError";
  return error;
}

function createMaskFrameTimeoutError(timeoutMs: number): Error {
  const error = new Error(
    `Timed out waiting ${timeoutMs}ms for strict mask frame`,
  );
  error.name = "TimeoutError";
  return error;
}

function getSourceScheme(asset: Asset): string {
  if (asset.file) {
    return "blob-file";
  }

  const separatorIndex = asset.src.indexOf(":");
  return separatorIndex > 0 ? asset.src.slice(0, separatorIndex) : "relative";
}

export class MaskVideoFramePlayer {
  private static readonly SOURCE_PREPARE_TIMEOUT_MS = 5000;
  private static readonly SOURCE_PREPARE_RECOVERY_ATTEMPTS = 1;
  private static readonly STRICT_FRAME_TIMEOUT_MS = 5000;
  private static readonly STRICT_FRAME_RECOVERY_ATTEMPTS = 1;
  private static readonly DECODER_RESET_TIMEOUTS = 2;

  public readonly sprite: Sprite;

  private readonly clipId: string;
  private readonly lease: DecoderLease;
  private readonly onFrameReady: (() => void) | undefined;
  private sourceAsset: Asset | null = null;
  private sourceAssetId: string | null = null;
  private sourcePrepared = false;
  private preparePromise: Promise<void> | null = null;
  private resolvePrepare: (() => void) | null = null;
  private rejectPrepare: ((error: Error) => void) | null = null;
  private prepareTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private pendingStrictFrame: StrictFramePending<void> | null = null;
  private pendingStrictFrameRequestId: string | null = null;
  private pendingStrictFrameIntent: SourceFrameSyncIntent | null = null;
  private nextRenderRequestId = 0;
  private latestRenderRequestId: string | null = null;
  private latestRenderIntent: SourceFrameSyncIntent | null = null;
  private readonly renderIntentByRequestId = new Map<
    string,
    SourceFrameSyncIntent
  >();
  private strictRenderGeneration = 0;
  private decoderTimeoutCount = 0;
  private strictRenderChain: Promise<void> = Promise.resolve();
  private readonly retiredTextures = new RetiredTextureQueue(
    () => this.sprite.texture,
  );
  private hasDecodedFrame = false;
  private disposed = false;

  constructor(
    maskClipId: string,
    onFrameReady?: () => void,
    options: { decoderPool?: DecoderWorkerPool } = {},
  ) {
    this.clipId = `mask_video_${maskClipId}`;
    this.onFrameReady = onFrameReady;
    this.lease = (options.decoderPool ?? getSharedDecoderWorkerPool()).acquireLease(
      { label: this.clipId },
      {
        onReady: (clipId) => {
          this.handleLeaseReady(clipId);
        },
        onFrame: (message) => {
          this.handleLeaseFrame(message);
        },
        onWorkerError: (error) => {
          this.handleLeaseWorkerError(error);
        },
        onSourceEvicted: (clipId) => {
          this.handleSourceEvicted(clipId);
        },
      },
    );
    this.sprite = new Sprite();
    this.sprite.anchor.set(0.5);
    this.sprite.visible = false;
  }

  public async setSource(asset: Asset): Promise<void> {
    if (this.disposed) return;

    if (this.sourceAssetId !== asset.id) {
      this.rejectPendingStrictFrame(
        createMaskRenderAbortError("Mask source switched during strict render"),
      );
      this.rejectPendingPrepare(
        createMaskRenderAbortError("Mask source switched during source prepare"),
      );
      this.lease.disposeSource(this.clipId);
      this.sourcePrepared = false;
      this.latestRenderRequestId = null;
      this.latestRenderIntent = null;
      this.renderIntentByRequestId.clear();
      this.decoderTimeoutCount = 0;
      this.resetSpriteFrameState();
      this.sourceAssetId = asset.id;
      this.sourceAsset = null;
    }

    if (this.sourcePrepared) {
      return;
    }

    if (!this.sourceAsset) {
      const hydratedAsset = await this.hydrateSourceAsset(asset);
      if (this.disposed || this.sourceAssetId !== asset.id) {
        return;
      }
      this.sourceAsset = hydratedAsset;
    }

    await this.ensureSourcePrepared();
  }

  public async renderAt(
    sourceFrame: SourceFrameSyncRef,
    options: { strict?: boolean } = {},
  ): Promise<void> {
    const strict = options.strict === true;
    if (this.disposed) {
      if (strict) {
        throw createMaskRenderAbortError("Mask player has been disposed");
      }
      return;
    }

    if (!this.sourceAssetId) {
      if (strict) {
        throw createMaskRenderAbortError("Mask player has no source");
      }
      return;
    }

    if (this.preparePromise) {
      await this.preparePromise;
    }

    if (!this.sourcePrepared) {
      if (strict) {
        throw createMaskRenderAbortError("Mask player has no prepared source");
      }
      return;
    }

    if (!strict) {
      const requestId = this.createRenderRequestId();
      const intent = this.toSourceFrameIntent(sourceFrame);
      this.latestRenderRequestId = requestId;
      this.latestRenderIntent = intent;
      this.renderIntentByRequestId.set(requestId, intent);
      const diagnostics = createDecoderRequestDiagnostics({
        source: "mask",
        requestType: "render",
        clipId: this.clipId,
        label: this.sourceAssetId ?? undefined,
      });
      logDecoderRequestSent(diagnostics, {
        time: sourceFrame.snappedTimeSeconds,
        sourceFrameKey: sourceFrame.key,
        generation: sourceFrame.generation,
        strict: false,
        requestId,
      });
      this.lease.render({
        clipId: this.clipId,
        time: sourceFrame.snappedTimeSeconds,
        requestId,
        ...(diagnostics ? { diagnostics } : {}),
      });
      return;
    }

    const generation = this.createStrictRenderGeneration();
    this.rejectPendingStrictFrame(
      createMaskRenderAbortError("Mask strict frame superseded"),
    );
    const previousStrictRender = this.strictRenderChain.catch(() => undefined);
    const nextStrictRender = previousStrictRender.then(() => {
      if (!this.isStrictRenderCurrent(generation)) {
        return;
      }
      return this.renderStrictFrameWithRecovery(sourceFrame, generation);
    });
    this.strictRenderChain = nextStrictRender.catch(() => undefined);
    await nextStrictRender;
  }

  public hasFrame(): boolean {
    return this.hasDecodedFrame;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.rejectPendingStrictFrame(createMaskRenderAbortError());
    this.rejectPendingPrepare(
      createMaskRenderAbortError("Mask player disposed during source prepare"),
    );
    this.lease.release();
    this.sourcePrepared = false;
    this.sourceAsset = null;
    this.sourceAssetId = null;
    this.retiredTextures.cancel();
    this.resetSpriteFrameState();
    this.retiredTextures.flush();

    if (!this.sprite.destroyed) {
      this.sprite.destroy();
    }
  }

  private handleLeaseReady(clipId: string): void {
    if (this.disposed || clipId !== this.clipId) {
      return;
    }

    this.markDecoderResponsive();
    this.resolvePendingPrepare();
  }

  private handleLeaseFrame(message: {
    clipId: string;
    bitmap: ImageBitmap | null;
    requestId?: string;
    error?: string;
  }): void {
    if (this.disposed || message.clipId !== this.clipId) {
      if (message.bitmap) {
        message.bitmap.close();
      }
      return;
    }

    this.markDecoderResponsive();
    if (this.isStaleFrameResponse(message)) {
      return;
    }

    const pendingStrict = this.pendingStrictFrame;
    if (pendingStrict && this.isStaleStrictFrameResponse(message)) {
      return;
    }

    if (message.error) {
      pendingStrict?.reject(new Error(message.error));
      return;
    }

    const bitmap = message.bitmap;
    if (bitmap) {
      const nextTexture = Texture.from(bitmap);
      this.swapSpriteTexture(nextTexture);
      this.hasDecodedFrame = true;
      this.sprite.visible = true;
      if (!pendingStrict) {
        this.onFrameReady?.();
      }
    } else if (!this.hasDecodedFrame) {
      this.sprite.visible = false;
    }

    pendingStrict?.resolve();
  }

  private handleLeaseWorkerError(error: Error): void {
    this.rejectPendingPrepare(error);
    this.rejectPendingStrictFrame(error);
  }

  private handleSourceEvicted(clipId: string): void {
    if (clipId !== this.clipId) {
      return;
    }

    this.rejectPendingPrepare(
      createMaskRenderAbortError("Mask source evicted during source prepare"),
    );
    this.rejectPendingStrictFrame(
      createMaskRenderAbortError("Mask source evicted during strict render"),
    );
    this.sourcePrepared = false;
    this.latestRenderRequestId = null;
    this.latestRenderIntent = null;
    this.renderIntentByRequestId.clear();
    this.decoderTimeoutCount = 0;
  }

  private async hydrateSourceAsset(asset: Asset): Promise<Asset> {
    if (hasEmbeddedAssetSource(asset)) {
      return asset;
    }

    const hydratedAsset = await ensureAssetSourceLoaded(asset.id);
    if (!hydratedAsset) {
      throw new Error("Failed to hydrate mask video source");
    }
    return hydratedAsset;
  }

  private async ensureSourcePrepared(): Promise<void> {
    if (this.disposed || this.sourcePrepared) {
      return;
    }

    if (!this.sourceAsset || !this.sourceAssetId) {
      throw createMaskRenderAbortError("Mask player has no source");
    }

    for (
      let attempt = 0;
      attempt <= MaskVideoFramePlayer.SOURCE_PREPARE_RECOVERY_ATTEMPTS;
      attempt += 1
    ) {
      if (!this.preparePromise) {
        this.beginPreparingSource(this.sourceAsset);
      }

      try {
        await this.preparePromise;
        return;
      } catch (error) {
        if (this.disposed) {
          return;
        }

        if (
          error instanceof Error &&
          error.name === "TimeoutError"
        ) {
          const shouldRecover = this.recordDecoderTimeout();
          if (
            !shouldRecover ||
            attempt >= MaskVideoFramePlayer.SOURCE_PREPARE_RECOVERY_ATTEMPTS
          ) {
            throw error;
          }

          const resolution = await this.recoverStalledDecoder(
            "mask source prepare timeout",
          );
          if (
            resolution !== "renderer-reset" &&
            resolution !== "worker-replaced"
          ) {
            throw error;
          }

          console.warn(
            "Mask decoder worker stalled while preparing source; recovering decoder source",
            error,
          );
          continue;
        }

        throw error;
      }
    }
  }

  private beginPreparingSource(asset: Asset): void {
    this.sourcePrepared = false;
    this.preparePromise = new Promise<void>((resolve, reject) => {
      this.resolvePrepare = resolve;
      this.rejectPrepare = reject;
    });

    const diagnostics = createDecoderRequestDiagnostics({
      source: "mask",
      requestType: "prepare",
      clipId: this.clipId,
      label: this.sourceAssetId ?? undefined,
    });

    this.prepareTimeoutHandle = setTimeout(() => {
      logDecoderRequestTimeout(diagnostics, {
        timeoutMs: MaskVideoFramePlayer.SOURCE_PREPARE_TIMEOUT_MS,
      });
      this.rejectPendingPrepare(
        createMaskSourcePrepareTimeoutError(
          MaskVideoFramePlayer.SOURCE_PREPARE_TIMEOUT_MS,
        ),
      );
    }, MaskVideoFramePlayer.SOURCE_PREPARE_TIMEOUT_MS);

    logDecoderRequestSent(diagnostics, {
      kind: "mask_video",
      hasFile: !!asset.file,
      fileSizeMB: asset.file
        ? Number((asset.file.size / (1024 * 1024)).toFixed(2))
        : null,
      sourceScheme: getSourceScheme(asset),
      timeoutMs: MaskVideoFramePlayer.SOURCE_PREPARE_TIMEOUT_MS,
    });

    this.lease.prepare({
      url: asset.src,
      clipId: this.clipId,
      kind: "mask_video",
      file: asset.file,
      ...(diagnostics ? { diagnostics } : {}),
    });
  }

  private resolvePendingPrepare(): void {
    const resolvePrepare = this.resolvePrepare;
    this.clearPrepareState();
    this.sourcePrepared = true;
    resolvePrepare?.();
  }

  private rejectPendingPrepare(error: Error): void {
    const rejectPrepare = this.rejectPrepare;
    this.clearPrepareState();
    this.sourcePrepared = false;
    rejectPrepare?.(error);
  }

  private clearPrepareState(): void {
    if (this.prepareTimeoutHandle !== null) {
      clearTimeout(this.prepareTimeoutHandle);
      this.prepareTimeoutHandle = null;
    }
    this.preparePromise = null;
    this.resolvePrepare = null;
    this.rejectPrepare = null;
  }

  private resetSpriteFrameState(): void {
    const currentTexture = this.sprite.texture;
    this.sprite.visible = false;
    this.hasDecodedFrame = false;
    this.sprite.texture = Texture.EMPTY;
    destroyTexture(currentTexture);
  }

  private swapSpriteTexture(nextTexture: Texture): void {
    const previousTexture = this.sprite.texture;
    if (previousTexture === nextTexture) return;

    this.sprite.texture = nextTexture;
    this.retiredTextures.retire(previousTexture);
  }

  private async renderStrictFrameWithRecovery(
    sourceFrame: SourceFrameSyncRef,
    generation: number,
  ): Promise<void> {
    for (
      let attempt = 0;
      attempt <= MaskVideoFramePlayer.STRICT_FRAME_RECOVERY_ATTEMPTS;
      attempt += 1
    ) {
      if (!this.isStrictRenderCurrent(generation)) {
        return;
      }

      try {
        await this.requestStrictFrame(sourceFrame);
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }

        if (
          error instanceof Error &&
          error.name === "TimeoutError"
        ) {
          if (!this.isStrictRenderCurrent(generation)) {
            return;
          }

          const shouldRecover = this.recordDecoderTimeout();
          if (
            !shouldRecover ||
            attempt >= MaskVideoFramePlayer.STRICT_FRAME_RECOVERY_ATTEMPTS
          ) {
            throw error;
          }

          const resolution = await this.recoverStalledDecoder(
            "strict mask frame timeout",
          );
          if (
            resolution !== "renderer-reset" &&
            resolution !== "worker-replaced"
          ) {
            throw error;
          }

          console.warn(
            "Mask decoder worker stalled while rendering strict frame; recovering decoder source",
            error,
          );
          await this.ensureSourcePrepared();
          continue;
        }

        throw error;
      }
    }
  }

  private async requestStrictFrame(sourceFrame: SourceFrameSyncRef): Promise<void> {
    if (this.disposed) {
      throw createMaskRenderAbortError("Mask player has been disposed");
    }

    if (!this.sourceAssetId) {
      throw createMaskRenderAbortError("Mask player has no source");
    }

    if (this.preparePromise) {
      await this.preparePromise;
    }

    if (this.disposed) {
      throw createMaskRenderAbortError("Mask player has been disposed");
    }

    if (!this.sourceAssetId || !this.sourcePrepared) {
      throw createMaskRenderAbortError("Mask player has no prepared source");
    }
    const requestId = this.createRenderRequestId();
    const intent = this.toSourceFrameIntent(sourceFrame);
    this.latestRenderRequestId = requestId;
    this.latestRenderIntent = intent;
    this.renderIntentByRequestId.set(requestId, intent);
    const diagnostics = createDecoderRequestDiagnostics({
      source: "mask",
      requestType: "render",
      clipId: this.clipId,
      label: this.sourceAssetId ?? undefined,
    });

    await awaitStrictFrame<void>({
      timeoutMs: MaskVideoFramePlayer.STRICT_FRAME_TIMEOUT_MS,
      createTimeoutError: (timeoutMs) => {
        logDecoderRequestTimeout(diagnostics, {
          timeoutMs,
          time: sourceFrame.snappedTimeSeconds,
          sourceFrameKey: sourceFrame.key,
          generation: sourceFrame.generation,
          requestId,
        });
        return createMaskFrameTimeoutError(timeoutMs);
      },
      registerPending: (pending) => {
        this.pendingStrictFrame = pending;
        this.pendingStrictFrameRequestId = requestId;
        this.pendingStrictFrameIntent = intent;
      },
      unregisterPending: (pending) => {
        if (this.pendingStrictFrame === pending) {
          this.pendingStrictFrame = null;
          this.pendingStrictFrameRequestId = null;
          this.pendingStrictFrameIntent = null;
        }
      },
      onExternalReject: (error) => {
        logDecoderRequestAborted(diagnostics, {
          reason: error.name,
          message: error.message,
          time: sourceFrame.snappedTimeSeconds,
          sourceFrameKey: sourceFrame.key,
          generation: sourceFrame.generation,
          requestId,
        });
      },
      sendRequest: () => {
        logDecoderRequestSent(diagnostics, {
          time: sourceFrame.snappedTimeSeconds,
          sourceFrameKey: sourceFrame.key,
          generation: sourceFrame.generation,
          strict: true,
          requestId,
          timeoutMs: MaskVideoFramePlayer.STRICT_FRAME_TIMEOUT_MS,
        });
        this.lease.render({
          clipId: this.clipId,
          time: sourceFrame.snappedTimeSeconds,
          strict: true,
          requestId,
          ...(diagnostics ? { diagnostics } : {}),
        });
      },
    });
  }

  private createRenderRequestId(): string {
    this.nextRenderRequestId += 1;
    return `mask-frame-${this.nextRenderRequestId}`;
  }

  private toSourceFrameIntent(
    sourceFrame: SourceFrameSyncRef,
  ): SourceFrameSyncIntent {
    return {
      generation: sourceFrame.generation,
      key: sourceFrame.key,
    };
  }

  private createStrictRenderGeneration(): number {
    this.strictRenderGeneration += 1;
    return this.strictRenderGeneration;
  }

  private isStrictRenderCurrent(generation: number): boolean {
    return generation === this.strictRenderGeneration;
  }

  private recordDecoderTimeout(): boolean {
    this.decoderTimeoutCount += 1;
    return (
      this.decoderTimeoutCount >= MaskVideoFramePlayer.DECODER_RESET_TIMEOUTS
    );
  }

  private markDecoderResponsive(): void {
    this.decoderTimeoutCount = 0;
  }

  private async recoverStalledDecoder(
    reason: string,
  ): Promise<DecoderStallResolution> {
    this.rejectPendingStrictFrame(
      createMaskRenderAbortError("Mask decoder recovery superseded strict render"),
    );
    this.latestRenderRequestId = null;
    this.latestRenderIntent = null;
    this.renderIntentByRequestId.clear();
    const resolution = await this.lease.reportStall(this.clipId, reason);
    if (
      resolution === "renderer-reset" ||
      resolution === "worker-replaced"
    ) {
      this.sourcePrepared = false;
      this.decoderTimeoutCount = 0;
    }
    return resolution;
  }

  private rejectPendingStrictFrame(error: Error): void {
    this.pendingStrictFrame?.reject(error);
    this.pendingStrictFrameRequestId = null;
    this.pendingStrictFrameIntent = null;
  }

  private isStaleFrameResponse(message: {
    bitmap: ImageBitmap | null;
    requestId?: string;
  }): boolean {
    const responseIntent =
      typeof message.requestId === "string"
        ? (this.renderIntentByRequestId.get(message.requestId) ?? null)
        : null;
    if (typeof message.requestId === "string") {
      this.renderIntentByRequestId.delete(message.requestId);
    }
    if (
      responseIntent &&
      !isSourceFrameIntentCurrent(this.latestRenderIntent, responseIntent)
    ) {
      if (message.bitmap && typeof message.bitmap.close === "function") {
        message.bitmap.close();
      }
      return true;
    }

    if (
      !this.latestRenderRequestId ||
      typeof message.requestId !== "string" ||
      message.requestId === this.latestRenderRequestId
    ) {
      return false;
    }

    if (message.bitmap && typeof message.bitmap.close === "function") {
      message.bitmap.close();
    }
    return true;
  }

  private isStaleStrictFrameResponse(message: {
    bitmap: ImageBitmap | null;
    requestId?: string;
  }): boolean {
    const expectedRequestId = this.pendingStrictFrameRequestId;
    const expectedIntent = this.pendingStrictFrameIntent;
    if (
      !expectedRequestId ||
      typeof message.requestId !== "string" ||
      message.requestId === expectedRequestId
    ) {
      if (
        expectedIntent &&
        !isSourceFrameIntentCurrent(this.latestRenderIntent, expectedIntent)
      ) {
        if (message.bitmap && typeof message.bitmap.close === "function") {
          message.bitmap.close();
        }
        return true;
      }
      return false;
    }

    if (message.bitmap && typeof message.bitmap.close === "function") {
      message.bitmap.close();
    }
    return true;
  }
}
