import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Container, type Renderer, type Sprite } from "pixi.js";
import type {
  ExtensionTimelineClip,
  TextTimelineClip,
} from "../../../../types/TimelineTypes";
import { livePreviewTextStore } from "../../../text/services/livePreviewTextStore";
import { resetSharedDecoderWorkerPoolForTests } from "../DecoderWorkerPool";
import { extensionPayloadProviderRegistry } from "../../../extensions/persistence/publicApi";
import { extensionEntityProviderRegistry } from "../../../extensions/entities/publicApi";

const mockGenerateTexture = vi.fn(() => ({
  width: 320,
  height: 80,
  destroy: vi.fn(),
}));

const mockHtmlGetTexturePromise = vi.fn(async () => ({
  width: 320,
  height: 80,
  destroy: vi.fn(),
}));

const mockWorkerInstances: Array<{
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  onmessage: ((e: MessageEvent) => void) | null;
}> = [];

vi.mock("@decoder-worker-loader", () => ({
  default: class MockWorker {
    postMessage = vi.fn();
    terminate = vi.fn();
    onmessage: ((e: MessageEvent) => void) | null = null;

    constructor() {
      mockWorkerInstances.push(this);
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
}));

vi.mock("pixi.js", async () => {
  const actual = await vi.importActual("pixi.js");
  return {
    ...actual,
    Text: class MockText {
      options: unknown;
      constructor(options: unknown) {
        this.options = options;
      }
      destroy = vi.fn();
    },
    Texture: {
      from: vi.fn(() => ({
        width: 100,
        height: 100,
        destroy: vi.fn(),
      })),
      EMPTY: { width: 0, height: 0, destroy: vi.fn() },
    },
    Sprite: class MockSprite {
      anchor = { set: vi.fn() };
      texture = { width: 0, height: 0, destroy: vi.fn() };
      visible = false;
      position = { x: 0, y: 0, set: vi.fn() };
      scale = { x: 1, y: 1, set: vi.fn() };
      pivot = { x: 0, y: 0, set: vi.fn() };
      rotation = 0;
      addChild = vi.fn();
      setMask = vi.fn();
      addEffect = vi.fn();
      removeEffect = vi.fn();
      destroy = vi.fn();
    },
    Container: class MockContainer {
      parent: { removeChild: () => void } | null = null;
      destroyed = false;
      zIndex = 0;
      position = { x: 0, y: 0, set: vi.fn() };
      scale = { x: 1, y: 1, set: vi.fn() };
      pivot = { x: 0, y: 0, set: vi.fn() };
      rotation = 0;
      addChild = vi.fn();
      getLocalBounds = vi.fn(() => ({
        x: -160,
        y: -90,
        width: 320,
        height: 180,
      }));
      removeFromParent = vi.fn();
      destroy = vi.fn(() => {
        this.destroyed = true;
      });
    },
  };
});

import {
  createExtensionPlaceholderClip,
  TrackRenderEngine,
} from "../TrackRenderEngine";

let disposePayloadProvider: (() => void) | null = null;
let disposeEntityProvider: (() => void) | null = null;

function createTextClip(
  overrides: Partial<TextTimelineClip> = {},
): TextTimelineClip {
  return {
    id: "clip_text_1",
    trackId: "track_1",
    type: "text",
    name: "Text",
    sourceDuration: null,
    start: 0,
    timelineDuration: 200,
    offset: 0,
    transformedDuration: 200,
    transformedOffset: 0,
    croppedSourceDuration: 200,
    transformations: [],
    textData: {
      content: "Hello world",
      fontFamily: "Arial",
      fontSize: 96,
      fill: "#ffffff",
      align: "center",
      strokeColor: "#000000",
      strokeWidth: 2,
    },
    ...overrides,
  };
}

function createExtensionClip(): ExtensionTimelineClip {
  return {
    id: "clip_extension_1",
    trackId: "track_1",
    type: "extension",
    name: "Star shape",
    sourceDuration: null,
    start: 0,
    timelineDuration: 200,
    offset: 0,
    transformedDuration: 200,
    transformedOffset: 0,
    croppedSourceDuration: 200,
    transformations: [],
    extensionPayload: {
      extensionId: "example.shapes",
      typeId: "star",
      schemaVersion: 1,
      data: { points: 5 },
    },
  };
}

describe("TrackRenderEngine text rendering", () => {
  beforeEach(() => {
    mockWorkerInstances.length = 0;
    mockGenerateTexture.mockClear();
    mockHtmlGetTexturePromise.mockClear();
    livePreviewTextStore.clearAll();
    resetSharedDecoderWorkerPoolForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    disposePayloadProvider?.();
    disposePayloadProvider = null;
    disposeEntityProvider?.();
    disposeEntityProvider = null;
  });

  it("renders text clips without using the decoder worker and reuses the texture until text changes", async () => {
    const renderer = {
      width: 3840,
      height: 2160,
      generateTexture: mockGenerateTexture,
    } as unknown as Renderer;
    const engine = new TrackRenderEngine(1, undefined, renderer);
    const clip = createTextClip();
    const dimensions = { width: 1920, height: 1080 };

    await engine.update(10, [clip], new Map(), [], dimensions);
    await engine.update(20, [clip], new Map(), [], dimensions);
    await engine.update(
      30,
      [
        createTextClip({
          textData: {
            ...clip.textData,
            fill: "#ff5500",
          },
        }),
      ],
      new Map(),
      [],
      dimensions,
    );

    expect(mockGenerateTexture).toHaveBeenCalledTimes(2);
    expect(mockWorkerInstances).toHaveLength(0);
    expect((engine.sprite as Sprite).visible).toBe(true);
    expect((engine.sprite as Sprite).texture).toMatchObject({
      width: 320,
      height: 80,
    });

    engine.dispose();
  });

  it("uses live preview text data when generating text textures", async () => {
    const renderer = {
      width: 3840,
      height: 2160,
      generateTexture: mockGenerateTexture,
    } as unknown as Renderer;
    const engine = new TrackRenderEngine(1, undefined, renderer);
    const clip = createTextClip();
    const dimensions = { width: 1920, height: 1080 };

    livePreviewTextStore.set(clip.id, {
      content: "Preview text",
      fill: "#ff5500",
    });

    await engine.update(10, [clip], new Map(), [], dimensions);

    expect(mockGenerateTexture).toHaveBeenCalledTimes(1);
    const firstCall = mockGenerateTexture.mock.calls[0] as unknown as [
      { target: { options: unknown } },
    ];
    expect(firstCall[0].target.options).toMatchObject({
      text: "Preview text",
      style: expect.objectContaining({
        fill: "#ff5500",
      }),
    });

    engine.dispose();
  });

  it("renders a missing-extension placeholder in live playback and export", async () => {
    const renderer = {
      width: 3840,
      height: 2160,
      generateTexture: mockGenerateTexture,
    } as unknown as Renderer;
    const dimensions = { width: 1920, height: 1080 };
    const clip = createExtensionClip();
    const liveEngine = new TrackRenderEngine(1, undefined, renderer);
    const exportEngine = new TrackRenderEngine(1, undefined, renderer);

    await liveEngine.update(10, [clip], new Map(), [], dimensions);
    await exportEngine.renderFrame(10, clip, dimensions);

    expect(mockGenerateTexture).toHaveBeenCalledTimes(2);
    for (const call of mockGenerateTexture.mock.calls) {
      const [options] = call as unknown as [{ target: { options: unknown } }];
      expect(options.target.options).toMatchObject({
        text: "Missing extension\nexample.shapes/star",
        style: expect.objectContaining({
          fill: "#ffedd5",
        }),
      });
    }
    expect(mockWorkerInstances).toHaveLength(0);
    expect((liveEngine.sprite as Sprite).visible).toBe(true);
    expect((exportEngine.sprite as Sprite).visible).toBe(true);

    liveEngine.dispose();
    exportEngine.dispose();
  });

  it("does not call an extension missing when its payload provider is active", () => {
    const registration = extensionPayloadProviderRegistry
      .bind({
        extension: { id: "example.shapes", version: "1.0.0" },
        signal: new AbortController().signal,
        own: (resource) => resource,
        report: () => undefined,
      })
      .register({
        id: "star",
        apiVersion: 1,
        schemaVersion: 1,
        validate: () => undefined,
      });
    disposePayloadProvider = () => registration.dispose();

    const placeholder = createExtensionPlaceholderClip(createExtensionClip());

    expect(placeholder.textData).toMatchObject({
      content: "Extension renderer unavailable\nexample.shapes/star",
      fill: "#dbeafe",
    });
  });

  it("renders a trusted Pixi entity through the same live and export texture path", async () => {
    const updates = vi.fn();
    const createdObjects: Container[] = [];
    const registration = extensionEntityProviderRegistry
      .bind({
        extension: { id: "example.shapes", version: "1.0.0" },
        signal: new AbortController().signal,
        own: (resource) => resource,
        report: () => undefined,
      })
      .register({
        id: "star",
        apiVersion: 1,
        kind: "trusted-pixi",
        label: "Star",
        schemaVersion: 1,
        defaultPayload: { points: 5 },
        validate: () => undefined,
        getRenderSignature: ({ data }) => JSON.stringify(data),
        createRenderable: () => {
          const object = new Container();
          createdObjects.push(object);
          return {
            object,
            update: (parameters, context) =>
              updates(parameters, context.frame.visualTimeTicks),
          };
        },
      });
    disposeEntityProvider = () => registration.dispose();
    const renderer = {
      width: 3840,
      height: 2160,
      generateTexture: mockGenerateTexture,
    } as unknown as Renderer;
    const clip = createExtensionClip();
    const dimensions = { width: 1920, height: 1080 };
    const liveEngine = new TrackRenderEngine(1, undefined, renderer);
    const exportEngine = new TrackRenderEngine(1, undefined, renderer);

    await liveEngine.update(10, [clip], new Map(), [], dimensions);
    await liveEngine.update(10, [clip], new Map(), [], dimensions);
    await liveEngine.update(
      10,
      [
        {
          ...clip,
          extensionPayload: {
            ...clip.extensionPayload,
            data: { points: 7 },
          },
        },
      ],
      new Map(),
      [],
      dimensions,
    );
    await exportEngine.renderFrame(20, clip, dimensions, [], new Map(), {
      fps: 24,
    });

    expect(createdObjects).toHaveLength(2);
    expect(updates).toHaveBeenCalledTimes(3);
    expect(updates.mock.calls[0]?.[0]).toEqual({
      data: { points: 5 },
      schemaVersion: 1,
    });
    expect(updates.mock.calls[1]?.[0]).toEqual({
      data: { points: 7 },
      schemaVersion: 1,
    });
    expect(mockGenerateTexture).toHaveBeenCalledTimes(3);
    const renderTargets = mockGenerateTexture.mock.calls.map(
      (call) =>
        (call as unknown as [{ target: object }])[0].target,
    );
    expect(renderTargets).toEqual([
      createdObjects[0],
      createdObjects[0],
      createdObjects[1],
    ]);
    for (const [options] of mockGenerateTexture.mock.calls as unknown as Array<
      [{ resolution: number }]
    >) {
      expect(options.resolution).toBe(8);
    }
    expect((liveEngine.sprite as Sprite).visible).toBe(true);
    expect((exportEngine.sprite as Sprite).visible).toBe(true);
    expect(mockWorkerInstances).toHaveLength(0);

    liveEngine.dispose();
    exportEngine.dispose();
    expect(createdObjects.every((object) => object.destroyed)).toBe(true);
  });

  it("does not cache an entity unless its provider declares a render signature", async () => {
    const update = vi.fn();
    const registration = extensionEntityProviderRegistry
      .bind({
        extension: { id: "example.shapes", version: "1.0.0" },
        signal: new AbortController().signal,
        own: (resource) => resource,
        report: () => undefined,
      })
      .register({
        id: "star",
        apiVersion: 1,
        kind: "trusted-pixi",
        label: "Animated star",
        schemaVersion: 1,
        defaultPayload: { points: 5 },
        validate: () => undefined,
        createRenderable: () => ({
          object: new Container(),
          update,
        }),
      });
    disposeEntityProvider = () => registration.dispose();
    const renderer = {
      width: 1920,
      height: 1080,
      resolution: 1,
      generateTexture: mockGenerateTexture,
    } as unknown as Renderer;
    const engine = new TrackRenderEngine(1, undefined, renderer);
    const clip = createExtensionClip();

    await engine.update(10, [clip], new Map(), [], {
      width: 1920,
      height: 1080,
    });
    await engine.update(10, [clip], new Map(), [], {
      width: 1920,
      height: 1080,
    });

    expect(update).toHaveBeenCalledTimes(2);
    expect(mockGenerateTexture).toHaveBeenCalledTimes(2);
    engine.dispose();
  });

  it("renders rich-text runs via the HTMLText system with bold and italic spans", async () => {
    const renderer = {
      width: 3840,
      height: 2160,
      generateTexture: mockGenerateTexture,
      htmlText: { getTexturePromise: mockHtmlGetTexturePromise },
    } as unknown as Renderer;
    const engine = new TrackRenderEngine(1, undefined, renderer);
    const clip = createTextClip({
      textData: {
        content: "Hello world",
        runs: [
          { text: "Hello", bold: true },
          { text: " " },
          { text: "world", italic: true },
        ],
        fontFamily: "Arial",
        fontSize: 96,
        fill: "#ffffff",
        align: "center",
        strokeColor: "#000000",
        strokeWidth: 2,
      },
    });
    const dimensions = { width: 1920, height: 1080 };

    await engine.update(10, [clip], new Map(), [], dimensions);

    expect(mockGenerateTexture).not.toHaveBeenCalled();
    expect(mockHtmlGetTexturePromise).toHaveBeenCalledTimes(1);
    const firstCall = mockHtmlGetTexturePromise.mock.calls[0] as unknown as [
      { text: string; style: { cssOverrides?: string[] } },
    ];
    expect(firstCall[0].text).toBe("<b>Hello</b> <i>world</i>");
    expect(firstCall[0].style.cssOverrides).toEqual([
      "-webkit-text-stroke: 2px #000000;",
      "paint-order: stroke fill;",
    ]);

    engine.dispose();
  });
});
