import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SelectionOverlay } from "../SelectionOverlay";
import { useExtractStore } from "../../../player/useExtractStore";
import { useTimelineSelectionStore } from "../../../timelineSelection";
import { useTimelineViewStore } from "../../hooks/useTimelineViewStore";
import { useProjectStore } from "../../../project";
import { useTimelineStore } from "../../useTimelineStore";

const onConfirmSelection = vi.fn();
const setOnConfirmSelection = vi.fn();

interface MockSelectionState {
  selectionMode: boolean;
  selectionStage: "range" | "tracks";
  selectionStartTick: number;
  selectionEndTick: number;
  selectionMessage: string | null;
  selectionIncludeModeEnabled: boolean;
  selectionIncludedTrackIds: string[];
  selectionFpsOverride: number | null;
  selectionFrameStep: number;
  selectionRecommendedFps: number | null;
  selectionRecommendedFrameStep: number | null;
  selectionRecommendedMaxTicks: number | null;
  updateSelectionStart: Mock;
  updateSelectionEnd: Mock;
  setSelectionFpsOverride: Mock;
  setSelectionFrameStep: Mock;
  enterTrackSelectionStage: Mock;
  returnToRangeSelectionStage: Mock;
  toggleSelectionIncludedTrack: Mock;
  exitSelectionMode: Mock;
}

interface MockTimelineState {
  tracks: Array<{
    id: string;
    label: string;
    isVisible: boolean;
    isMuted: boolean;
    isLocked: boolean;
    type: "visual" | "audio";
  }>;
}

let selectionState: MockSelectionState;
let timelineState: MockTimelineState;

function createSelectionState(
  overrides: Partial<MockSelectionState> = {},
): MockSelectionState {
  return {
    selectionMode: true,
    selectionStage: "range",
    selectionStartTick: 0,
    selectionEndTick: 96_000,
    selectionMessage: "Use the highlighted tracks for this pass",
    selectionIncludeModeEnabled: true,
    selectionIncludedTrackIds: ["track-1", "track-2"],
    selectionFpsOverride: null,
    selectionFrameStep: 1,
    selectionRecommendedFps: null,
    selectionRecommendedFrameStep: null,
    selectionRecommendedMaxTicks: null,
    updateSelectionStart: vi.fn(),
    updateSelectionEnd: vi.fn(),
    setSelectionFpsOverride: vi.fn(),
    setSelectionFrameStep: vi.fn(),
    enterTrackSelectionStage: vi.fn(),
    returnToRangeSelectionStage: vi.fn(),
    toggleSelectionIncludedTrack: vi.fn(),
    exitSelectionMode: vi.fn(),
    ...overrides,
  };
}

function createTimelineState(): MockTimelineState {
  return {
    tracks: [
      {
        id: "track-1",
        label: "Video",
        isVisible: true,
        isMuted: false,
        isLocked: false,
        type: "visual",
      },
      {
        id: "track-2",
        label: "Audio",
        isVisible: true,
        isMuted: false,
        isLocked: false,
        type: "audio",
      },
      {
        id: "track-3",
        label: "FX",
        isVisible: true,
        isMuted: false,
        isLocked: false,
        type: "visual",
      },
    ],
  };
}

vi.mock("../../../player/useExtractStore", () => {
  const fn = vi.fn();
  (fn as unknown as { getState: Mock }).getState = vi.fn();
  return { useExtractStore: fn };
});

vi.mock("../../../timelineSelection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../timelineSelection")>();
  const fn = vi.fn();
  (fn as unknown as { getState: Mock }).getState = vi.fn();
  return {
    ...actual,
    useTimelineSelectionStore: fn,
  };
});

vi.mock("../../hooks/useTimelineViewStore", () => {
  const fn = vi.fn();
  (fn as unknown as { getState: Mock; subscribe: Mock }).getState = vi.fn();
  (fn as unknown as { getState: Mock; subscribe: Mock }).subscribe = vi.fn();
  return { useTimelineViewStore: fn };
});

vi.mock("../../../project", () => ({
  useProjectStore: Object.assign(vi.fn(), {
    getState: vi.fn(),
    subscribe: vi.fn(),
  }),
}));

vi.mock("../../useTimelineStore", () => ({
  useTimelineStore: Object.assign(vi.fn(), {
    getState: vi.fn(),
    subscribe: vi.fn(),
  }),
}));

