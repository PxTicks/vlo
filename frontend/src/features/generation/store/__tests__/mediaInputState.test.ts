import { describe, expect, it } from "vitest";

import type { GenerationMediaInputValue, WorkflowInput } from "../../types";
import { pruneMediaInputs } from "../mediaInputState";

const audioInput: WorkflowInput = {
  id: "audio-input",
  nodeId: "20",
  classType: "LoadAudio",
  inputType: "audio",
  param: "audio",
  label: "Audio",
  currentValue: null,
  origin: "rule",
} as WorkflowInput;

function assetValue(
  asset: Record<string, unknown>,
): GenerationMediaInputValue {
  return { kind: "asset", asset } as unknown as GenerationMediaInputValue;
}

describe("pruneMediaInputs", () => {
  it("keeps a video with audio assigned to an audio slot", () => {
    const value = assetValue({
      id: "asset-video",
      hash: "hash",
      name: "clip.mp4",
      type: "video",
      src: "assets/clip.mp4",
      hasAudio: true,
      createdAt: 0,
    });

    expect(pruneMediaInputs({ "audio-input": value }, [audioInput])).toEqual({
      "audio-input": value,
    });
  });

  it("keeps a silent video in an audio slot so its error stays visible", () => {
    // Only an external file drop can put one here — hasAudio is unknown until
    // ingest — and evicting it on the next prune would hide the explanation.
    const value = assetValue({
      id: "asset-silent",
      hash: "hash",
      name: "silent.mp4",
      type: "video",
      src: "assets/silent.mp4",
      hasAudio: false,
      createdAt: 0,
    });

    expect(pruneMediaInputs({ "audio-input": value }, [audioInput])).toEqual({
      "audio-input": value,
    });
  });

  it("drops a non-media asset assigned to an audio slot", () => {
    const value = assetValue({
      id: "asset-image",
      hash: "hash",
      name: "frame.png",
      type: "image",
      src: "assets/frame.png",
      createdAt: 0,
    });

    expect(pruneMediaInputs({ "audio-input": value }, [audioInput])).toEqual({});
  });
});
