import { inflateSync } from "node:zlib";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import type { AspectRatio } from "../../../project/useProjectStore";
import { makeTimelineSelection } from "../../../../testUtils/timelineSelection";

const projectConfig = {
  aspectRatio: "16:9" as AspectRatio,
  outputResolution: 1080,
  fps: 30,
};

vi.mock("../../../project", () => ({
  useProjectStore: {
    getState: () => ({ config: projectConfig }),
  },
}));

const timelineClips: Array<{ type: string }> = [];

vi.mock("../../../timeline/api", () => ({
  getTimelineClips: () => timelineClips,
  getTimelineDuration: () => 0,
  getTimelineTracks: () => [],
  getTimelineTransitions: () => [],
}));

vi.mock("../../../userAssets", () => ({ getAssets: () => [] }));
vi.mock("../../../composite", () => ({ getCompositeAssets: () => [] }));
vi.mock("../../../masks/api", () => ({
  prepareBrushMasksForTimelineRender: vi.fn(),
}));
vi.mock("../ExportRenderer", () => ({ ExportRenderer: { create: vi.fn() } }));

import {
  buildProjectRenderInputs,
  renderProjectFrameAtTick,
  renderProjectFrameFileAtTick,
} from "../projectFrameCapture";
import { ExportRenderer } from "../ExportRenderer";

/** jsdom's Blob has no arrayBuffer(); FileReader reads it. */
function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const setAspectRatio = (ratio: AspectRatio) => {
  projectConfig.aspectRatio = ratio;
};

const setOutputResolution = (shortEdge: number) => {
  projectConfig.outputResolution = shortEdge;
};

describe("buildProjectRenderInputs", () => {
  beforeEach(() => {
    setAspectRatio("16:9");
    setOutputResolution(1080);
  });

  it("renders a portrait project at the true short-edge resolution", () => {
    setAspectRatio("9:16");
    const { exportConfig } = buildProjectRenderInputs();

    // Logical stays the stored coordinate space; output is the real frame.
    expect(exportConfig.logicalWidth).toBe(608);
    expect(exportConfig.logicalHeight).toBe(1080);
    expect(exportConfig.outputWidth).toBe(1080);
    expect(exportConfig.outputHeight).toBe(1920);
  });

  it("leaves output equal to logical for 16:9", () => {
    const { exportConfig } = buildProjectRenderInputs();

    expect(exportConfig.outputWidth).toBe(exportConfig.logicalWidth);
    expect(exportConfig.outputHeight).toBe(exportConfig.logicalHeight);
    expect(exportConfig.outputWidth).toBe(1920);
    expect(exportConfig.outputHeight).toBe(1080);
  });

  it("keeps the logical canvas untouched for 3:4 while widening the output", () => {
    setAspectRatio("3:4");
    const { exportConfig } = buildProjectRenderInputs();

    expect(exportConfig.logicalWidth).toBe(810);
    expect(exportConfig.outputWidth).toBe(1080);
    expect(exportConfig.outputHeight).toBe(1440);
  });
});

describe("buildProjectRenderInputs output resolution", () => {
  beforeEach(() => {
    setAspectRatio("16:9");
    setOutputResolution(1080);
  });

  it("renders at the project's chosen short edge", () => {
    setOutputResolution(720);
    const { exportConfig } = buildProjectRenderInputs();

    expect(exportConfig.outputWidth).toBe(1280);
    expect(exportConfig.outputHeight).toBe(720);
  });

  it("applies the project resolution in portrait too", () => {
    setAspectRatio("9:16");
    setOutputResolution(720);
    const { exportConfig } = buildProjectRenderInputs();

    expect(exportConfig.outputWidth).toBe(720);
    expect(exportConfig.outputHeight).toBe(1280);
  });

  it("combines a custom ratio and short edge", () => {
    setAspectRatio("7:4");
    setOutputResolution(768);
    const { exportConfig } = buildProjectRenderInputs();

    expect(exportConfig.logicalWidth).toBe(1890);
    expect(exportConfig.logicalHeight).toBe(1080);
    expect(exportConfig.outputWidth).toBe(1344);
    expect(exportConfig.outputHeight).toBe(768);
  });

  it("leaves the logical canvas untouched by the resolution", () => {
    setAspectRatio("9:16");
    const at1080 = buildProjectRenderInputs().exportConfig;
    setOutputResolution(2160);
    const at2160 = buildProjectRenderInputs().exportConfig;

    // The coordinate space is fixed-height by definition; only output moves.
    expect(at2160.logicalWidth).toBe(at1080.logicalWidth);
    expect(at2160.logicalHeight).toBe(at1080.logicalHeight);
    expect(at2160.outputWidth).toBe(2160);
    expect(at2160.outputHeight).toBe(3840);
  });
});

