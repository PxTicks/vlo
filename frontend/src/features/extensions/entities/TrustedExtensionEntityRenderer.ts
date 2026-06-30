import { Container, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";
import type { Asset } from "../../../types/Asset";
import type { ExtensionTimelineClip } from "../../../types/TimelineTypes";
import type {
  ExtensionEntityAssetSnapshot,
  ExtensionEntityRenderContext,
} from "../types";
import {
  extensionEntityProviderRegistry,
  type RegisteredExtensionEntityProvider,
} from "./ExtensionEntityProviderRegistry";
import { extensionPayloadProviderRegistry } from "../persistence/ExtensionPayloadProviderRegistry";

export interface ExtensionEntityFrameInput {
  readonly clip: ExtensionTimelineClip;
  readonly logicalDimensions: Readonly<{ width: number; height: number }>;
  readonly presentationTimeTicks: number;
  readonly visualTimeTicks: number;
  readonly sourceTimeTicks: number;
  readonly fps: number;
  readonly assetsById: ReadonlyMap<string, Asset>;
}

export type ExtensionEntityFrameResult =
  | { readonly ok: true; readonly texture: Texture }
  | { readonly ok: false; readonly error: Error };

const MIN_RASTER_RESOLUTION = 1;
const MAX_RASTER_RESOLUTION = 8;

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toAssetSnapshot(asset: Asset): ExtensionEntityAssetSnapshot {
  return Object.freeze({
    id: asset.id,
    hash: asset.hash,
    name: asset.name,
    type: asset.type,
    src: asset.src,
    durationSeconds: asset.duration,
    fps: asset.fps,
    hasAudio: asset.hasAudio,
  });
}

/**
 * Per-track trusted render session. A TrackRenderEngine resolves exactly one
 * active clip at a time, so one reusable provider object is sufficient; moving
 * between provider IDs releases that object rather than retaining an unbounded
 * per-clip cache. Provider objects live in a private,
 * host-owned Pixi slot and are flattened to the engine's ordinary source
 * texture. That keeps transforms, filter composition, spatial masks, gizmos,
 * still capture, and video export on the existing shared path while allowing
 * the provider to construct arbitrary host-Pixi object trees and shaders.
 */
export class TrustedExtensionEntityRenderer {
  private readonly renderSlot = new Container();
  private readonly renderer: Renderer;
  private provider: RegisteredExtensionEntityProvider | null = null;
  private object: Container | null = null;
  private cachedRenderSignature: string | null = null;
  private cachedTexture: Texture | null = null;
  private disposed = false;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  render(input: ExtensionEntityFrameInput): ExtensionEntityFrameResult {
    if (this.disposed) {
      return {
        ok: false,
        error: new Error("Extension entity renderer is disposed."),
      };
    }

    const payloadResolution = extensionPayloadProviderRegistry.resolve(
      input.clip.extensionPayload,
    );
    if (
      payloadResolution.status !== "current" &&
      payloadResolution.status !== "migrated"
    ) {
      this.releaseCurrent();
      return { ok: false, error: payloadResolution.error };
    }

    const provider = extensionEntityProviderRegistry.get(
      payloadResolution.payload,
    );
    if (!provider) {
      this.releaseCurrent();
      return {
        ok: false,
        error: new Error(
          `Entity renderer '${payloadResolution.payload.extensionId}/${payloadResolution.payload.typeId}' is unavailable.`,
        ),
      };
    }

    if (
      this.provider?.id !== provider.id ||
      !this.object ||
      this.object.destroyed
    ) {
      this.releaseCurrent();
      this.provider = provider;
      this.object = provider.definition.createRenderable();
    }
    const object = this.object;
    if (!object) {
      return {
        ok: false,
        error: new Error(`Entity renderer '${provider.id}' failed to create.`),
      };
    }

    const parameters = Object.freeze({
      data: structuredClone(payloadResolution.payload.data),
      schemaVersion: payloadResolution.payload.schemaVersion,
    });
    const assets = Object.freeze({
      get: (assetId: string): ExtensionEntityAssetSnapshot | undefined => {
        const asset = input.assetsById.get(assetId);
        return asset ? toAssetSnapshot(asset) : undefined;
      },
    });
    const context: ExtensionEntityRenderContext = Object.freeze({
      entity: Object.freeze({
        id: input.clip.id,
        name: input.clip.name,
        trackId: input.clip.trackId,
        startTicks: input.clip.start,
        durationTicks: input.clip.timelineDuration,
      }),
      frame: Object.freeze({
        projectWidth: input.logicalDimensions.width,
        projectHeight: input.logicalDimensions.height,
        presentationTimeTicks: input.presentationTimeTicks,
        visualTimeTicks: input.visualTimeTicks,
        sourceTimeTicks: input.sourceTimeTicks,
        fps: input.fps,
      }),
      renderer: this.renderer,
      assets,
    });

    const providerSignature = provider.definition.getRenderSignature?.(
      parameters,
      context,
    );
    const renderSignature =
      providerSignature === undefined || providerSignature === null
        ? null
        : JSON.stringify({
            providerId: provider.id,
            clipId: input.clip.id,
            clipName: input.clip.name,
            trackId: input.clip.trackId,
            startTicks: input.clip.start,
            durationTicks: input.clip.timelineDuration,
            projectWidth: input.logicalDimensions.width,
            projectHeight: input.logicalDimensions.height,
            rendererWidth: this.renderer.width,
            rendererHeight: this.renderer.height,
            rendererResolution: this.renderer.resolution,
            schemaVersion: parameters.schemaVersion,
            data: parameters.data,
            providerSignature,
          });
    if (
      renderSignature !== null &&
      renderSignature === this.cachedRenderSignature &&
      this.cachedTexture !== null &&
      !this.cachedTexture.destroyed
    ) {
      return { ok: true, texture: this.cachedTexture };
    }

    const updated = provider.definition.updateRenderable(
      object,
      parameters,
      context,
      this.renderSlot,
    );
    if (!updated) {
      this.object = null;
      return {
        ok: false,
        error: new Error(`Entity renderer '${provider.id}' failed to update.`),
      };
    }

    try {
      const bounds = object.getLocalBounds();
      const rasterResolution = this.resolveRasterResolution(
        bounds.width,
        bounds.height,
        input.logicalDimensions,
      );
      const texture = this.renderer.generateTexture({
        target: object,
        resolution: rasterResolution,
        clearColor: [0, 0, 0, 0],
        antialias: true,
      });
      if (
        texture === Texture.EMPTY ||
        texture.width <= 0 ||
        texture.height <= 0
      ) {
        if (texture !== Texture.EMPTY) {
          texture.destroy(true);
        }
        throw new Error(
          `Entity renderer '${provider.id}' produced empty bounds.`,
        );
      }
      this.cachedRenderSignature = renderSignature;
      this.cachedTexture = renderSignature === null ? null : texture;
      return { ok: true, texture };
    } catch (error) {
      this.releaseCurrent();
      return { ok: false, error: errorFromUnknown(error) };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseCurrent();
    if (!this.renderSlot.destroyed) {
      this.renderSlot.destroy({ children: false });
    }
  }

  /** The track engine owns texture destruction; this only drops reuse state. */
  invalidateTextureCache(): void {
    this.cachedRenderSignature = null;
    this.cachedTexture = null;
  }

  private releaseCurrent(): void {
    if (this.object && this.provider) {
      this.provider.definition.releaseRenderable(this.object);
    }
    this.object = null;
    this.provider = null;
    this.invalidateTextureCache();
  }

  private resolveRasterResolution(
    contentWidth: number,
    contentHeight: number,
    logicalDimensions: Readonly<{ width: number; height: number }>,
  ): number {
    if (
      !Number.isFinite(contentWidth) ||
      !Number.isFinite(contentHeight) ||
      contentWidth <= 0 ||
      contentHeight <= 0
    ) {
      throw new Error("Extension entity produced empty or invalid bounds.");
    }

    const outputPixelScale = Math.max(
      this.renderer.width / Math.max(1, logicalDimensions.width),
      this.renderer.height / Math.max(1, logicalDimensions.height),
    );
    const containScale = Math.min(
      logicalDimensions.width / contentWidth,
      logicalDimensions.height / contentHeight,
    );
    return Math.max(
      MIN_RASTER_RESOLUTION,
      Math.min(MAX_RASTER_RESOLUTION, outputPixelScale * containScale),
    );
  }
}
