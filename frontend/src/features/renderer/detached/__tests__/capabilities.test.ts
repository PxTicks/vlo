import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const { canEncodeAudio, canEncodeVideo, ensureAacEncoder } = vi.hoisted(() => ({
  canEncodeAudio: vi.fn<typeof import("mediabunny").canEncodeAudio>(),
  canEncodeVideo: vi.fn<typeof import("mediabunny").canEncodeVideo>(),
  ensureAacEncoder: vi.fn(),
}));
vi.mock("mediabunny", async (importOriginal) => ({
  ...(await importOriginal<typeof import("mediabunny")>()),
  canEncodeAudio, canEncodeVideo,
}));
vi.mock("../../services/aacEncoderFallback", () => ({ ensureAacEncoder }));

import { probeRenderCapabilities } from "../capabilities";

const mp4 = { format: "mp4" as const, includeAudio: true, width: 320, height: 180 };

/** `getContext` is overloaded per context type; the probe only asks for webgl2. */
function stubWebGl2(context: object | null) {
  (vi.spyOn(HTMLCanvasElement.prototype, "getContext") as unknown as MockInstance<() => object | null>)
    .mockReturnValue(context);
}

beforeEach(() => {
  // jsdom has no WebGL; hand the probe a context that answers.
  stubWebGl2({ RENDERER: 1, VENDOR: 2, getExtension: () => null, getParameter: () => "test gpu" });
  canEncodeVideo.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  canEncodeAudio.mockReset();
  canEncodeVideo.mockReset();
  ensureAacEncoder.mockReset();
});

describe("render readiness probe", () => {
  it("counts the WASM AAC fallback as support, as the encoder would use it", async () => {
    // Linux Chrome: no native AAC until the fallback registers.
    let registered = false;
    ensureAacEncoder.mockImplementation(async () => { registered = true; return "wasm"; });
    canEncodeAudio.mockImplementation(async () => registered);

    const result = await probeRenderCapabilities(mp4);
    expect(ensureAacEncoder).toHaveBeenCalledWith(128_000);
    expect(result.audio).toMatchObject({ required: true, codec: "aac", supported: true, encoder: "wasm" });
    expect(result).toMatchObject({ ready: true, blockers: [] });
  });

  it("reports native AAC as native", async () => {
    ensureAacEncoder.mockResolvedValue("native");
    canEncodeAudio.mockResolvedValue(true);
    expect((await probeRenderCapabilities(mp4)).audio.encoder).toBe("native");
  });

  it("does not ask for audio the document does not include", async () => {
    const result = await probeRenderCapabilities({ ...mp4, includeAudio: false });
    expect(ensureAacEncoder).not.toHaveBeenCalled();
    expect(canEncodeAudio).not.toHaveBeenCalled();
    expect(result.audio).toMatchObject({ required: false, supported: null, encoder: null });
    expect(result.ready).toBe(true);
  });

  it("probes Opus for WebM, with no fallback to register", async () => {
    canEncodeAudio.mockResolvedValue(false);
    const result = await probeRenderCapabilities({ ...mp4, format: "webm" });
    expect(ensureAacEncoder).not.toHaveBeenCalled();
    expect(canEncodeAudio).toHaveBeenCalledWith("opus", expect.anything());
    expect(result).toMatchObject({ ready: false, blockers: ["OPUS audio cannot be encoded."] });
  });

  it("is not ready when the fallback itself fails to load", async () => {
    ensureAacEncoder.mockRejectedValue(new Error("chunk failed"));
    const result = await probeRenderCapabilities(mp4);
    expect(result.audio).toMatchObject({ supported: false, encoder: null, error: "Error: chunk failed" });
    expect(result.blockers).toEqual(["AAC audio cannot be encoded."]);
  });

  it("decides on the encoder's own acceleration preference, not the diagnostic ones", async () => {
    ensureAacEncoder.mockResolvedValue("native");
    canEncodeAudio.mockResolvedValue(true);
    canEncodeVideo.mockImplementation(async (_codec, options) =>
      options?.hardwareAcceleration !== "no-preference");
    const result = await probeRenderCapabilities(mp4);
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(["MP4 video (avc) cannot be encoded at 320x180."]);
  });

  it("is not ready without WebGL2", async () => {
    stubWebGl2(null);
    ensureAacEncoder.mockResolvedValue("native");
    canEncodeAudio.mockResolvedValue(true);
    const result = await probeRenderCapabilities(mp4);
    expect(result.webgl.available).toBe(false);
    expect(result.blockers).toEqual(["WebGL2 is unavailable."]);
  });
});
