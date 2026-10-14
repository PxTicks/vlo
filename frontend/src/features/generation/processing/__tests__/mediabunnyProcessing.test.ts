import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const media = vi.hoisted(() => {
  const state = {
    track: null as null | { displayWidth: number; displayHeight: number },
    frames: [] as Uint8ClampedArray[],
    contextValid: true,
    disposeCount: 0,
    conversionInit: null as null | ((options: unknown) => void),
    conversionCancel: null as null | (() => Promise<void>),
    conversionExecute: null as null | (() => Promise<void>),
    outputBuffer: new ArrayBuffer(4) as ArrayBuffer | null,
  };

  class Input {
    async getPrimaryVideoTrack() {
      return state.track;
    }
    dispose() {
      state.disposeCount += 1;
    }
  }

  class CanvasSink {
    async *canvases() {
      for (const data of state.frames) {
        yield {
          canvas: {
            getContext: () =>
              state.contextValid
                ? {
                    drawImage: () => undefined,
                    clearRect: () => undefined,
                    getImageData: () => ({ data }),
                  }
                : null,
          },
        };
      }
    }
  }

  class BufferTarget {
    get buffer() {
      return state.outputBuffer;
    }
  }

  const Conversion = {
    init: async (options: unknown) => {
      state.conversionInit?.(options);
      return {
        cancel: () => state.conversionCancel?.() ?? Promise.resolve(),
        execute: () => state.conversionExecute?.() ?? Promise.resolve(),
      };
    },
  };

  return { state, Input, CanvasSink, BufferTarget, Conversion };
});

vi.mock("mediabunny", async (importOriginal) => ({
  ...(await importOriginal<typeof import("mediabunny")>()),
  Input: media.Input,
  BlobSource: class {},
  CanvasSink: media.CanvasSink,
  BufferTarget: media.BufferTarget,
  Output: class {},
  Conversion: media.Conversion,
}));

import {
  analyzeMaskVideoBounds,
  probeVideoDimensions,
} from "../maskVideoAnalysis";
import { resizeVideoToDimensions } from "../videoResize";

/** An RGBA frame with a white block covering columns/rows [x1, x2) × [y1, y2). */
function maskFrame(
  width: number,
  height: number,
  [x1, y1, x2, y2]: [number, number, number, number],
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = y1; y < y2; y += 1) {
    for (let x = x1; x < x2; x += 1) {
      data.set([255, 255, 255, 255], (y * width + x) * 4);
    }
  }
  return data;
}

const file = (name = "clip.mp4", type = "video/mp4") =>
  new File([new Uint8Array(1)], name, { type });

beforeEach(() => {
  Object.assign(media.state, {
    track: { displayWidth: 100, displayHeight: 50 },
    frames: [],
    contextValid: true,
    disposeCount: 0,
    conversionInit: null,
    conversionCancel: null,
    conversionExecute: null,
    outputBuffer: new ArrayBuffer(4),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("probeVideoDimensions", () => {
  it("reports the primary track's display size and always disposes", async () => {
    await expect(probeVideoDimensions(file())).resolves.toEqual({
      width: 100,
      height: 50,
    });
    media.state.track = null;
    await expect(probeVideoDimensions(file())).resolves.toBeNull();
    expect(media.state.disposeCount).toBe(2);
  });
});

describe("analyzeMaskVideoBounds", () => {
  it("unions content bounds across every frame", async () => {
    media.state.frames = [
      maskFrame(100, 50, [10, 10, 20, 20]),
      maskFrame(100, 50, [30, 15, 40, 30]),
    ];

    const analysis = await analyzeMaskVideoBounds(file(), {
      targetAr: 2,
      dilation: 0,
    });

    expect(analysis.containerWidth).toBe(100);
    expect(analysis.containerHeight).toBe(50);
    expect(analysis.rawBounds).toEqual([10, 10, 40, 30]);
    expect(analysis.cropRegion).not.toBeNull();
    expect(media.state.disposeCount).toBe(1);
  });

  it("returns empty bounds for an all-black mask", async () => {
    media.state.frames = [new Uint8ClampedArray(100 * 50 * 4)];
    const analysis = await analyzeMaskVideoBounds(file(), { targetAr: 1 });
    expect(analysis.rawBounds).toBeNull();
    expect(analysis.cropRegion).toBeNull();
  });

  it("fails on missing tracks, missing contexts and aborts", async () => {
    media.state.track = null;
    await expect(analyzeMaskVideoBounds(file(), { targetAr: 1 })).rejects.toThrow(
      "Mask video has no video track",
    );

    media.state.track = { displayWidth: 4, displayHeight: 4 };
    media.state.frames = [new Uint8ClampedArray(64)];
    media.state.contextValid = false;
    await expect(analyzeMaskVideoBounds(file(), { targetAr: 1 })).rejects.toThrow(
      "Failed to acquire 2D context for mask analysis",
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      analyzeMaskVideoBounds(file(), { targetAr: 1, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(media.state.disposeCount).toBe(3);
  });
});

describe("resizeVideoToDimensions", () => {
  it("stretches to even dimensions and re-encodes into a renamed file", async () => {
    const init = vi.fn();
    media.state.conversionInit = init;

    const resized = await resizeVideoToDimensions(file("shot.mov"), 641, 359.4, {
      bitrate: 2_000_000,
    });

    expect(init.mock.calls[0][0]).toMatchObject({
      video: {
        width: 642,
        height: 360,
        fit: "fill",
        bitrate: 2_000_000,
        hardwareAcceleration: "no-preference",
      },
    });
    expect(resized.name).toMatch(/^shot\.(mp4|mov|webm)$/);
    expect(resized.size).toBe(4);
    expect(media.state.disposeCount).toBe(1);
  });

  it("rejects invalid dimensions before opening the input", async () => {
    await expect(resizeVideoToDimensions(file(), 0, 10)).rejects.toThrow(
      "Invalid resize dimension: 0",
    );
    await expect(
      resizeVideoToDimensions(file(), 10, Number.NaN),
    ).rejects.toThrow("Invalid resize dimension: NaN");
    expect(media.state.disposeCount).toBe(0);
  });

  it("cancels the conversion for pre-aborted and mid-run aborts", async () => {
    const cancel = vi.fn(async () => undefined);
    media.state.conversionCancel = cancel;

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      resizeVideoToDimensions(file(), 10, 10, { signal: aborted.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledTimes(1);

    const midRun = new AbortController();
    media.state.conversionExecute = async () => {
      midRun.abort();
    };
    await expect(
      resizeVideoToDimensions(file(), 10, 10, { signal: midRun.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("fails when the encoder produced no output", async () => {
    media.state.outputBuffer = null;
    await expect(resizeVideoToDimensions(file(), 10, 10)).rejects.toThrow(
      "Video resize output buffer is empty",
    );
    expect(media.state.disposeCount).toBe(1);
  });
});
