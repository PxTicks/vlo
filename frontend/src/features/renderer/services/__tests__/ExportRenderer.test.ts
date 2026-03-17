import { ExportRenderer } from "../ExportRenderer";
import type { ProjectData } from "../ExportRenderer";
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import { Application, Container } from "pixi.js";
import { TrackRenderEngine } from "../TrackRenderEngine";
import type {
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import type { Asset } from "../../../../types/Asset";

// Type definitions for mocks
interface MockWorker {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: Mock;
  terminate: Mock;
}

// Mock PixiJS
vi.mock("pixi.js", async () => {
  const actual = await vi.importActual("pixi.js");
  return {
    ...actual,
    Application: class MockApplication {
      stage = {
        addChild: vi.fn(),
        scale: { set: vi.fn(), x: 1, y: 1 },
        sortChildren: vi.fn(),
        sortableChildren: false,
      };
      renderer = {
        width: 0,
        height: 0,
        render: vi.fn(),
      };
      canvas = document.createElement("canvas");
      init = vi.fn(async (opts) => {
        this.renderer.width = opts.width;
        this.renderer.height = opts.height;
        this.canvas.width = opts.width;
        this.canvas.height = opts.height;
      });
      destroy = vi.fn();
      render = vi.fn();
    },
    Container: class MockContainer {
      scale = {
        set: vi.fn(function (this: { x: number; y: number }, s: number) {
          this.x = s;
          this.y = s;
        }),
        x: 1,
        y: 1,
      };
      addChild = vi.fn();
      sortChildren = vi.fn();
      sortableChildren = false;
      destroy = vi.fn();
      removeFromParent = vi.fn();
    },
    Sprite: class MockSprite {
      anchor = { set: vi.fn() };
      position = { set: vi.fn() };
      scale = { set: vi.fn() };
      rotation = 0;
      alpha = 1;
      tint = 0xffffff;
      blendMode = "normal";
      filters = null;
      texture = null;
      destroy = vi.fn();
      visible = true;
      setMask = vi.fn();
      addChild = vi.fn();
    },
    RenderTexture: {
      create: vi.fn(({ width, height }) => ({
        width,
        height,
        resize: vi.fn(),
        destroy: vi.fn(),
      })),
    },
    Texture: {
      from: vi.fn(() => ({ destroy: vi.fn() })),
      EMPTY: "empty",
    },
  };
});

// Mock Worker
const mockWorkers: MockWorker[] = [];
vi.mock("../../workers/decoder.worker?worker", () => {
  return {
    default: class MockWorkerClass implements MockWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      postMessage = vi.fn((msg) => {
        // Auto-reply to render requests to simulate worker success
        // Use setTimeout to simulate async behavior and let the promise creation happen
        if (msg.type === "render" && this.onmessage) {
          setTimeout(() => {
            this.onmessage!({
              data: {
                type: "frame",
                bitmap: {}, // Mock bitmap
                clipId: msg.clipId,
                transformTime: msg.transformTime,
              },
            } as MessageEvent);
          }, 10);
        }
      });
      terminate = vi.fn();
      constructor() {
        mockWorkers.push(this);
      }
    },
  };
});

// Mock Mediabunny
vi.mock("mediabunny", () => {
  return {
    Output: class {
      constructor() {}
      addVideoTrack = vi.fn();
      addAudioTrack = vi.fn();
      start = vi.fn();
      finalize = vi.fn();
    },
    Mp4OutputFormat: class {},
    WebMOutputFormat: class {},
    BufferTarget: class {
      buffer = new ArrayBuffer(1);
    },
    StreamTarget: class {},
    CanvasSource: class {
      constructor() {}
      add = vi.fn();
      close = vi.fn();
    },
    AudioBufferSource: class {
      constructor() {}
      add = vi.fn();
      close = vi.fn();
    },
  };
});

