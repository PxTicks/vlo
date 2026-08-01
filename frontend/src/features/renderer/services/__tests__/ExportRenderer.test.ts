import {
  ExportRenderer,
  resolveOutputDefinitions,
} from "../ExportRenderer";
import type { ProjectData } from "../ExportRenderer";
import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import { Application, Container } from "pixi.js";
import { RenderGroupOrchestrator } from "../RenderGroupOrchestrator";
import { TrackRenderEngine } from "../TrackRenderEngine";
import type {
  StandardTimelineClip,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import type { Component } from "../../../../types/Components";
import type { Asset } from "../../../../types/Asset";
import { TICKS_PER_SECOND } from "../../../timeline";
import { extensionTransformationRegistry } from "../../../transformations/extensions/ExtensionTransformationRegistry";
import {
  createCompositeBakeKey,
  serializeCompositeBakeKey,
} from "../../../composite";

const audioRendererMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    trackId: string;
    process: Mock;
    dispose: Mock;
  }>,
}));

const offlineAudioContextMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    numberOfChannels: number;
    length: number;
    sampleRate: number;
    createBuffer: Mock;
    startRendering: Mock;
    destination: Record<string, never>;
  }>,
}));

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
      pivot = { set: vi.fn() };
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
vi.mock("@decoder-worker-loader", () => {
  return {
    default: class MockWorkerClass implements MockWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      postMessage = vi.fn((msg) => {
        // Auto-reply to render requests to simulate worker success
        // Use setTimeout to simulate async behavior and let the promise creation happen
        if (msg.type === "render" && this.onmessage) {
          setTimeout(() => {
            this.onmessage?.({
              data: {
                type: "frame",
                bitmap: {}, // Mock bitmap
                clipId: msg.clipId,
                transformTime: msg.transformTime,
                requestId: msg.requestId,
              },
            } as MessageEvent);
          }, 10);
        }
      });
      terminate = vi.fn();
      constructor() {
        mockWorkers.push(this);
        setTimeout(() => {
          this.onmessage?.({
            data: {
              type: "worker-health",
              event: "boot",
            },
          } as MessageEvent);
        }, 0);
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
    trackId: string;
    constructor(trackId: string) {
      this.trackId = trackId;
      audioRendererMocks.instances.push(this);
    }
    process = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("../../../userAssets", () => ({
  getAssetInput: vi.fn(),
  ensureAssetSourceLoaded: vi.fn().mockResolvedValue(null),
}));

// Mock OfflineAudioContext
vi.stubGlobal(
  "OfflineAudioContext",
  class {
    numberOfChannels: number;
    length: number;
    sampleRate: number;
    destination = {};

    constructor(numberOfChannels: number, length: number, sampleRate: number) {
      this.numberOfChannels = numberOfChannels;
      this.length = length;
      this.sampleRate = sampleRate;
      offlineAudioContextMocks.instances.push(this);
    }

    createBuffer = vi.fn(
      (numberOfChannels: number, length: number, sampleRate: number) => {
        const data = Array.from(
          { length: numberOfChannels },
          () => new Float32Array(length),
        );
        return {
          numberOfChannels,
          length,
          sampleRate,
          duration: length / sampleRate,
          getChannelData: vi.fn((channel: number) => data[channel]),
          copyToChannel: vi.fn((source: Float32Array, channel: number) => {
            data[channel].set(source);
          }),
        };
      },
    );

    startRendering = vi.fn(async () =>
      this.createBuffer(this.numberOfChannels, this.length, this.sampleRate),
    );
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
  beforeEach(() => {
    audioRendererMocks.instances = [];
    offlineAudioContextMocks.instances = [];
  });

  it("rejects preserveAlpha when explicit output contracts are supplied", () => {
    expect(() =>
      resolveOutputDefinitions({
        preserveAlpha: true,
        outputs: [{ id: "video", format: "mp4" }],
      }),
    ).toThrow(/preserveAlpha cannot be combined with explicit outputs/);
  });

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

  it("routes a valid composite bake through the ordinary asset source path", async () => {
    const config = {
      logicalWidth: 640,
      logicalHeight: 360,
      outputWidth: 640,
      outputHeight: 360,
      backgroundAlpha: 0,
    };
    const asset = {
      id: "bake",
      hash: "bake-hash",
      name: "bake.mp4",
      src: "bake.mp4",
      type: "video",
      createdAt: 1,
    } satisfies Asset;
    const content = { durationTicks: 3200, clips: [], fps: 30 };
    const bakeKey = serializeCompositeBakeKey(
      createCompositeBakeKey({
        content,
        projectFps: 30,
        logicalDimensions: { width: 640, height: 360 },
        assets: [asset],
      }),
    );
    const projectData: ProjectData = {
      tracks: [
        {
          id: "track",
          type: "visual",
          label: "Track",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
      clips: [
        {
          id: "placement",
          trackId: "track",
          type: "video",
          name: "Composite",
          assetId: asset.id,
          compositeId: "composite",
          compositeRevision: 1,
          start: 0,
          sourceDuration: 3200,
          transformedDuration: 3200,
          transformedOffset: 0,
          timelineDuration: 3200,
          croppedSourceDuration: 3200,
          offset: 0,
          transformations: [],
        },
      ],
      composites: [
        {
          id: "composite",
          name: "Composite",
          content,
          revision: 1,
          bake: {
            status: "ready",
            requestedKey: bakeKey,
            readyKey: bakeKey,
            readyRevision: 1,
            assetId: asset.id,
          },
          bakedAssetId: asset.id,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      assets: [asset],
      duration: 3200,
      fps: 30,
    };
    const renderer = await ExportRenderer.create(config);
    const app = (renderer as unknown as TestExportRenderer).app;

    await renderer.render(projectData, config, () => {});

    expect(app.renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({
        container: expect.objectContaining({
          scale: expect.objectContaining({ x: 1, y: 1 }),
        }),
        target: expect.objectContaining({ width: 640, height: 360 }),
        clear: true,
      }),
    );
    expect(app.renderer.render).not.toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ width: 1280, height: 720 }),
      }),
    );
  });

  it("captures copied project-composite pixels before encoding", async () => {
    const config = {
      logicalWidth: 4,
      logicalHeight: 2,
      outputWidth: 4,
      outputHeight: 2,
    };
    const projectData: ProjectData = {
      tracks: [],
      clips: [],
      assets: [],
      duration: 0,
      fps: 30,
    };
    const renderer = await ExportRenderer.create(config);
    const testRenderer = renderer as unknown as TestExportRenderer;
    const extractedPixels = new Uint8ClampedArray(4 * 2 * 4);
    extractedPixels[0] = 17;
    (
      testRenderer.app.renderer as unknown as {
        extract: {
          pixels: Mock;
        };
      }
    ).extract = {
      pixels: vi.fn(() => ({
        width: 4,
        height: 2,
        pixels: extractedPixels,
      })),
    };
    const captures: Array<{
      frameIndex: number;
      presentationTick: number;
      pixels: Uint8ClampedArray;
    }> = [];

    await renderer.render(projectData, config, () => {}, {
      onBeforeEncodeFrame: (capture) => {
        captures.push(capture);
      },
    });
    extractedPixels[0] = 99;

    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      frameIndex: 0,
      presentationTick: 0,
      width: 4,
      height: 2,
    });
    expect(captures[0].pixels[0]).toBe(17);
    renderer.dispose();
  });

  it("decodes duplicate asset clips once per source frame", async () => {
    const config = {
      logicalWidth: 1920,
      logicalHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
    };
    const projectData = {
      tracks: [
        { id: "t1", type: "visual", isVisible: true },
        { id: "t2", type: "visual", isVisible: true },
      ] as TimelineTrack[],
      clips: [
        {
          id: "c1",
          trackId: "t1",
          assetId: "a1",
          start: 0,
          timelineDuration: 96000,
          offset: 0,
          type: "video",
        },
        {
          id: "c2",
          trackId: "t2",
          assetId: "a1",
          start: 0,
          timelineDuration: 96000,
          offset: 0,
          type: "video",
        },
      ] as TimelineClip[],
      assets: [{ id: "a1", src: "test.mp4", type: "video" }] as Asset[],
      duration: 96000 / 30,
      fps: 30,
    };
    const renderCallsBefore = mockWorkers.reduce(
      (count, worker) =>
        count +
        worker.postMessage.mock.calls.filter(([message]) => {
          return message.type === "render";
        }).length,
      0,
    );

    const renderer = await ExportRenderer.create(config);
    await renderer.render(projectData as ProjectData, config, () => {});

    const renderCallsAfter = mockWorkers.reduce(
      (count, worker) =>
        count +
        worker.postMessage.mock.calls.filter(([message]) => {
          return message.type === "render";
        }).length,
      0,
    );
    expect(renderCallsAfter - renderCallsBefore).toBe(1);
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
          { id: "video", format: "mp4", includeAudio: true },
          { id: "aux", format: "mp4", includeAudio: false, transformStack: [null] },
        ],
      },
    );

    expect(result.video).toBeInstanceOf(Blob);
    expect(result.outputs.video).toBeInstanceOf(Blob);
    expect(result.outputs.aux).toBeInstanceOf(Blob);

    renderer.dispose();
  });

  it("renders audio export chunks with effect preroll and trims before encoding", async () => {
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
          name: "Clip 1",
          trackId: "t1",
          assetId: "a1",
          start: 0,
          timelineDuration: 96000 * 12,
          sourceDuration: 96000 * 12,
          transformedDuration: 96000 * 12,
          transformedOffset: 0,
          croppedSourceDuration: 96000 * 12,
          offset: 0,
          type: "video",
          transformations: [
            {
              id: "delay-1",
              type: "delay" as const,
              isEnabled: true,
              parameters: {
                time: 0.5,
                feedback: 0.5,
                mix: 0.5,
              },
            },
          ],
        },
      ] as TimelineClip[],
      assets: [{ id: "a1", src: "test.mp4", type: "video" }] as Asset[],
      duration: 96000 * 12,
      fps: 30,
    };

    const renderer = await ExportRenderer.create(config);
    await renderer.render(projectData as ProjectData, config, () => {});

    expect(offlineAudioContextMocks.instances).toHaveLength(2);
    const secondContext = offlineAudioContextMocks.instances[1];
    expect(secondContext.length).toBeGreaterThan(2 * 48000);

    const secondProcess = audioRendererMocks.instances[1].process.mock.calls[0];
    expect(secondProcess[4].baseTicks).toBeLessThan(96000 * 10);
    expect(secondProcess[5].lookahead).toBeGreaterThan(2);

    expect(secondContext.createBuffer).toHaveBeenCalledWith(2, 2 * 48000, 48000);

    renderer.dispose();
  }, 10_000);

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
          components: [
            {
              id: "mask_ref_1",
              type: "mask_ref",
              parameters: { maskClipId: "c1::mask::m1" },
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

    // Export drives decoder-source prepares through the dedicated
    // prepare-only entry point, not the live update() pipeline, so it can't
    // fire a fire-and-forget non-strict mask render that races renderFrame()'s
    // strict mask sync.
    const prepareSpy = vi
      .spyOn(TrackRenderEngine.prototype, "prepareResolvedFrameJob")
      .mockImplementation(() => true);
    const updateSpy = vi
      .spyOn(TrackRenderEngine.prototype, "update")
      .mockImplementation(() => undefined);
    const presentFrameSpy = vi
      .spyOn(TrackRenderEngine.prototype, "presentResolvedFrameJob")
      .mockResolvedValue(true);

    const renderer = await ExportRenderer.create(config);
    await renderer.render(projectData as ProjectData, config, () => {}, {
      includeTimelineMasks: false,
    });

    expect(prepareSpy).toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(presentFrameSpy).toHaveBeenCalled();
    expect(presentFrameSpy.mock.calls.every(([job]) => {
      return job.maskClips.length === 0;
    })).toBe(true);

    prepareSpy.mockRestore();
    updateSpy.mockRestore();
    presentFrameSpy.mockRestore();
    renderer.dispose();
  });

  it("strips range_mask components from clips when timeline masks are excluded", async () => {
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
          components: [
            {
              id: "range_mask_1",
              type: "range_mask",
              parameters: {
                startSourceTicks: 0,
                endSourceTicks: 96000,
                isActive: true,
              },
            },
            {
              id: "mask_ref_1",
              type: "mask_ref",
              parameters: { maskClipId: "c1::mask::m1" },
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

    const prepareSpy = vi
      .spyOn(TrackRenderEngine.prototype, "prepareResolvedFrameJob")
      .mockImplementation(() => true);
    const presentFrameSpy = vi
      .spyOn(TrackRenderEngine.prototype, "presentResolvedFrameJob")
      .mockResolvedValue(true);

    const renderer = await ExportRenderer.create(config);
    await renderer.render(projectData as ProjectData, config, () => {}, {
      includeTimelineMasks: false,
    });

    expect(presentFrameSpy).toHaveBeenCalled();
    const activeClips = presentFrameSpy.mock.calls.map(
      ([job]) => job.activeClip,
    );
    expect(activeClips.length).toBeGreaterThan(0);
    for (const clip of activeClips) {
      const components: Component[] =
        (clip as StandardTimelineClip).components ?? [];
      expect(components.some((c) => c.type === "range_mask")).toBe(false);
    }

    prepareSpy.mockRestore();
    presentFrameSpy.mockRestore();
    renderer.dispose();
  });

  it("preserves range_mask components when timeline masks are included", async () => {
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
          components: [
            {
              id: "range_mask_1",
              type: "range_mask",
              parameters: {
                startSourceTicks: 0,
                endSourceTicks: 96000,
                isActive: true,
              },
            },
          ],
        },
      ] as TimelineClip[],
      assets: [{ id: "a1", src: "test.mp4", type: "video" }] as Asset[],
      duration: 96000 * 0.1,
      fps: 30,
    };

    const prepareSpy = vi
      .spyOn(TrackRenderEngine.prototype, "prepareResolvedFrameJob")
      .mockImplementation(() => true);
    const presentFrameSpy = vi
      .spyOn(TrackRenderEngine.prototype, "presentResolvedFrameJob")
      .mockResolvedValue(true);

    const renderer = await ExportRenderer.create(config);
    await renderer.render(projectData as ProjectData, config, () => {});

    expect(presentFrameSpy).toHaveBeenCalled();
    const activeClips = presentFrameSpy.mock.calls.map(
      ([job]) => job.activeClip,
    );
    expect(activeClips.length).toBeGreaterThan(0);
    for (const clip of activeClips) {
      const components: Component[] =
        (clip as StandardTimelineClip).components ?? [];
      expect(components.some((c) => c.type === "range_mask")).toBe(true);
    }

    prepareSpy.mockRestore();
    presentFrameSpy.mockRestore();
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
    } satisfies ProjectData;

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

    const presentFrameSpy = vi
      .spyOn(TrackRenderEngine.prototype, "presentResolvedFrameJob")
      .mockResolvedValue(true);

    const result = await testRenderer.renderStill(projectData, config, 0, {
      mimeType: "image/png",
    });

    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe("image/png");
    expect(presentFrameSpy).toHaveBeenCalled();
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

    presentFrameSpy.mockRestore();
    renderer.dispose();
  });

  it("registers visual tracks with the orchestrator and syncs once per video frame", async () => {
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
      // 0.1s @ 30fps -> 3 frames; gives us a deterministic frame count to assert.
      duration: 96000 * 0.1,
      fps: 30,
    };

    // The pixi.js mock used by this file is intentionally minimal (no
    // `children`/`parent`/`removeChild` on Container). Stub the orchestrator's
    // methods so this test only verifies the *handoff* from ExportRenderer to
    // the orchestrator — its own scene-graph behavior is covered by
    // RenderGroupOrchestrator.test.ts with real Pixi Containers.
    const registerTrackSpy = vi
      .spyOn(RenderGroupOrchestrator.prototype, "registerTrack")
      .mockImplementation(() => {});
    const syncSpy = vi
      .spyOn(RenderGroupOrchestrator.prototype, "syncPresentationPlan")
      .mockImplementation(() => {});
    const disposeSpy = vi
      .spyOn(RenderGroupOrchestrator.prototype, "dispose")
      .mockImplementation(() => {});

    try {
      const renderer = await ExportRenderer.create(config);
      await renderer.render(projectData as ProjectData, config, () => {});

      expect(registerTrackSpy).toHaveBeenCalledWith(
        "t1",
        expect.anything(),
      );

      const syncCalls = syncSpy.mock.calls;
      expect(syncCalls.length).toBeGreaterThanOrEqual(3);
      for (const [, plan] of syncCalls) {
        expect(plan.tracks.map((track) => track.trackId)).toEqual(["t1"]);
      }

      renderer.dispose();
      expect(disposeSpy).toHaveBeenCalled();
    } finally {
      registerTrackSpy.mockRestore();
      syncSpy.mockRestore();
      disposeSpy.mockRestore();
    }
  });

  it("repeats bounded warm-up for mid-clip exports and stills", async () => {
    const registration = extensionTransformationRegistry.registerRuntime(
      {
        extension: { id: "test.export-temporal", version: "1.0.0" },
        signal: new AbortController().signal,
        own: (resource) => resource,
        report: () => undefined,
      },
      "history-filter",
      {
        type: "filter",
        filterName: "test.export-temporal/history-filter",
        label: "History filter",
        handler: () => undefined,
        uiConfig: { groups: [] },
        rendering: {
          timeDependency: "history",
          maxHistorySeconds: 2 / 30,
          maxStepSeconds: 1 / 30,
        },
      },
    );
    const config = {
      logicalWidth: 1920,
      logicalHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
    };
    const clip = {
      id: "c1",
      trackId: "t1",
      assetId: "a1",
      start: 0,
      timelineDuration: 2 * TICKS_PER_SECOND,
      offset: 0,
      type: "video",
      transformations: [
        {
          id: "history-1",
          type: "filter",
          filterName: "test.export-temporal/history-filter",
          isEnabled: true,
          parameters: {},
        },
      ],
    } as unknown as TimelineClip;
    const track = {
      id: "t1",
      type: "visual",
      isVisible: true,
    } as TimelineTrack;
    const projectData = {
      tracks: [track],
      clips: [clip],
      assets: [{ id: "a1", src: "test.mp4", type: "video" }] as Asset[],
      duration: 2 * TICKS_PER_SECOND,
      fps: 30,
    } satisfies ProjectData;
    const registerTrackSpy = vi
      .spyOn(RenderGroupOrchestrator.prototype, "registerTrack")
      .mockImplementation(() => {});
    const syncSpy = vi
      .spyOn(RenderGroupOrchestrator.prototype, "syncPresentationPlan")
      .mockImplementation(() => {});
    const disposeSpy = vi
      .spyOn(RenderGroupOrchestrator.prototype, "dispose")
      .mockImplementation(() => {});
    const presentSpy = vi
      .spyOn(TrackRenderEngine.prototype, "presentResolvedFrameJob")
      .mockResolvedValue(true);
    const selectionStart = TICKS_PER_SECOND;
    const run = async () => {
      syncSpy.mockClear();
      const renderer = await ExportRenderer.create(config);
      await renderer.render(projectData, config, () => {}, {
        timelineSelection: {
          start: selectionStart,
          end: selectionStart + TICKS_PER_SECOND / 30,
          fps: 30,
          clips: [clip],
          tracks: [track],
        },
      });
      return syncSpy.mock.calls.map(([tick, , render]) => ({
        tick,
        render,
      }));
    };

    try {
      const first = await run();
      const second = await run();

      expect(second).toEqual(first);
      expect(first.map(({ tick }) => tick)).toEqual([
        selectionStart - (2 * TICKS_PER_SECOND) / 30,
        selectionStart - TICKS_PER_SECOND / 30,
        selectionStart,
      ]);
      expect(first.map(({ render }) => render?.isWarmup)).toEqual([
        true,
        true,
        false,
      ]);
      expect(
        first.every(
          ({ render }) => render?.sequenceId === first[0]?.render?.sequenceId,
        ),
      ).toBe(true);

      syncSpy.mockClear();
      const stillRenderer = await ExportRenderer.create(config);
      const testStillRenderer = stillRenderer as unknown as TestExportRenderer;
      Object.defineProperty(testStillRenderer.app.canvas, "toBlob", {
        value: vi.fn((callback: BlobCallback) =>
          callback(new Blob(["frame"], { type: "image/png" })),
        ),
        configurable: true,
      });
      await stillRenderer.renderStill(projectData, config, selectionStart);

      const stillSamples = syncSpy.mock.calls.map(([tick, , render]) => ({
        tick,
        render,
      }));
      expect(stillSamples.map(({ tick }) => tick)).toEqual(
        first.map(({ tick }) => tick),
      );
      expect(stillSamples.map(({ render }) => render?.mode)).toEqual([
        "still",
        "still",
        "still",
      ]);
      expect(testStillRenderer.app.renderer.render).toHaveBeenCalledTimes(3);
      expect(testStillRenderer.app.renderer.render).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ target: expect.anything() }),
      );
      expect(
        (testStillRenderer.app.renderer.render as Mock).mock.calls[2]?.[0],
      ).not.toHaveProperty("target");
    } finally {
      registration.dispose();
      registerTrackSpy.mockRestore();
      syncSpy.mockRestore();
      disposeSpy.mockRestore();
      presentSpy.mockRestore();
    }
  });

  it("registers visual tracks with the orchestrator and syncs once during renderStill", async () => {
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

    const registerTrackSpy = vi
      .spyOn(RenderGroupOrchestrator.prototype, "registerTrack")
      .mockImplementation(() => {});
    const syncSpy = vi
      .spyOn(RenderGroupOrchestrator.prototype, "syncPresentationPlan")
      .mockImplementation(() => {});
    const disposeSpy = vi
      .spyOn(RenderGroupOrchestrator.prototype, "dispose")
      .mockImplementation(() => {});

    try {
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

      await testRenderer.renderStill(projectData as ProjectData, config, 0, {
        mimeType: "image/png",
      });

      expect(registerTrackSpy).toHaveBeenCalledWith("t1", expect.anything());
      expect(syncSpy).toHaveBeenCalledTimes(1);
      const [tick, plan] = syncSpy.mock.calls[0];
      expect(tick).toBe(0);
      expect(plan.tracks.map((track) => track.trackId)).toEqual(["t1"]);
      expect(disposeSpy).toHaveBeenCalled();
    } finally {
      registerTrackSpy.mockRestore();
      syncSpy.mockRestore();
      disposeSpy.mockRestore();
    }
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
