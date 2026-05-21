import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { playbackClock } from "../../player/services/PlaybackClock";
import { useExtractStore } from "../../player/useExtractStore";
import { useTimelineSelectionStore } from "../../timelineSelection";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { CompositePanel } from "../CompositePanel";
import { useCompositeTimelineStore } from "../useCompositeTimelineStore";

vi.mock("../services/groupSelectionIntoComposite", () => ({
  groupSelectionIntoComposite: vi.fn(),
}));

describe("CompositePanel", () => {
  beforeEach(() => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        {
          id: "track-1",
          label: "Track 1",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
      clips: [],
    });
    useTimelineSelectionStore.getState().exitSelectionMode();
    useExtractStore.setState({ onConfirmSelection: null });
    useCompositeTimelineStore.setState({
      stack: [],
      isBusy: false,
      lastError: null,
    });
    playbackClock.setTime(0);
  });

  it("opens the timeline selection overlay for create from selection", () => {
    render(<CompositePanel />);

    fireEvent.click(screen.getByTestId("composite-create-from-selection"));

    expect(useTimelineSelectionStore.getState().selectionMode).toBe(true);
    expect(useExtractStore.getState().onConfirmSelection).toEqual(
      expect.any(Function),
    );
  });
});
