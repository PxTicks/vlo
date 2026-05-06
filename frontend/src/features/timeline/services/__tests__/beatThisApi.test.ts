import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectBeats,
  registerBeatThisSource,
} from "../beatThisApi";

describe("beatThisApi", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  it("posts the audio file and source hash to /beats/sources as multipart form data", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ sourceId: "abc123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const file = new File([new Uint8Array([1, 2, 3])], "track.wav", {
      type: "audio/wav",
    });

    const result = await registerBeatThisSource(file, "abc123");

    expect(result).toEqual({ sourceId: "abc123" });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toContain("/beats/sources");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    const formData = init?.body as FormData;
    expect(formData.get("source_hash")).toBe("abc123");
    expect(formData.get("audio")).toBeInstanceOf(File);
    expect((formData.get("audio") as File).name).toBe("track.wav");
  });

  it("posts the detect request as JSON and returns the parsed response", async () => {
    const responsePayload = {
      sourceId: "abc123",
      modelName: "final0",
      dbn: false,
      beats: [
        { timeSeconds: 0.5, timeTicks: 48000, isDownbeat: true },
        { timeSeconds: 1.0, timeTicks: 96000, isDownbeat: false },
      ],
      beatCount: 2,
      downbeatCount: 1,
    };

    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await detectBeats({
      sourceId: "abc123",
      ticksPerSecond: 96000,
    });

    expect(result).toEqual(responsePayload);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toContain("/beats/detect");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      sourceId: "abc123",
      ticksPerSecond: 96000,
    });
  });

  it("preserves backend error detail in the thrown message", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ detail: "Beat This! source 'abc' was not found" }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await expect(
      detectBeats({ sourceId: "abc", ticksPerSecond: 96000 }),
    ).rejects.toThrow("Beat This! source 'abc' was not found");
  });

  it("falls back to a generic message when the error payload is not JSON", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("<html>Not JSON</html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      }),
    );

    await expect(
      detectBeats({ sourceId: "abc", ticksPerSecond: 96000 }),
    ).rejects.toThrow("Beat This! request failed (500)");
  });
});
