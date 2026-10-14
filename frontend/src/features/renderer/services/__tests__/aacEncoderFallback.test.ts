import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canEncodeAudio: vi.fn<typeof import("mediabunny").canEncodeAudio>(),
  registerAacEncoder:
    vi.fn<typeof import("@mediabunny/aac-encoder").registerAacEncoder>(),
}));

vi.mock("mediabunny", () => ({ canEncodeAudio: mocks.canEncodeAudio }));
vi.mock("@mediabunny/aac-encoder", () => ({
  registerAacEncoder: mocks.registerAacEncoder,
}));

async function load() {
  // Registration state is module-global; isolate each case.
  vi.resetModules();
  return import("../aacEncoderFallback");
}

describe("ensureAacEncoder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the browser's encoder when native AAC is available", async () => {
    mocks.canEncodeAudio.mockResolvedValue(true);
    const { ensureAacEncoder, getAacEncoderSource } = await load();
    expect(getAacEncoderSource()).toBeNull();
    await expect(ensureAacEncoder(128_000)).resolves.toBe("native");
    expect(mocks.registerAacEncoder).not.toHaveBeenCalled();
    expect(getAacEncoderSource()).toBe("native");
  });

  it("registers the WASM encoder once when native AAC is missing", async () => {
    mocks.canEncodeAudio.mockResolvedValue(false);
    const { ensureAacEncoder, getAacEncoderSource } = await load();
    await expect(ensureAacEncoder(128_000)).resolves.toBe("wasm");
    // Once registered, support checks would report true; the cached answer wins.
    mocks.canEncodeAudio.mockResolvedValue(true);
    await expect(ensureAacEncoder(128_000)).resolves.toBe("wasm");
    expect(mocks.registerAacEncoder).toHaveBeenCalledOnce();
    expect(mocks.canEncodeAudio).toHaveBeenCalledOnce();
    expect(getAacEncoderSource()).toBe("wasm");
  });

  it("retries after a failed load instead of caching the failure", async () => {
    mocks.canEncodeAudio.mockRejectedValueOnce(new Error("chunk load failed"));
    mocks.canEncodeAudio.mockResolvedValueOnce(false);
    const { ensureAacEncoder } = await load();
    await expect(ensureAacEncoder(128_000)).rejects.toThrow("chunk load failed");
    await expect(ensureAacEncoder(128_000)).resolves.toBe("wasm");
    expect(mocks.registerAacEncoder).toHaveBeenCalledOnce();
  });
});