// Mock TrackAudioRenderer
vi.mock("../TrackAudioRenderer", () => ({
  TrackAudioRenderer: class {
    constructor() {}
    prepareForChunk = vi.fn();
    process = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("../../../userAssets", () => ({
  getAssetInput: vi.fn(),
}));

// Mock OfflineAudioContext
vi.stubGlobal(
  "OfflineAudioContext",
  class {
    constructor() {}
    startRendering = vi.fn().mockResolvedValue({});
    destination = {};
  },
);

// Helper type for accessing private properties in tests
// We define a separate interface that mimics what we want to access,
// and cast to it. We avoid intersecting with ExportRenderer to prevent 'never' issues with private fields.
interface TestExportRenderer {
  app: Application;
  logicalStage: Container;
  dispose: () => void;
  render: ExportRenderer["render"];
  renderStill: ExportRenderer["renderStill"];
}

describe("ExportRenderer", () => {
  it("should correctly scale the stage for 4K export from 1080p logic", async () => {
    const config = {
      logicalWidth: 1920,
      logicalHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
    };

    const renderer = await ExportRenderer.create(config);

    // Access private app to check init props
    const app = (renderer as unknown as TestExportRenderer).app;

    expect(app.renderer.width).toBe(3840);
    expect(app.renderer.height).toBe(2160);

    const logicalStage = (renderer as unknown as TestExportRenderer)
      .logicalStage;

    // Scale should be 2x (2160 / 1080)
    expect(logicalStage.scale.x).toBe(2);
    expect(logicalStage.scale.y).toBe(2);

    renderer.dispose();
  });

  it("should correctly scale down for 480p export", async () => {
    const config = {
      logicalWidth: 1920,
      logicalHeight: 1080,
      outputWidth: 854,
      outputHeight: 480,
    };

    const renderer = await ExportRenderer.create(config);
    const logicalStage = (renderer as unknown as TestExportRenderer)
      .logicalStage;

    // Scale should be ~0.444 (480 / 1080)
    expect(logicalStage.scale.y).toBeCloseTo(0.444, 3);

    renderer.dispose();
  });

  it("should render project with clips without hanging", async () => {
    // 1. Setup Data
    const config = {
      logicalWidth: 1920,
      logicalHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
    };

    const projectData = {
      tracks: [
        { id: "t1", type: "visual", isVisible: true },
      ] as TimelineTrack[],
      clips: [
        {
          id: "c1",
          trackId: "t1",
          assetId: "a1",
          start: 0,
          timelineDuration: 96000 * 2, // 2 Seconds
          offset: 0,
          type: "video",
        },
      ] as TimelineClip[],
      assets: [{ id: "a1", src: "test.mp4", type: "video" }] as Asset[],
      duration: 96000 * 0.1, // Short duration (0.1s) for fast test
      fps: 30,
    };

    const renderer = await ExportRenderer.create(config);

    // 2. Mock Worker Response is handled by the improved MockWorker above.
    // It will automatically reply to 'render' type messages.

    // 3. Execute Render
    // If the bug exists (missing resolve), this will hang until timeout.
    const renderPromise = renderer.render(
      projectData as ProjectData,
      config,
      () => {},
    );

    const result = await renderPromise;
    expect(result.video).toBeInstanceOf(Blob);
    expect(result.outputs.video).toBeInstanceOf(Blob);

    renderer.dispose();
  });

  it("should render multiple configured outputs", async () => {
    const config = {
      logicalWidth: 1920,
      logicalHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
    };

    const projectData = {
      tracks: [
        { id: "t1", type: "visual", isVisible: true },
      ] as TimelineTrack[],
      clips: [
        {
          id: "c1",
          trackId: "t1",
          assetId: "a1",
          start: 0,
          timelineDuration: 96000 * 2,
          offset: 0,
          type: "video",
        },
      ] as TimelineClip[],
      assets: [{ id: "a1", src: "test.mp4", type: "video" }] as Asset[],
      duration: 96000 * 0.1,
      fps: 30,
    };

    const renderer = await ExportRenderer.create(config);
    const result = await renderer.render(
      projectData as ProjectData,
      config,
      () => {},
      {
        outputs: [
          { id: "video", format: "webm", includeAudio: true },
          { id: "aux", format: "webm", includeAudio: false, transformStack: [null] },
        ],
      },
    );

    expect(result.video).toBeInstanceOf(Blob);
    expect(result.outputs.video).toBeInstanceOf(Blob);
    expect(result.outputs.aux).toBeInstanceOf(Blob);

    renderer.dispose();
  });

  it("can render a video pass without applying timeline masks", async () => {
    const config = {
      logicalWidth: 1920,
      logicalHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
    };

    const projectData = {
      tracks: [
        { id: "t1", type: "visual", isVisible: true },
      ] as TimelineTrack[],
      clips: [
        {
          id: "c1",
          trackId: "t1",
          assetId: "a1",
          start: 0,
          timelineDuration: 96000 * 2,
          offset: 0,
          type: "video",
          clipComponents: [
            {
              clipId: "c1::mask::m1",
              componentType: "mask",
            },
          ],
        },
        {
          id: "c1::mask::m1",
          trackId: "t1",
          start: 0,
          timelineDuration: 96000 * 2,
          offset: 0,
          type: "mask",
          maskMode: "apply",
          maskType: "rectangle",
        },
      ] as TimelineClip[],
      assets: [{ id: "a1", src: "test.mp4", type: "video" }] as Asset[],
      duration: 96000 * 0.1,
      fps: 30,
    };

    const updateSpy = vi
      .spyOn(TrackRenderEngine.prototype, "update")
      .mockImplementation(() => undefined);
    const renderFrameSpy = vi
      .spyOn(TrackRenderEngine.prototype, "renderFrame")
      .mockResolvedValue(undefined);

    const renderer = await ExportRenderer.create(config);
    await renderer.render(projectData as ProjectData, config, () => {}, {
      includeTimelineMasks: false,
    });

    expect(updateSpy).toHaveBeenCalled();
    expect(renderFrameSpy).toHaveBeenCalled();
    expect(renderFrameSpy.mock.calls.every(([, , , maskClips]) => {
      return Array.isArray(maskClips) && maskClips.length === 0;
    })).toBe(true);

    updateSpy.mockRestore();
    renderFrameSpy.mockRestore();
    renderer.dispose();
  });

  it("renders still frames from the export stage instead of the interactive canvas", async () => {
    const config = {
      logicalWidth: 1920,
      logicalHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
    };

    const projectData = {
      tracks: [
        { id: "t1", type: "visual", isVisible: true },
      ] as TimelineTrack[],
      clips: [
        {
          id: "c1",
          trackId: "t1",
          assetId: "a1",
          start: 0,
          timelineDuration: 96000 * 2,
          offset: 0,
          type: "video",
        },
      ] as TimelineClip[],
      assets: [{ id: "a1", src: "test.mp4", type: "video" }] as Asset[],
      duration: 96000 * 0.1,
      fps: 30,
    };

    const renderer = await ExportRenderer.create(config);
    const testRenderer = renderer as unknown as TestExportRenderer;
    const toBlobSpy = vi.fn(
      (callback: BlobCallback, type?: string) =>
        callback(new Blob(["frame"], { type: type ?? "image/png" })),
    );
    Object.defineProperty(testRenderer.app.canvas, "toBlob", {
      value: toBlobSpy,
      configurable: true,
    });

    const renderFrameSpy = vi
      .spyOn(TrackRenderEngine.prototype, "renderFrame")
      .mockResolvedValue(undefined);

    const result = await testRenderer.renderStill(projectData, config, 0, {
      mimeType: "image/png",
    });

    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe("image/png");
    expect(renderFrameSpy).toHaveBeenCalled();
    expect(testRenderer.app.renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({
        container: testRenderer.logicalStage,
        clear: true,
      }),
    );
    expect(toBlobSpy).toHaveBeenCalledWith(
      expect.any(Function),
      "image/png",
      undefined,
    );

    renderFrameSpy.mockRestore();
    renderer.dispose();
  });

  it("should cancel an in-flight render", async () => {
    const config = {
      logicalWidth: 1920,
      logicalHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
    };

    const projectData = {
      tracks: [
        { id: "t1", type: "visual", isVisible: true },
      ] as TimelineTrack[],
      clips: [
        {
          id: "c1",
          trackId: "t1",
          assetId: "a1",
          start: 0,
          timelineDuration: 96000 * 10,
          offset: 0,
          type: "video",
        },
      ] as TimelineClip[],
      assets: [{ id: "a1", src: "test.mp4", type: "video" }] as Asset[],
      duration: 96000 * 10,
      fps: 30,
    };

    const renderer = await ExportRenderer.create(config);
    const renderPromise = renderer.render(
      projectData as ProjectData,
      config,
      () => {},
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    renderer.cancel();

    await expect(renderPromise).rejects.toMatchObject({ name: "AbortError" });
  });
});
