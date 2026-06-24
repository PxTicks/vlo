import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { ClipPresentationContext } from "../../../transformations";
import {
  createSamAudioPromptPayload,
  createSpanAnchorsForClip,
} from "../promptMapping";

const clip: TimelineClip = {
  id: "clip-1",
  trackId: "track-1",
  type: "audio",
  name: "Audio",
  assetId: "asset-1",
  start: 100,
  timelineDuration: 200,
  sourceDuration: 500,
  offset: 50,
  croppedSourceDuration: 200,
  transformedOffset: 50,
  transformedDuration: 200,
  transformations: [],
};

const context: ClipPresentationContext = {
  tracks: [],
  clips: [clip],
  fps: 30,
};

describe("SAM-Audio prompt mapping", () => {
  it("returns no anchors when span selection is disabled or disjoint", () => {
    expect(
      createSpanAnchorsForClip(clip, context, {
        selectionMode: false,
        selectionStartTick: 100,
        selectionEndTick: 200,
      }),
    ).toBeUndefined();
    expect(
      createSpanAnchorsForClip(clip, context, {
        selectionMode: true,
        selectionStartTick: 0,
        selectionEndTick: 50,
      }),
    ).toBeUndefined();
    expect(
      createSpanAnchorsForClip(clip, context, {
        selectionMode: true,
        selectionStartTick: 300,
        selectionEndTick: 350,
      }),
    ).toBeUndefined();
  });

  it("normalizes reversed selection and clips it to the media window", () => {
    expect(
      createSpanAnchorsForClip(clip, context, {
        selectionMode: true,
        selectionStartTick: 350,
        selectionEndTick: 150,
      }),
    ).toEqual([[["+", 0.0005208333333333333, 0.0020833333333333333]]]);
  });

  it("uses a minimum source window when persisted duration is zero", () => {
    const zeroWindow = {
      ...clip,
      croppedSourceDuration: 0,
      timelineDuration: 10,
    };
    expect(
      createSpanAnchorsForClip(zeroWindow, { ...context, clips: [zeroWindow] }, {
        selectionMode: true,
        selectionStartTick: 100,
        selectionEndTick: 110,
      }),
    ).toEqual([[["+", 0, 0.000010416666666666666]]]);
  });

  it("builds normalized text, span, and visual prompts", () => {
    const anchors: Array<Array<["+", number, number]>> = [
      [["+", 1, 2]],
    ];
    expect(
      createSamAudioPromptPayload({
        text: "  Barking DOG  ",
        anchors,
        useSpanPrompt: true,
        visualPrompt: {
          sam2SourceId: "source",
          sam2MaskId: "mask",
        },
        useVisualPrompt: true,
      }),
    ).toEqual({
      text: "barking dog",
      anchors,
      sam2SourceId: "source",
      sam2MaskId: "mask",
      rerankingCandidates: 1,
    });
  });

  it("omits blank or disabled optional prompt parts", () => {
    expect(
      createSamAudioPromptPayload({
        text: "   ",
        anchors: [[["+", 1, 2]]],
        useSpanPrompt: false,
        visualPrompt: { sam2SourceId: "source", sam2MaskId: "mask" },
        useVisualPrompt: false,
      }),
    ).toEqual({ rerankingCandidates: 1 });
    expect(
      createSamAudioPromptPayload({
        text: "sound",
        useSpanPrompt: true,
        visualPrompt: null,
        useVisualPrompt: true,
      }),
    ).toEqual({ text: "sound", rerankingCandidates: 1 });
  });
});
