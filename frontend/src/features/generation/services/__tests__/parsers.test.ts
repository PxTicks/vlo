import { describe, expect, it } from "vitest";
import {
  parseHistoryOutputs,
  parseNodeOutputItems,
  parseQueuePromptIds,
} from "../parsers";

describe("generation parsers", () => {
  it("parses mixed node outputs into viewable output items", () => {
    const outputs = parseNodeOutputItems({
      images: [{ filename: "img.png", subfolder: "", type: "output" }],
      videos: [{ filename: "clip.mp4", subfolder: "", type: "output" }],
      audio: [{ filename: "audio.wav", subfolder: "", type: "output" }],
    });

    expect(outputs.map((item) => item.filename)).toEqual([
      "img.png",
      "clip.mp4",
      "audio.wav",
    ]);
    expect(outputs.every((item) => item.viewUrl.includes("/comfy/api/view?"))).toBe(
      true,
    );
  });

  it("preserves explicit view urls for memory-backed outputs", () => {
    const outputs = parseNodeOutputItems({
      videos: [
        {
          filename: "clip.mp4",
          subfolder: "video",
          type: "output",
          view_url: "/api/vlo-memory/view/media-123",
        },
      ],
    });

    expect(outputs).toEqual([
      expect.objectContaining({
        filename: "clip.mp4",
        viewUrl: expect.stringContaining("/api/vlo-memory/view/media-123"),
      }),
    ]);
  });

  it("returns empty outputs when prompt history entry is missing", () => {
    const result = parseHistoryOutputs({}, "prompt-1");
    expect(result.hasPromptEntry).toBe(false);
    expect(result.outputs).toEqual([]);
  });

  it("extracts prompt ids from queue tuples and object entries", () => {
    const result = parseQueuePromptIds({
      queue_running: [[1, "prompt-running", {}, {}, []]],
      queue_pending: [
        [2, "prompt-pending", {}, {}, []],
        { prompt_id: "prompt-object" },
      ],
    });

    expect(Array.from(result)).toEqual([
      "prompt-running",
      "prompt-pending",
      "prompt-object",
    ]);
  });
});
