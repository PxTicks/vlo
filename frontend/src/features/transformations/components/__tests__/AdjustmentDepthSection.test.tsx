import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ADJUSTMENT_DEPTH_ALL,
  ADJUSTMENT_RETIMING_RIPPLE,
  ADJUSTMENT_RETIMING_STATIC,
  type AdjustmentDepth,
  type AdjustmentRetimingMode,
  type AdjustmentTimelineClip,
  type TimelineTrack,
} from "../../../../types/TimelineTypes";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { AdjustmentDepthSection } from "../AdjustmentDepthSection";

function adjustmentTrack(id: string): TimelineTrack {
  return {
    id,
    type: "adjustment",
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function visualTrack(id: string): TimelineTrack {
  return {
    id,
    type: "visual",
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function seedAdjustmentClip(
  depth: AdjustmentDepth,
  retimingMode: AdjustmentRetimingMode = ADJUSTMENT_RETIMING_STATIC,
): void {
  const clip: AdjustmentTimelineClip = {
    id: "adj-1",
    type: "adjustment",
    name: "Adjustment",
    trackId: "adj-track",
    start: 0,
    timelineDuration: 100,
    sourceDuration: 100,
    transformedDuration: 100,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    offset: 0,
    transformations: [],
    depth,
    retimingMode,
  };

  useTimelineStore.setState({
    tracks: [
      adjustmentTrack("adj-track"),
      visualTrack("v1"),
      visualTrack("v2"),
    ],
    clips: [clip],
    selectedClipIds: [clip.id],
  });
}

function Harness() {
  const clip = useTimelineStore((state) =>
    state.clips.find(
      (candidate): candidate is AdjustmentTimelineClip =>
        candidate.id === "adj-1" && candidate.type === "adjustment",
    ),
  );

  if (!clip) {
    throw new Error("Expected adjustment clip in harness");
  }

  return <AdjustmentDepthSection clip={clip} />;
}

describe("AdjustmentDepthSection", () => {
  beforeEach(() => {
    seedAdjustmentClip(ADJUSTMENT_DEPTH_ALL);
  });

  it('renders the "all tracks below" summary for sentinel depth', () => {
    render(<Harness />);

    expect(
      screen.getByRole("switch", { name: "All tracks below" }),
    ).toBeChecked();
    expect(
      screen.getByText("Currently covering 2 tracks below this lane."),
    ).toBeInTheDocument();
  });

  it("switches from sentinel depth to the current numeric stack size", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("switch", { name: "All tracks below" }));

    const clip = useTimelineStore
      .getState()
      .clips.find((candidate) => candidate.id === "adj-1") as AdjustmentTimelineClip;

    expect(clip.depth).toBe(2);
    expect(screen.getByRole("spinbutton")).toHaveValue(2);
  });

  it("toggles ripple retiming mode", () => {
    render(<Harness />);

    fireEvent.click(
      screen.getByRole("switch", { name: "Ripple timeline timing" }),
    );

    const clip = useTimelineStore
      .getState()
      .clips.find((candidate) => candidate.id === "adj-1") as AdjustmentTimelineClip;

    expect(clip.retimingMode).toBe(ADJUSTMENT_RETIMING_RIPPLE);
    expect(
      screen.getByText(
        "Speed changes stretch or contract the affected lanes, so later clips shift in presentation time.",
      ),
    ).toBeInTheDocument();
  });

  it('switches a numeric depth back to the "all" sentinel', () => {
    seedAdjustmentClip(1);
    render(<Harness />);

    fireEvent.click(screen.getByRole("switch", { name: "All tracks below" }));

    const clip = useTimelineStore
      .getState()
      .clips.find((candidate) => candidate.id === "adj-1") as AdjustmentTimelineClip;

    expect(clip.depth).toBe(ADJUSTMENT_DEPTH_ALL);
    expect(
      screen.getByText("Currently covering 2 tracks below this lane."),
    ).toBeInTheDocument();
  });
});
