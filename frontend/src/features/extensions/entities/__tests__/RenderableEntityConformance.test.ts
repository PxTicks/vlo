import { RenderTexture, type Container, type Renderer } from "pixi.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionTimelineClip } from "../../../../types/TimelineTypes";
import { TrackRenderEngine } from "../../../renderer/services/TrackRenderEngine";
import { resetSharedDecoderWorkerPoolForTests } from "../../../renderer/services/DecoderWorkerPool";
import { ExtensionHost } from "../../ExtensionHost";
import {
  createVloExtensionApi,
} from "../../services/FrontendExtensionRuntime";
import type { JsonValue, VloExtensionApi } from "../../types";
import { extensionEntityProviderRegistry } from "../ExtensionEntityProviderRegistry";
import { activate } from "../../../../../../extension-fixtures/color-grade/frontend/src/index";

vi.mock("@decoder-worker-loader", () => ({
  default: class MockWorker {
    postMessage = vi.fn();
    terminate = vi.fn();
    onmessage: ((event: MessageEvent) => void) | null = null;
  },
}));

function createClip(
  typeId: "rounded-rectangle" | "animated-progress",
): ExtensionTimelineClip {
  const data: JsonValue =
    typeId === "rounded-rectangle"
      ? {
          width: 640,
          height: 360,
          radius: 48,
          color: "#8b5cf6",
        }
      : {
          width: 720,
          height: 64,
          background: "#164e63",
          fill: "#22d3ee",
        };
  return {
    id: `fixture-${typeId}`,
    trackId: "track-1",
    type: "extension",
    name: typeId,
    sourceDuration: null,
    start: 0,
    timelineDuration: 96_000,
    offset: 0,
    transformedDuration: 96_000,
    transformedOffset: 0,
    croppedSourceDuration: 96_000,
    transformations: [],
    extensionPayload: {
      extensionId: "example.color-grade",
      typeId,
      schemaVersion: 1,
      data,
    },
  };
}

function createRenderer(): {
  renderer: Renderer;
  generateTexture: ReturnType<typeof vi.fn>;
} {
  const generateTexture = vi.fn(
    (options: { target: Container; resolution: number }) => {
      const bounds = options.target.getLocalBounds();
      return RenderTexture.create({
        width: bounds.width,
        height: bounds.height,
        resolution: options.resolution,
      });
    },
  );
  return {
    renderer: {
      width: 1920,
      height: 1080,
      resolution: 1,
      generateTexture,
    } as unknown as Renderer,
    generateTexture,
  };
}

afterEach(() => {
  resetSharedDecoderWorkerPoolForTests();
});

describe("renderable entity conformance fixture", () => {
  it("activates the out-of-tree fixture and renders static/animated entities live and for export", async () => {
    const host = new ExtensionHost<VloExtensionApi>({
      sdkVersion: "1.0.0",
      createApi: createVloExtensionApi,
    });
    await host.activate(
      { id: "example.color-grade", version: "1.0.0" },
      { activate },
    );

    const shapeClip = createClip("rounded-rectangle");
    const progressClip = createClip("animated-progress");
    expect(extensionEntityProviderRegistry.get(shapeClip.extensionPayload)).toBeDefined();
    expect(
      extensionEntityProviderRegistry.get(progressClip.extensionPayload),
    ).toBeDefined();

    const live = createRenderer();
    const liveEngine = new TrackRenderEngine(1, undefined, live.renderer);
    const dimensions = { width: 1920, height: 1080 };
    await liveEngine.update(0, [shapeClip], new Map(), [], dimensions);
    await liveEngine.update(0, [shapeClip], new Map(), [], dimensions);

    expect(live.generateTexture).toHaveBeenCalledOnce();
    expect(live.generateTexture.mock.calls[0]?.[0]).toMatchObject({
      resolution: 3,
    });
    expect(liveEngine.sprite.visible).toBe(true);
    expect(liveEngine.sprite.texture).toMatchObject({
      width: 640,
      height: 360,
    });

    await liveEngine.update(24_000, [progressClip], new Map(), [], dimensions);
    await liveEngine.update(48_000, [progressClip], new Map(), [], dimensions);
    expect(live.generateTexture).toHaveBeenCalledTimes(3);

    const exported = createRenderer();
    const exportEngine = new TrackRenderEngine(1, undefined, exported.renderer);
    await exportEngine.renderFrame(0, shapeClip, dimensions);
    expect(exported.generateTexture).toHaveBeenCalledOnce();
    expect(exportEngine.sprite.texture).toMatchObject({
      width: 640,
      height: 360,
    });

    liveEngine.dispose();
    exportEngine.dispose();
    await host.deactivate("example.color-grade");
    expect(extensionEntityProviderRegistry.get(shapeClip.extensionPayload)).toBeUndefined();
  });
});
