import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import { TextPanel } from "../TextPanel";

const mocks = vi.hoisted(() => ({
  clips: [] as TimelineClip[],
  selectedClipIds: [] as string[],
  updateTextClipData: vi.fn(),
  insertTextClipAtPlayhead: vi.fn(),
}));

vi.mock("../../timeline", () => ({
  useTimelineStore: (selector: (state: unknown) => unknown) =>
    selector({
      clips: mocks.clips,
      selectedClipIds: mocks.selectedClipIds,
      updateTextClipData: mocks.updateTextClipData,
    }),
}));

vi.mock("../utils/insertTextClipAtPlayhead", () => ({
  insertTextClipAtPlayhead: mocks.insertTextClipAtPlayhead,
}));

function createTextClip(
  overrides: Partial<TimelineClip> = {},
): TimelineClip {
  return {
    id: "clip_text_1",
    trackId: "track_1",
    type: "text",
    name: "Hello world",
    sourceDuration: null,
    start: 0,
    timelineDuration: 150,
    offset: 0,
    transformedDuration: 150,
    transformedOffset: 0,
    croppedSourceDuration: 150,
    transformations: [],
    textData: {
      content: "Hello world",
      fontFamily: "Arial",
      fontSize: 96,
      fill: "#ffffff",
      align: "center",
    },
    ...overrides,
  } as TimelineClip;
}

describe("TextPanel", () => {
  beforeEach(() => {
    mocks.clips = [];
    mocks.selectedClipIds = [];
    mocks.updateTextClipData.mockReset();
    mocks.insertTextClipAtPlayhead.mockReset();
  });

  it("shows the new text form when nothing is selected", () => {
    render(<TextPanel />);

    expect(screen.getByText("New Text")).toBeInTheDocument();
    expect(screen.queryByText("Selected Text Clip")).not.toBeInTheDocument();
  });

  it("replaces the creation form with the edit form when a text clip is selected", () => {
    mocks.clips = [createTextClip()];
    mocks.selectedClipIds = ["clip_text_1"];

    render(<TextPanel />);

    expect(screen.queryByText("New Text")).not.toBeInTheDocument();
    expect(screen.getByText("Selected Text Clip")).toBeInTheDocument();
  });

  it("replaces the creation form with guidance when a non-text clip is selected", () => {
    mocks.clips = [
      {
        id: "clip_video_1",
        trackId: "track_1",
        type: "video",
        name: "Video",
        assetId: "asset_1",
        sourceDuration: 150,
        start: 0,
        timelineDuration: 150,
        offset: 0,
        transformedDuration: 150,
        transformedOffset: 0,
        croppedSourceDuration: 150,
        transformations: [],
      } as TimelineClip,
    ];
    mocks.selectedClipIds = ["clip_video_1"];

    render(<TextPanel />);

    expect(screen.queryByText("New Text")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Select a text clip to edit it, or clear the current selection to create a new one.",
      ),
    ).toBeInTheDocument();
  });

  it("buffers color updates until the picker loses focus", () => {
    mocks.clips = [createTextClip()];
    mocks.selectedClipIds = ["clip_text_1"];

    render(<TextPanel />);

    const colorInput = screen.getByLabelText("Color");
    fireEvent.change(colorInput, { target: { value: "#ff5500" } });

    expect(mocks.updateTextClipData).not.toHaveBeenCalled();

    fireEvent.blur(colorInput);

    expect(mocks.updateTextClipData).toHaveBeenCalledWith("clip_text_1", {
      fill: "#ff5500",
    });
  });
});
