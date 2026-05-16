import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Renderer, Sprite } from "pixi.js";
import type { TextTimelineClip } from "../../../../types/TimelineTypes";

const mockGenerateTexture = vi.fn(() => ({
  width: 320,
  height: 80,
  destroy: vi.fn(),
}));

const mockWorkerInstances: Array<{
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  onmessage: ((e: MessageEvent) => void) | null;
}> = [];

vi.mock("../../workers/decoder.worker?worker", () => ({
  default: class MockWorker {
    postMessage = vi.fn();
    terminate = vi.fn();
    onmessage: ((e: MessageEvent) => void) | null = null;

    constructor() {
      mockWorkerInstances.push(this);
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
      addChild = vi.fn();
      removeFromParent = vi.fn();
      destroy = vi.fn(() => {
        this.destroyed = true;
      });
    },
  };
});

import { TrackRenderEngine } from "../TrackRenderEngine";

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
    },
    ...overrides,
  };
}

describe("TrackRenderEngine text rendering", () => {
  beforeEach(() => {
    mockWorkerInstances.length = 0;
    mockGenerateTexture.mockClear();
    vi.clearAllMocks();
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
    expect(mockWorkerInstances).toHaveLength(1);
    expect(mockWorkerInstances[0].postMessage).not.toHaveBeenCalled();
    expect((engine.sprite as Sprite).visible).toBe(true);
    expect((engine.sprite as Sprite).texture).toMatchObject({
      width: 320,
      height: 80,
    });

    engine.dispose();
  });
});