vi.mock("../../../player/services/PlaybackClock", () => ({
  playbackClock: {
    time: 0,
    setTime: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe("SelectionOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    selectionState = createSelectionState();
    timelineState = createTimelineState();

    (useExtractStore as unknown as Mock).mockImplementation((selector: unknown) => {
      const state = {
        onConfirmSelection,
        setOnConfirmSelection,
      };
      if (typeof selector === "function") {
        return selector(state);
      }
      return state;
    });

    (useExtractStore as unknown as { getState: Mock }).getState.mockReturnValue({
      setOnConfirmSelection,
    });

    (useTimelineSelectionStore as unknown as Mock).mockImplementation(
      (selector: unknown) => {
        if (typeof selector === "function") {
          return selector(selectionState);
        }
        return selectionState;
      },
    );

    (
      useTimelineSelectionStore as unknown as { getState: Mock }
    ).getState.mockImplementation(() => selectionState);

    (useTimelineViewStore as unknown as Mock).mockImplementation(
      (selector: unknown) => {
        const state = {
          zoomScale: 1,
          scrollContainer: {
            getBoundingClientRect: () => ({
              left: 0,
              top: 0,
              width: 1000,
              height: 500,
            }),
            scrollLeft: 0,
          },
        };
        if (typeof selector === "function") {
          return selector(state);
        }
        return state;
      },
    );

    (
      useTimelineViewStore as unknown as { getState: Mock }
    ).getState.mockReturnValue({
      scrollContainer: null,
      ticksToPx: (ticks: number) => ticks,
    });

    (useProjectStore as unknown as Mock).mockImplementation((selector: unknown) => {
      const state = { config: { fps: 60 } };
      if (typeof selector === "function") {
        return selector(state);
      }
      return state;
    });

    (useProjectStore.getState as Mock).mockReturnValue({
      config: { fps: 60 },
    });

    (useTimelineStore as unknown as Mock).mockImplementation((selector: unknown) => {
      if (typeof selector === "function") {
        return selector(timelineState);
      }
      return timelineState;
    });

    (useTimelineStore.getState as Mock).mockImplementation(() => timelineState);

    onConfirmSelection.mockReset();
    setOnConfirmSelection.mockReset();
  });

  it("renders range-stage handles and defers track guidance until stage two", () => {
    const { container } = render(<SelectionOverlay />);

    expect(screen.getByText("Confirm Selection")).toBeInTheDocument();
    expect(
      screen.queryByText("Use the highlighted tracks for this pass"),
    ).not.toBeInTheDocument();

    const handles = container.querySelectorAll(".MuiBox-root") as NodeListOf<HTMLElement>;
    const hasColResizeHandle = Array.from(handles).some((handle) => {
      const computedStyle = window.getComputedStyle(handle);
      return (
        computedStyle.cursor === "col-resize" || handle.style.cursor === "col-resize"
      );
    });

    expect(hasColResizeHandle).toBe(true);
  });

  it("advances to track selection before final confirmation when include mode is enabled", () => {
    render(<SelectionOverlay />);

    fireEvent.click(screen.getByText("Confirm Selection"));

    expect(selectionState.enterTrackSelectionStage).toHaveBeenCalledTimes(1);
    expect(onConfirmSelection).not.toHaveBeenCalled();
  });

  it("renders track-selection stage with row overlays and final controls", () => {
    selectionState = createSelectionState({
      selectionStage: "tracks",
    });

    render(<SelectionOverlay />);

    expect(
      screen.getByText("Use the highlighted tracks for this pass"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Click timeline rows to choose which tracks to include in this selection.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("selection-track-row-track-1")).toBeInTheDocument();
    expect(screen.getByText("Back to Range")).toBeInTheDocument();
    expect(screen.getByText("Confirm Tracks")).toBeInTheDocument();
    expect(screen.getByText("2 included tracks")).toBeInTheDocument();
    expect(screen.queryByText(/Duration:/)).not.toBeInTheDocument();
  });

  it("toggles track inclusion from the full-row track overlay", () => {
    selectionState = createSelectionState({
      selectionStage: "tracks",
    });

    render(<SelectionOverlay />);

    fireEvent.click(screen.getByTestId("selection-track-row-track-3"));

    expect(selectionState.toggleSelectionIncludedTrack).toHaveBeenCalledWith("track-3");
  });

  it("falls back to the default track prompt when no workflow message is provided", () => {
    selectionState = createSelectionState({
      selectionStage: "tracks",
      selectionMessage: null,
    });

    render(<SelectionOverlay />);

    expect(
      screen.getByText(
        "Click timeline rows to choose which tracks to include in this selection.",
      ),
    ).toBeInTheDocument();
  });

  it("disables final track confirmation until a track is selected", () => {
    selectionState = createSelectionState({
      selectionStage: "tracks",
      selectionIncludedTrackIds: [],
    });

    render(<SelectionOverlay />);

    expect(screen.getByText("Confirm Tracks")).toBeDisabled();
    expect(screen.getByText("No tracks selected")).toBeInTheDocument();
    expect(screen.queryByText(/Select at least one track/)).not.toBeInTheDocument();
  });

  it("confirms immediately and does not bubble when subselection is disabled", () => {
    selectionState = createSelectionState({
      selectionIncludeModeEnabled: false,
      selectionIncludedTrackIds: [],
    });
    const parentClick = vi.fn();

    render(
      <div onClick={parentClick}>
        <SelectionOverlay />
      </div>,
    );

    fireEvent.click(screen.getByText("Confirm Selection"));

    expect(onConfirmSelection).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
    expect(
      screen.getByText("Use the highlighted tracks for this pass"),
    ).toBeInTheDocument();
  });
});
