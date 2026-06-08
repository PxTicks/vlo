import { describe, expect, it } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type { ClipTransform, TimelineClip } from "../../../../types/TimelineTypes";
import { createSplitAudioClips } from "../createSplitAudioClip";

function createAudioAsset(id: string): Asset {
  return {
    id,
    hash: `${id}-hash`,
    name: `${id}.wav`,
    type: "audio",
    src: `blob:${id}`,
    createdAt: 1,
  };
}

describe("createSplitAudioClips", () => {
  it("creates ordinary audio clips aligned to the source clip window", () => {
    const speedTransform: ClipTransform = {
      id: "speed-1",
      type: "speed",
      isEnabled: true,
      parameters: { factor: 2 },
    };
    const sourceClip: TimelineClip = {
      id: "source-clip",
      type: "video",
      name: "Interview",
      assetId: "source-asset",
      trackId: "source-track",
      start: 240_000,
      sourceDuration: 960_000,
      timelineDuration: 120_000,
      croppedSourceDuration: 240_000,
      offset: 480_000,
      transformedDuration: 480_000,
      transformedOffset: 240_000,
      transformations: [speedTransform],
    };

    const { targetClip, residualClip } = createSplitAudioClips({
      sourceClip,
      targetAsset: createAudioAsset("target-asset"),
      residualAsset: createAudioAsset("residual-asset"),
      durationTicks: 240_000,
      targetTrackId: "target-track",
      residualTrackId: "residual-track",
    });

    expect(targetClip.type).toBe("audio");
    expect(residualClip.type).toBe("audio");
    expect(targetClip.trackId).toBe("target-track");
    expect(residualClip.trackId).toBe("residual-track");
    expect(targetClip.assetId).toBe("target-asset");
    expect(residualClip.assetId).toBe("residual-asset");
    expect(targetClip.start).toBe(sourceClip.start);
    expect(residualClip.start).toBe(sourceClip.start);
    expect(targetClip.offset).toBe(0);
    expect(residualClip.offset).toBe(0);
    expect(targetClip.sourceDuration).toBe(240_000);
    expect(targetClip.croppedSourceDuration).toBe(240_000);
    expect(targetClip.timelineDuration).toBe(sourceClip.timelineDuration);
    expect(targetClip.transformedDuration).toBe(sourceClip.timelineDuration);
    expect(targetClip.transformations).toEqual(sourceClip.transformations);
    expect(targetClip.transformations).not.toBe(sourceClip.transformations);
  });
});
