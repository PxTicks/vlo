import { describe, expect, it } from "vitest";
import { parseHistoryOutputs, parseNodeOutputItems } from "../parsers";

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

  it("returns empty outputs when prompt history entry is missing", () => {
    const result = parseHistoryOutputs({}, "prompt-1");
    expect(result.hasPromptEntry).toBe(false);
    expect(result.outputs).toEqual([]);
  });
});
