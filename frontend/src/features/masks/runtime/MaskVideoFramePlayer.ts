import { Sprite, Texture } from "pixi.js";
import type { Asset } from "../../../types/Asset";
import { DecoderWorker } from "../../renderer";
import { hasEmbeddedAssetSource } from "../../renderer/utils/assetSource";
import {
  RetiredTextureQueue,
  destroyTexture,
} from "../../renderer/utils/retiredTextureQueue";
import {
  awaitStrictFrame,
  type StrictFramePending,
} from "../../renderer/utils/strictFrameRequest";
import { ensureAssetSourceLoaded } from "../../userAssets";

interface WorkerReadyMessage {
  type: "ready";
  clipId: string;
}

interface WorkerFrameMessage {
  type: "frame";
  clipId: string;
  bitmap: ImageBitmap | null;
  error?: string;
}

interface WorkerErrorMessage {
  type: "error";
  message?: string;
}

type WorkerMessage = WorkerReadyMessage | WorkerFrameMessage | WorkerErrorMessage;

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

export class MaskVideoFramePlayer {
  private static readonly SOURCE_PREPARE_TIMEOUT_MS = 1500;
  private static readonly SOURCE_PREPARE_RECOVERY_ATTEMPTS = 1;
  private static readonly STRICT_FRAME_TIMEOUT_MS = 1500;
  private static readonly STRICT_FRAME_RECOVERY_ATTEMPTS = 1;

  public readonly sprite: Sprite;

  private readonly clipId: string;
  private worker: Worker | null = null;
  private sourceAsset: Asset | null = null;
  private sourceAssetId: string | null = null;
  private sourcePrepared = false;
  private preparePromise: Promise<void> | null = null;
  private resolvePrepare: (() => void) | null = null;
  private rejectPrepare: ((error: Error) => void) | null = null;
  private prepareTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private pendingStrictFrame: StrictFramePending<void> | null = null;
  private strictRenderChain: Promise<void> = Promise.resolve();
  private readonly retiredTextures = new RetiredTextureQueue(
    () => this.sprite.texture,
  );
  private hasDecodedFrame = false;
  private disposed = false;

  constructor(maskClipId: string) {
    this.clipId = `mask_video_${maskClipId}`;
    this.sprite = new Sprite();
    this.sprite.anchor.set(0.5);
    this.sprite.visible = false;
  }

  public async setSource(asset: Asset): Promise<void> {
    if (this.disposed) return;

    if (this.sourceAssetId !== asset.id) {
      this.disposeWorker({ abortReason: "Mask source switched" });
      this.resetSpriteFrameState();
      this.sourceAssetId = asset.id;
      this.sourceAsset = null;
    }

    if (this.sourcePrepared && this.worker) {
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
    timeSeconds: number,
    options: { strict?: boolean } = {},
  ): Promise<void> {
    const strict = options.strict === true;
    if (this.disposed) {
      if (strict) {
        throw createMaskRenderAbortError("Mask player has been disposed");
      }
      return;
    }

    if (!this.worker || !this.sourceAssetId) {
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
      this.worker.postMessage({
        type: "render",
        clipId: this.clipId,
        time: timeSeconds,
      });
      return;
    }

    const previousStrictRender = this.strictRenderChain.catch(() => undefined);
    const nextStrictRender = previousStrictRender.then(() =>
      this.renderStrictFrameWithRecovery(timeSeconds),
    );
    this.strictRenderChain = nextStrictRender.catch(() => undefined);
    await nextStrictRender;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.disposeWorker();
    this.retiredTextures.cancel();
    this.resetSpriteFrameState();
    this.retiredTextures.flush();

    if (!this.sprite.destroyed) {
      this.sprite.destroy();
    }
  }

  private handleWorkerMessage(
    sourceWorker: Worker,
    event: MessageEvent<WorkerMessage>,
  ): void {
    if (this.disposed || sourceWorker !== this.worker) return;

    const message = event.data;

    if (message.type === "ready" && message.clipId === this.clipId) {
      this.resolvePendingPrepare();
      return;
    }

    if (message.type === "frame" && message.clipId === this.clipId) {
      const pendingStrict = this.pendingStrictFrame;

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
      } else if (!this.hasDecodedFrame) {
        // Before the first decoded frame, keep mask hidden.
        this.sprite.visible = false;
      }

      pendingStrict?.resolve();
      return;
    }

    if (message.type === "error") {
      const error = new Error(
        message.message || "Mask video decode worker error",
      );
      this.rejectPendingPrepare(error);
      this.pendingStrictFrame?.reject(error);
    }
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
          error.name === "TimeoutError" &&
          attempt < MaskVideoFramePlayer.SOURCE_PREPARE_RECOVERY_ATTEMPTS
        ) {
          console.warn(
            "Mask decoder worker stalled while preparing source; recreating worker",
            error,
          );
          this.resetStalledDecoderWorker();
          continue;
        }

