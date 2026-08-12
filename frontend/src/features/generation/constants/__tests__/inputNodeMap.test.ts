import { describe, expect, it } from "vitest";
import {
  INPUT_NODE_MAP,
  mergeInputNodeMap,
  resolveInputNodeMappings,
} from "../inputNodeMap";
import {
  getOutputMediaKindFromFile,
  getOutputMediaKindFromFilename,
} from "../mediaKinds";

describe("generation input node constants", () => {
  it("resolves static mappings and class aliases", () => {
    expect(resolveInputNodeMappings(INPUT_NODE_MAP, "LoadImage")).toEqual([
      expect.objectContaining({ inputType: "image", param: "image" }),
    ]);
    expect(
      resolveInputNodeMappings(INPUT_NODE_MAP, "VLOMemoryLoadImage"),
    ).toEqual([
      expect.objectContaining({ inputType: "image", param: "image" }),
    ]);
    expect(resolveInputNodeMappings(INPUT_NODE_MAP, null)).toEqual([]);
    expect(resolveInputNodeMappings(INPUT_NODE_MAP, "Unknown")).toEqual([]);
    expect(
      resolveInputNodeMappings(INPUT_NODE_MAP, "vloMemoryLoadVideoBatch"),
    ).toEqual([
      expect.objectContaining({
        inputType: "video",
        param: "files",
        label: "Video",
      }),
    ]);
  });

  it("merges valid dynamic entries while static parameters take precedence", () => {
    expect(mergeInputNodeMap(null)).toBe(INPUT_NODE_MAP);
    const merged = mergeInputNodeMap({
      LoadImage: [
        {
          input_type: "video",
          param: "image",
          label: "Wrong static override",
        },
        {
          input_type: "text",
          param: "caption",
          label: "Caption",
        },
        {
          input_type: "unsupported",
          param: "ignored",
        },
      ],
      CustomAudio: [
        {
          input_type: "audio",
          param: "audio",
          description: undefined,
        },
      ],
      Empty: [
        {
          input_type: "unsupported",
          param: "ignored",
        },
      ],
    });

    expect(merged.LoadImage).toEqual([
      expect.objectContaining({ inputType: "image", param: "image" }),
      expect.objectContaining({ inputType: "text", param: "caption" }),
    ]);
    expect(merged.CustomAudio).toEqual([
      {
        inputType: "audio",
        param: "audio",
        label: undefined,
        description: null,
      },
    ]);
    expect(merged.Empty).toBeUndefined();
  });

  it.each([
    [new File([], "image.bin", { type: "image/png" }), "image"],
    [new File([], "sound.MP3"), "audio"],
    [new File([], "movie.mov"), "video"],
    [new File([], "unknown.bin"), "unknown"],
  ])("detects file media kinds", (file, expected) => {
    expect(getOutputMediaKindFromFile(file)).toBe(expected);
  });

  it.each([
    ["image.GIF", "image"],
    ["sound.flac", "audio"],
    ["movie.mkv", "video"],
    ["no-extension", "unknown"],
  ])("detects filename media kind for %s", (filename, expected) => {
    expect(getOutputMediaKindFromFilename(filename)).toBe(expected);
  });
});
