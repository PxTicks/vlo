import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { TextPanel } from "../TextPanel";

const mocks = vi.hoisted(() => ({
  clips: [] as TimelineClip[],
  selectedClipIds: [] as string[],
  updateTextClipData: vi.fn(),
  insertTextClipAtPlayhead: vi.fn(),
  livePreviewTextStore: {
    set: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock("../../timeline/api", () => ({
  useTimelineClips: () => mocks.clips,
  useSelectedTimelineClipIds: () => mocks.selectedClipIds,
  updateTimelineTextClipData: mocks.updateTextClipData,
}));

vi.mock("../utils/insertTextClipAtPlayhead", () => ({
  insertTextClipAtPlayhead: mocks.insertTextClipAtPlayhead,
}));

vi.mock("../services/livePreviewTextStore", () => ({
  livePreviewTextStore: mocks.livePreviewTextStore,
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
      strokeColor: "#000000",
      strokeWidth: 2,
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
    mocks.livePreviewTextStore.set.mockReset();
    mocks.livePreviewTextStore.clear.mockReset();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(16);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
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
    expect(mocks.livePreviewTextStore.set).toHaveBeenCalledWith("clip_text_1", {
      fill: "#ff5500",
    });

    fireEvent.blur(colorInput);

    expect(mocks.updateTextClipData).toHaveBeenCalledWith("clip_text_1", {
      fill: "#ff5500",
    });
    expect(mocks.livePreviewTextStore.clear).toHaveBeenCalledWith(
      "clip_text_1",
      ["fill"],
    );
  });

  it("previews text content live and commits on blur", () => {
    mocks.clips = [createTextClip()];
    mocks.selectedClipIds = ["clip_text_1"];

    render(<TextPanel />);

    const contentInput = screen.getByLabelText("Content");
    contentInput.innerHTML = "Updated live preview";
    fireEvent.input(contentInput);

    expect(mocks.livePreviewTextStore.set).toHaveBeenCalledWith("clip_text_1", {
      content: "Updated live preview",
      runs: undefined,
    });
    expect(mocks.updateTextClipData).not.toHaveBeenCalled();

    fireEvent.blur(contentInput);

    expect(mocks.updateTextClipData).toHaveBeenCalledWith("clip_text_1", {
      content: "Updated live preview",
      runs: undefined,
    });
    expect(mocks.livePreviewTextStore.clear).toHaveBeenCalledWith(
      "clip_text_1",
      ["content", "runs"],
    );
  });

  it("captures bold and italic formatting as TextRun entries on commit", () => {
    mocks.clips = [createTextClip()];
    mocks.selectedClipIds = ["clip_text_1"];

    render(<TextPanel />);

    const contentInput = screen.getByLabelText("Content");
    contentInput.innerHTML = "<b>Hello</b> <i>world</i>";
    fireEvent.input(contentInput);
    fireEvent.blur(contentInput);

    expect(mocks.updateTextClipData).toHaveBeenCalledWith("clip_text_1", {
      content: "Hello world",
      runs: [
        { text: "Hello", bold: true },
        { text: " " },
        { text: "world", italic: true },
      ],
    });
  });

  it("creates a draft text clip after content is edited", () => {
    render(<TextPanel />);
    const addButton = screen.getByRole("button", { name: "Add Text Clip" });
    expect(addButton).toBeEnabled();

    const contentInput = screen.getByLabelText("Content");
    contentInput.innerHTML = "A new title";
    fireEvent.input(contentInput);
    fireEvent.blur(contentInput);
    fireEvent.click(addButton);

    expect(mocks.insertTextClipAtPlayhead).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "A new title",
      }),
    );
  });

  it("commits selected font size, stroke width, and alignment controls", () => {
    mocks.clips = [createTextClip()];
    mocks.selectedClipIds = ["clip_text_1"];
    render(<TextPanel />);

    const size = screen.getByLabelText("Size");
    fireEvent.change(size, { target: { value: "120" } });
    fireEvent.blur(size);
    expect(mocks.updateTextClipData).toHaveBeenCalledWith("clip_text_1", {
      fontSize: 120,
    });

    const width = screen.getByLabelText("Width");
    fireEvent.change(width, { target: { value: "4" } });
    fireEvent.keyDown(width, { key: "Enter" });
    fireEvent.blur(width);
    expect(mocks.updateTextClipData).toHaveBeenCalledWith("clip_text_1", {
      strokeWidth: 4,
    });

    fireEvent.click(screen.getByRole("button", { name: "Align right" }));
    expect(mocks.updateTextClipData).toHaveBeenCalledWith("clip_text_1", {
      align: "right",
    });
  });

  it("previews and commits stroke color independently", () => {
    mocks.clips = [createTextClip()];
    mocks.selectedClipIds = ["clip_text_1"];
    render(<TextPanel />);

    const stroke = screen.getByLabelText("Stroke");
    fireEvent.change(stroke, { target: { value: "#00ff00" } });
    expect(mocks.livePreviewTextStore.set).toHaveBeenCalledWith("clip_text_1", {
      strokeColor: "#00ff00",
    });
    fireEvent.blur(stroke);
    expect(mocks.updateTextClipData).toHaveBeenCalledWith("clip_text_1", {
      strokeColor: "#00ff00",
    });
    expect(mocks.livePreviewTextStore.clear).toHaveBeenCalledWith(
      "clip_text_1",
      ["strokeColor"],
    );
  });

  it("shows selection guidance for multi-selection", () => {
    mocks.clips = [createTextClip(), createTextClip({ id: "clip_text_2" })];
    mocks.selectedClipIds = ["clip_text_1", "clip_text_2"];
    render(<TextPanel />);
    expect(screen.getByText(/Select a text clip to edit it/i)).toBeInTheDocument();
  });

  it("cancels pending previews and clears live state on unmount", () => {
    const callback = vi.fn();
    vi.stubGlobal("requestAnimationFrame", vi.fn((next: FrameRequestCallback) => {
      callback.mockImplementation(() => next(16));
      return 42;
    }));
    const cancel = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancel);
    mocks.clips = [createTextClip()];
    mocks.selectedClipIds = ["clip_text_1"];
    const { unmount } = render(<TextPanel />);

    fireEvent.change(screen.getByLabelText("Color"), {
      target: { value: "#123456" },
    });
    unmount();

    expect(cancel).toHaveBeenCalledWith(42);
    expect(mocks.livePreviewTextStore.clear).toHaveBeenCalledWith("clip_text_1");
  });
});
