import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { SelectionOverlay } from "../SelectionOverlay";
import { useExtractStore } from "../../../player/useExtractStore";
import { useTimelineSelectionStore } from "../../../timelineSelection";
import { useTimelineViewStore } from "../../hooks/useTimelineViewStore";
import { useProjectStore } from "../../../project";

// Mock the dependencies
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

// Mock PlaybackClock
vi.mock("../../../player/services/PlaybackClock", () => ({
  playbackClock: {
    time: 0,
    setTime: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

// Mock ResizeObserver
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe("SelectionOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementation
    (useExtractStore as unknown as Mock).mockImplementation(
      (selector: unknown) => {
        const state = {
          onConfirmSelection: vi.fn(),
          setOnConfirmSelection: vi.fn(),
        };
        if (typeof selector === "function") {
          return selector(state);
        }
        return state;
      },
    );

    (useExtractStore as unknown as { getState: Mock }).getState.mockReturnValue(
      {
        setOnConfirmSelection: vi.fn(),
      },
    );

    (useTimelineSelectionStore as unknown as Mock).mockImplementation(
      (selector: unknown) => {
        const state = {
          selectionMode: true,
          selectionStartTick: 0,
          selectionEndTick: 96000,
          selectionFpsOverride: null,
          selectionFrameStep: 1,
          updateSelectionStart: vi.fn(),
          updateSelectionEnd: vi.fn(),
          setSelectionFpsOverride: vi.fn(),
          setSelectionFrameStep: vi.fn(),
          exitSelectionMode: vi.fn(),
        };
        if (typeof selector === "function") {
          return selector(state);
        }
        return state;
      },
    );

    (
      useTimelineSelectionStore as unknown as { getState: Mock }
    ).getState.mockReturnValue({
      selectionStartTick: 0,
      selectionEndTick: 96000,
      selectionFpsOverride: null,
      selectionFrameStep: 1,
      updateSelectionStart: vi.fn(),
      updateSelectionEnd: vi.fn(),
      setSelectionFpsOverride: vi.fn(),
      setSelectionFrameStep: vi.fn(),
      exitSelectionMode: vi.fn(),
    });

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
      zoomScale: 1,
      scrollContainer: null, // this might need to be mocked further if used outside of event handlers
    });

    (useProjectStore as unknown as Mock).mockImplementation(
      (selector: unknown) => {
        const state = { config: { fps: 60 } };
        if (typeof selector === "function") {
          return selector(state);
        }
        return state;
      },
    );

    (useProjectStore.getState as Mock).mockReturnValue({
      config: { fps: 60 },
    });
  });

  it("should render selection handles and confirm button when in selection mode", () => {
    // Act
    const { container } = render(<SelectionOverlay />);

    // Check if the confirm button exists
    const confirmButton = screen.queryByText("Confirm Selection");
    expect(confirmButton).not.toBeNull();

    // Check if any element has cursor: col-resize (handles)
    const handles = container.querySelectorAll(
      'div[style*="cursor: col-resize"], .MuiBox-root',
    ) as NodeListOf<HTMLElement>;

    let hasColResize = false;
    for (let i = 0; i < handles.length; i++) {
      const computedStyle = window.getComputedStyle(handles[i]);
      // Also check inline style just in case getComputedStyle behaves differently in JSDOM
      if (
        computedStyle.cursor === "col-resize" ||
        handles[i].style.cursor === "col-resize"
      ) {
        hasColResize = true;
        break;
      }
    }

    expect(hasColResize).toBe(true);
  });
});
