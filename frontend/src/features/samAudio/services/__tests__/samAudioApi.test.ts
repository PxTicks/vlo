import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockResponse, stubFetch } from "../../../../testUtils/fetch";
import {
  cancelSeparationJob,
  fetchStem,
  getSamAudioHealth,
  pollJob,
  registerSourceAudio,
  submitSeparationJob,
} from "../samAudioApi";

describe("samAudioApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers source audio with multipart data", async () => {
    const file = new File(["audio"], "voice.wav", { type: "audio/wav" });
    const controller = new AbortController();
    const fetchMock = stubFetch(
      createMockResponse({ json: { sourceId: "source-1" } }),
    );

    await registerSourceAudio(file, "hash", { signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock.mock.calls[0][0]).toBe("/sam-audio/sources");
    expect(init).toMatchObject({
      method: "POST",
      signal: controller.signal,
    });
    expect((init.body as FormData).get("audio")).toBe(file);
    expect((init.body as FormData).get("source_hash")).toBe("hash");
  });

  it("submits, polls, and cancels jobs", async () => {
    const request = {
      sourceId: "source",
      startTicks: 0,
      durationTicks: 100,
      prompt: { text: "voice" },
    };
    const fetchMock = stubFetch(
      createMockResponse({ json: { jobId: "job-1" } }),
      createMockResponse({ json: { jobId: "job-1", status: "running" } }),
      createMockResponse({ json: { jobId: "job-1", status: "cancelled" } }),
    );

    await expect(submitSeparationJob(request)).resolves.toEqual({
      jobId: "job-1",
    });
    await expect(pollJob("job-1")).resolves.toMatchObject({
      status: "running",
    });
    await expect(cancelSeparationJob("job-1")).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/sam-audio/jobs",
      "/sam-audio/jobs/job-1",
      "/sam-audio/jobs/job-1/cancel",
    ]);
    expect(fetchMock.mock.calls[2][1]).toEqual({ method: "POST" });
  });

  it("parses stem metadata, defaults, and malformed span headers", async () => {
    const blob = new Blob(["stem"], { type: "audio/wav" });
    stubFetch(
      createMockResponse({
        blob,
        headers: {
          "X-SamAudio-SampleRate": "44100",
          "X-SamAudio-DurationTicks": "2000",
          "X-SamAudio-Spans": '[[["+",10,20]]]',
        },
      }),
      createMockResponse({
        blob,
        headers: {
          "X-SamAudio-SampleRate": "broken",
          "X-SamAudio-Spans": "{broken",
        },
      }),
    );

    await expect(fetchStem("j1", "target")).resolves.toEqual({
      blob,
      sampleRate: 44100,
      durationTicks: 2000,
      predictedSpans: [[["+", 10, 20]]],
    });
    await expect(fetchStem("j1", "residual")).resolves.toEqual({
      blob,
      sampleRate: 48000,
      durationTicks: 0,
      predictedSpans: null,
    });
  });

  it("fetches health and propagates detailed or fallback errors", async () => {
    stubFetch(
      createMockResponse({ json: { status: "ok" } }),
      createMockResponse({ status: 503, json: { detail: " model offline " } }),
      createMockResponse({ status: 500, json: undefined }),
    );

    await expect(getSamAudioHealth()).resolves.toEqual({ status: "ok" });
    await expect(getSamAudioHealth()).rejects.toThrow("model offline");
    await expect(getSamAudioHealth()).rejects.toThrow(
      "SAM-Audio request failed (500)",
    );
  });

  it("surfaces request failures for job and stem endpoints", async () => {
    stubFetch(
      createMockResponse({ status: 400, json: { detail: "bad request" } }),
      createMockResponse({ status: 404, json: { detail: "missing stem" } }),
    );

    await expect(
      submitSeparationJob({
        sourceId: "s",
        startTicks: 0,
        durationTicks: 1,
        prompt: {},
      }),
    ).rejects.toThrow("bad request");
    await expect(fetchStem("missing", "target")).rejects.toThrow(
      "missing stem",
    );
  });
});