        throw error;
      }
    }
  }

  private beginPreparingSource(asset: Asset): void {
    if (!this.worker) {
      this.worker = this.createWorker();
    }

    this.sourcePrepared = false;
    this.preparePromise = new Promise<void>((resolve, reject) => {
      this.resolvePrepare = resolve;
      this.rejectPrepare = reject;
    });

    this.prepareTimeoutHandle = setTimeout(() => {
      this.rejectPendingPrepare(
        createMaskSourcePrepareTimeoutError(
          MaskVideoFramePlayer.SOURCE_PREPARE_TIMEOUT_MS,
        ),
      );
    }, MaskVideoFramePlayer.SOURCE_PREPARE_TIMEOUT_MS);

    this.worker.postMessage({
      type: "prepare",
      url: asset.src,
      clipId: this.clipId,
      kind: "mask_video",
      file: asset.file,
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

  private createWorker(): Worker {
    const worker = new DecoderWorker();
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      this.handleWorkerMessage(worker, event);
    };
    return worker;
  }

  private disposeWorker(
    options: {
      abortReason?: string;
      preserveSource?: boolean;
    } = {},
  ): void {
    const {
      abortReason = "Mask player disposed",
      preserveSource = false,
    } = options;
    this.pendingStrictFrame?.reject(
      createMaskRenderAbortError(`${abortReason} during strict render`),
    );
    this.rejectPendingPrepare(
      createMaskRenderAbortError(`${abortReason} during source prepare`),
    );

    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.sourcePrepared = false;

    if (!preserveSource) {
      this.sourceAsset = null;
      this.sourceAssetId = null;
    }
  }

  private resetStalledDecoderWorker(): void {
    this.disposeWorker({
      abortReason: "Mask decoder worker reset",
      preserveSource: true,
    });
    this.worker = this.createWorker();
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
    timeSeconds: number,
  ): Promise<void> {
    for (
      let attempt = 0;
      attempt <= MaskVideoFramePlayer.STRICT_FRAME_RECOVERY_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await this.requestStrictFrame(timeSeconds);
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }

        if (
          error instanceof Error &&
          error.name === "TimeoutError" &&
          attempt < MaskVideoFramePlayer.STRICT_FRAME_RECOVERY_ATTEMPTS
        ) {
          console.warn(
            "Mask decoder worker stalled while rendering strict frame; recreating worker",
            error,
          );
          this.resetStalledDecoderWorker();
          await this.ensureSourcePrepared();
          continue;
        }

        throw error;
      }
    }
  }

  private async requestStrictFrame(timeSeconds: number): Promise<void> {
    if (this.disposed) {
      throw createMaskRenderAbortError("Mask player has been disposed");
    }

    if (!this.worker || !this.sourceAssetId) {
      throw createMaskRenderAbortError("Mask player has no source");
    }

    if (this.preparePromise) {
      await this.preparePromise;
    }

    if (this.disposed) {
      throw createMaskRenderAbortError("Mask player has been disposed");
    }

    const worker = this.worker;
    if (!worker || !this.sourceAssetId || !this.sourcePrepared) {
      throw createMaskRenderAbortError("Mask player has no prepared source");
    }

    await awaitStrictFrame<void>({
      timeoutMs: MaskVideoFramePlayer.STRICT_FRAME_TIMEOUT_MS,
      createTimeoutError: createMaskFrameTimeoutError,
      registerPending: (pending) => {
        this.pendingStrictFrame = pending;
      },
      unregisterPending: (pending) => {
        if (this.pendingStrictFrame === pending) {
          this.pendingStrictFrame = null;
        }
      },
      sendRequest: () => {
        worker.postMessage({
          type: "render",
          clipId: this.clipId,
          time: timeSeconds,
          strict: true,
        });
      },
    });
  }
}
