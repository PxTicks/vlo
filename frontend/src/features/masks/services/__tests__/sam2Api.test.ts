import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockResponse, stubFetch } from "../../../../testUtils/fetch";
import {
  clearSam2EditorSession,
  generateMaskFrame,
  generateMaskVideo,
  getSam2Health,
  initSam2EditorSession,
  registerSourceVideo,
} from "../sam2Api";

describe("sam2Api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers a source video using multipart data and a signal", async () => {
    const payload = { sourceId: "source-1", width: 10 };
    const fetchMock = stubFetch(createMockResponse({ json: payload }));
    const file = new File(["video"], "source.mp4", { type: "video/mp4" });
    const controller = new AbortController();

    await expect(
      registerSourceVideo(file, "hash-1", { signal: controller.signal }),
    ).resolves.toEqual(payload);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock.mock.calls[0][0]).toBe("/sam2/sources");
    expect(init).toMatchObject({
      method: "POST",
      signal: controller.signal,
    });
    expect((init.body as FormData).get("video")).toBe(file);
    expect((init.body as FormData).get("source_hash")).toBe("hash-1");
  });

  it("initializes and clears editor sessions with JSON payloads", async () => {
    const request = { sourceId: "source", maskId: "mask" };
    const response = { ...request, width: 20, height: 10, fps: 24, frameCount: 4 };
    const fetchMock = stubFetch(
      createMockResponse({ json: response }),
      createMockResponse(),
    );

    await expect(initSam2EditorSession(request)).resolves.toEqual(response);
    await expect(clearSam2EditorSession(request)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]).toEqual([
      "/sam2/editor/session/init",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    ]);
    expect(fetchMock.mock.calls[1][0]).toBe("/sam2/editor/session/clear");
  });

  it("decodes mask video metadata headers with safe fallbacks", async () => {
    const blob = new Blob(["mask"], { type: "video/mp4" });
    stubFetch(
      createMockResponse({
        blob,
        headers: {
          "X-Sam2-Width": "1280",
          "X-Sam2-Height": "720",
          "X-Sam2-Fps": "invalid",
          "X-Sam2-Frame-Count": "42",
        },
      }),
    );

    await expect(
      generateMaskVideo({
        sourceId: "s",
        points: [],
        ticksPerSecond: 1000,
        maskId: "m",
      }),
    ).resolves.toEqual({
      blob,
      width: 1280,
      height: 720,
      fps: 0,
      frameCount: 42,
    });
  });

  it("passes cancellation through frame generation and parses headers", async () => {
    const controller = new AbortController();
    const fetchMock = stubFetch(
      createMockResponse({
        blob: new Blob(["frame"]),
        headers: {
          "X-Sam2-Width": "100",
          "X-Sam2-Height": "50",
          "X-Sam2-Frame-Index": "3",
          "X-Sam2-Time-Ticks": "250",
        },
      }),
    );

    const result = await generateMaskFrame(
      {
        sourceId: "s",
        points: [],
        ticksPerSecond: 1000,
        timeTicks: 250,
        maskId: "m",
      },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      width: 100,
      height: 50,
      frameIndex: 3,
      timeTicks: 250,
    });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      signal: controller.signal,
    });
  });

  it("fetches health and surfaces JSON or fallback errors", async () => {
    stubFetch(
      createMockResponse({ json: { status: "ok" } }),
      createMockResponse({ status: 500, json: { detail: " model missing " } }),
      createMockResponse({ status: 502, json: undefined }),
    );

    await expect(getSam2Health()).resolves.toEqual({ status: "ok" });
    await expect(getSam2Health()).rejects.toThrow("model missing");
    await expect(getSam2Health()).rejects.toThrow("SAM2 request failed (502)");
  });
});
