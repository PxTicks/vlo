import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTransformationController } from "../hooks/useTransformationController";
import { useTimelineStore, TICKS_PER_SECOND } from "../../timeline";

describe("useTransformationController speed toggle", () => {
  const clipId = "clip-speed";
  const speedId = "speed-1";

  beforeEach(() => {
    useTimelineStore.setState({
      clips: [
        {
          id: clipId,
          trackId: "track-1",
          start: 0,
          timelineDuration: 5 * TICKS_PER_SECOND,
          offset: 0,
          type: "video",
          croppedSourceDuration: 10 * TICKS_PER_SECOND,
          name: "Speed Clip",
          sourceDuration: 10 * TICKS_PER_SECOND,
          transformedDuration: 5 * TICKS_PER_SECOND,
          transformedOffset: 0,
          transformations: [
            {
              id: speedId,
              type: "speed",
              isEnabled: true,
              parameters: { factor: 2 },
            },
          ],
        },
      ],
      selectedClipIds: [clipId],
    });
  });

  it("disables speed and recomputes clip shape", () => {
    const { result } = renderHook(() => useTransformationController());

    act(() => {
      result.current.handleSetTransformEnabled(speedId, false);
    });

    const clip = useTimelineStore
      .getState()
      .clips.find((currentClip) => currentClip.id === clipId);

    const speedTransform = clip?.transformations.find((t) => t.id === speedId);
    expect(speedTransform?.isEnabled).toBe(false);
    expect(clip?.timelineDuration).toBeGreaterThan(5 * TICKS_PER_SECOND);
    expect(clip?.transformedDuration).toBeGreaterThan(5 * TICKS_PER_SECOND);
  });
});