describe("saved selection geometry", () => {
  it.each(["16:9", "9:16", "5:3"] as const)(
    "renders frames on the captured %s canvas after the project changes",
    async (aspectRatio) => {
      setAspectRatio(aspectRatio);
      setOutputResolution(720);
      const originalConfig = buildProjectRenderInputs().exportConfig;
      const selection = makeTimelineSelection({
        start: 0, clips: [], resolution: 720, aspectRatio,
      });
      setAspectRatio("1:1");
      setOutputResolution(1080);
      const renderStill = vi.fn().mockResolvedValue(new Blob(["frame"]));
      vi.mocked(ExportRenderer.create).mockResolvedValue({ renderStill } as never);

      const frame = await renderProjectFrameAtTick(0, { timelineSelection: selection });

      expect(ExportRenderer.create).toHaveBeenLastCalledWith(originalConfig);
      expect(renderStill.mock.calls[0][1]).toEqual(originalConfig);
      expect(frame).toMatchObject({
        width: originalConfig.outputWidth, height: originalConfig.outputHeight,
      });
      expect(projectConfig.aspectRatio).toBe("1:1");
    },
  );
});

describe("renderProjectFrameFileAtTick preserveMaskedPixels", () => {
  const pixelsByBlob = new WeakMap<Blob, Uint8ClampedArray>();
  let renderStill: ReturnType<typeof vi.fn>;
  let width = 0;
  let height = 0;

  /** Masked frame: only the first pixel is visible, the rest are hidden. */
  function maskedPixels(): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(width * height * 4);
    pixels.set([200, 10, 10, 255], 0);
    return pixels;
  }

  /** Unmasked frame: every pixel opaque, colour varying by index. */
  function unmaskedPixels(): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      pixels.set([i % 256, 140, 250, 255], i * 4);
    }
    return pixels;
  }

  beforeEach(() => {
    setAspectRatio("16:9");
    // Small enough to keep the fixture frames tiny.
    setOutputResolution(8);
    ({ outputWidth: width, outputHeight: height } =
      buildProjectRenderInputs().exportConfig);
    timelineClips.length = 0;
    timelineClips.push({ type: "video" }, { type: "mask" });

    renderStill = vi.fn(
      async (
        _data: unknown,
        _config: unknown,
        _tick: number,
        options: { includeTimelineMasks?: boolean },
      ) => {
        const unmasked = options.includeTimelineMasks === false;
        const blob = new Blob([unmasked ? "unmasked" : "masked"]);
        pixelsByBlob.set(blob, unmasked ? unmaskedPixels() : maskedPixels());
        return blob;
      },
    );
    vi.mocked(ExportRenderer.create).mockResolvedValue({
      renderStill,
    } as never);

    // Decoding stand-ins: the capture reads pixels back through a 2D canvas.
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (blob: Blob) => ({ blob, close: vi.fn() })),
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        private source: Blob | null = null;
        getContext() {
          return {
            drawImage: (bitmap: { blob: Blob }) => {
              this.source = bitmap.blob;
            },
            getImageData: () => ({ data: pixelsByBlob.get(this.source!)! }),
          };
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    timelineClips.length = 0;
  });

  /** Inflates IDAT and undoes the encoder's per-row Sub filter. */
  async function readPngPixels(file: File): Promise<Uint8Array> {
    const bytes = await readBlobBytes(file);
    const view = new DataView(bytes.buffer);
    let offset = 8;
    while (offset < bytes.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(
        ...bytes.subarray(offset + 4, offset + 8),
      );
      if (type === "IDAT") {
        const filtered = inflateSync(
          bytes.subarray(offset + 8, offset + 8 + length),
        );
        const stride = width * 4;
        const pixels = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < stride; x += 1) {
            const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
            pixels[y * stride + x] =
              (filtered[y * (stride + 1) + 1 + x] + left) & 0xff;
          }
        }
        return pixels;
      }
      offset += 12 + length;
    }
    throw new Error("No IDAT chunk");
  }

  it("keeps the masked alpha and recovers the colour it hides", async () => {
    const file = await renderProjectFrameFileAtTick(10, {
      preserveMaskedPixels: true,
    });

    expect(renderStill).toHaveBeenCalledTimes(2);
    expect(renderStill.mock.calls[1][3]).toMatchObject({
      includeTimelineMasks: false,
    });
    expect(file.type).toBe("image/png");

    const pixels = await readPngPixels(file);
    // Visible pixel: exactly the masked composite.
    expect([...pixels.subarray(0, 4)]).toEqual([200, 10, 10, 255]);
    // Hidden pixels: unmasked colour, still fully transparent.
    expect([...pixels.subarray(4, 8)]).toEqual([1, 140, 250, 0]);
    const last = width * height - 1;
    expect([...pixels.subarray(last * 4, last * 4 + 4)]).toEqual([
      last % 256,
      140,
      250,
      0,
    ]);
  });

  it("skips the unmasked render when the project has no masks", async () => {
    timelineClips.length = 0;
    timelineClips.push({ type: "video" });

    await renderProjectFrameFileAtTick(10, { preserveMaskedPixels: true });

    expect(renderStill).toHaveBeenCalledTimes(1);
  });

  it("refuses formats that cannot carry the recovered colour", async () => {
    await expect(
      renderProjectFrameFileAtTick(10, {
        preserveMaskedPixels: true,
        mimeType: "image/webp",
      }),
    ).rejects.toThrow(/requires a PNG/);
    expect(renderStill).not.toHaveBeenCalled();
  });
});
