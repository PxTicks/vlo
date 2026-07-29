import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostViewRegistry } from "../../../../core/shell/viewRegistry";
import type { StandardTimelineClip } from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline/constants";
import { useCompositeLibraryStore } from "../../useCompositeLibraryStore";
import { useTimelineCompositeRevealClipOverlay } from "../useTimelineCompositeRevealClipOverlay";

const compositeClip: StandardTimelineClip = {
  id: "clip-1",
  trackId: "track-1",
  start: 0,
  type: "video",
  assetId: "bake-1",
  compositeId: "composite-1",
  name: "Opening scene",
  sourceDuration: TICKS_PER_SECOND,
  transformedDuration: TICKS_PER_SECOND,
  transformedOffset: 0,
  timelineDuration: TICKS_PER_SECOND,
  croppedSourceDuration: TICKS_PER_SECOND,
  offset: 0,
  transformations: [],
};

describe("useTimelineCompositeRevealClipOverlay", () => {
  beforeEach(() => {
    useCompositeLibraryStore.setState({ revealRequest: null });
  });

  it("switches to the composite browser and targets the composite card", () => {
    const selectView = vi
      .spyOn(hostViewRegistry, "select")
      .mockReturnValue(true);
    const { result } = renderHook(() => {
      const overlay = useTimelineCompositeRevealClipOverlay();
      return overlay.useItems({ clip: compositeClip, isSelected: false });
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0].id).toBe("reveal-composite:clip-1");

    result.current[0].onClick?.();

    expect(selectView).toHaveBeenCalledWith("left-sidebar", "host.composite");
    expect(useCompositeLibraryStore.getState().revealRequest).toMatchObject({
      compositeAssetId: "composite-1",
      requestId: expect.any(Number),
    });
  });
});
