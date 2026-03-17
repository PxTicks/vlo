import { Sprite, Texture } from "pixi.js";
import type { Asset } from "../../../types/Asset";
import { DecoderWorker } from "../../renderer";

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

interface PendingStrictFrame {
  resolve: () => void;
  reject: (error: Error) => void;
}

export class MaskVideoFramePlayer {
  public readonly sprite: Sprite;

  private readonly clipId: string;
  private worker: Worker | null = null;
  private sourceAssetId: string | null = null;
  private preparePromise: Promise<void> | null = null;
  private resolvePrepare: (() => void) | null = null;
  private rejectPrepare: ((error: Error) => void) | null = null;
  private pendingStrictFrame: PendingStrictFrame | null = null;
  private readonly retiredTextures = new Set<Texture>();
  private retiredTextureFlushHandle:
    | number
    | ReturnType<typeof setTimeout>
    | null = null;
  private retiredTextureFlushKind: "raf" | "timeout" | null = null;
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

    if (this.sourceAssetId === asset.id && this.worker) {
      if (this.preparePromise) {
        await this.preparePromise;
      }
      return;
    }

    this.disposeWorker();
    this.resetSpriteFrameState();
    this.sourceAssetId = asset.id;

    const worker = new DecoderWorker();
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      this.handleWorkerMessage(worker, event);
    };

    this.preparePromise = new Promise<void>((resolve, reject) => {
      this.resolvePrepare = resolve;
      this.rejectPrepare = reject;
    });

    worker.postMessage({
      type: "prepare",
      url: asset.src,
      clipId: this.clipId,
      kind: "mask_video",
      file: asset.file,
    });

    const timeoutId = setTimeout(() => {
      this.rejectPrepare?.(
        new Error("Timed out while preparing mask video source"),
      );
      this.resolvePrepare = null;
      this.rejectPrepare = null;
    }, 20_000);

    try {
      await this.preparePromise;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async renderAt(
    timeSeconds: number,
    options: { strict?: boolean } = {},
  ): Promise<void> {
    const strict = options.strict === true;
    if (this.disposed) {
      if (strict) {
        throw new Error("Mask player has been disposed");
      }
      return;
    }

    if (!this.worker || !this.sourceAssetId) {
      if (strict) {
        throw new Error("Mask player has no source");
      }
      return;
    }

    if (this.preparePromise) {
      await this.preparePromise;
    }

    if (!strict) {
      this.worker.postMessage({
        type: "render",
        clipId: this.clipId,
        time: timeSeconds,
      });
      return;
    }

    await new Promise<void>((resolve, reject) => {
      if (this.pendingStrictFrame) {
        this.pendingStrictFrame.reject(
          new Error("Concurrent strict mask frame request"),
        );
      }
      this.pendingStrictFrame = { resolve, reject };
      this.worker?.postMessage({
        type: "render",
        clipId: this.clipId,
        time: timeSeconds,
        strict: true,
      });
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.disposeWorker();
    this.cancelRetiredTextureFlush();
    this.resetSpriteFrameState();
    this.flushRetiredTextures();

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
      this.resolvePrepare?.();
      this.resolvePrepare = null;
      this.rejectPrepare = null;
      return;
    }

    if (message.type === "frame" && message.clipId === this.clipId) {
      const pendingStrict = this.pendingStrictFrame;
      this.pendingStrictFrame = null;

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
      this.rejectPrepare?.(error);
      this.resolvePrepare = null;
      this.rejectPrepare = null;
      if (this.pendingStrictFrame) {
        this.pendingStrictFrame.reject(error);
        this.pendingStrictFrame = null;
      }
    }
  }

  private disposeWorker(): void {
    if (this.pendingStrictFrame) {
      this.pendingStrictFrame.reject(
        new Error("SAM2 mask player disposed during strict render"),
      );
      this.pendingStrictFrame = null;
    }
    this.resolvePrepare = null;
    this.rejectPrepare = null;
    this.preparePromise = null;

    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.sourceAssetId = null;
  }

  private resetSpriteFrameState(): void {
    const currentTexture = this.sprite.texture;
    this.sprite.visible = false;
    this.hasDecodedFrame = false;
    this.sprite.texture = Texture.EMPTY;
    this.destroyTexture(currentTexture);
  }

  private swapSpriteTexture(nextTexture: Texture): void {
    const previousTexture = this.sprite.texture;
    if (previousTexture === nextTexture) return;

    this.sprite.texture = nextTexture;
    this.retireTexture(previousTexture);
  }

  private retireTexture(texture: Texture | null | undefined): void {
    if (!texture || texture === Texture.EMPTY || texture.destroyed) return;
    if (texture === this.sprite.texture) return;

    this.retiredTextures.add(texture);
    this.scheduleRetiredTextureFlush();
  }

  private scheduleRetiredTextureFlush(): void {
    if (this.retiredTextureFlushHandle !== null || this.retiredTextures.size === 0) {
      return;
    }

    if (typeof requestAnimationFrame === "function") {
      this.retiredTextureFlushKind = "raf";
      this.retiredTextureFlushHandle = requestAnimationFrame(() => {
        this.retiredTextureFlushHandle = null;
        this.retiredTextureFlushKind = null;
        this.flushRetiredTextures();
      });
      return;
    }

    this.retiredTextureFlushKind = "timeout";
    this.retiredTextureFlushHandle = setTimeout(() => {
      this.retiredTextureFlushHandle = null;
      this.retiredTextureFlushKind = null;
      this.flushRetiredTextures();
    }, 0);
  }

  private cancelRetiredTextureFlush(): void {
    if (this.retiredTextureFlushHandle === null) return;

    if (
      this.retiredTextureFlushKind === "raf" &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(this.retiredTextureFlushHandle as number);
    } else {
      clearTimeout(
        this.retiredTextureFlushHandle as ReturnType<typeof setTimeout>,
      );
    }

    this.retiredTextureFlushHandle = null;
    this.retiredTextureFlushKind = null;
  }

  private flushRetiredTextures(): void {
    const activeTexture = this.sprite.texture;
    for (const texture of this.retiredTextures) {
      if (texture === activeTexture) continue;
      this.destroyTexture(texture);
      this.retiredTextures.delete(texture);
    }
  }

  private destroyTexture(texture: Texture | null | undefined): void {
    if (!texture || texture === Texture.EMPTY || texture.destroyed) return;
    texture.destroy(true);
  }
}
