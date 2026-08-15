import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { playbackClock } from "../../../../core/playback/PlaybackClock";
import { TimelineRuler } from "../TimelineRuler";

const mocks = vi.hoisted(() => ({
  zoomScale: 1,
  pxToTicks: vi.fn((pixels: number) => pixels * 100),
  subscribe: vi.fn(() => vi.fn()),
  snapTickToFrameGrid: vi.fn((ticks: number) => ticks + 7),
  resizeCallback: null as ResizeObserverCallback | null,
}));

vi.mock("../../hooks/useTimelineViewStore", () => ({
  useTimelineViewStore: {
    getState: () => ({
      zoomScale: mocks.zoomScale,
      pxToTicks: mocks.pxToTicks,
    }),
    subscribe: mocks.subscribe,
  },
}));

vi.mock("../../../project/useProjectStore", () => {
  const state = { config: { fps: 24 } };
  const useProjectStore = <T,>(selector: (value: typeof state) => T) =>
    selector(state);
  useProjectStore.getState = () => state;
  return { useProjectStore };
});

vi.mock("../../../../core/time/frameGrid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../core/time/frameGrid")>()),
  snapTickToFrameGrid: mocks.snapTickToFrameGrid,
}));

/**
 * Records the style in force at each paint, so the tests can assert the
 * gradation hierarchy (which tone drew which marks) and not just geometry.
 */
function canvasContext() {
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(() => {
      context.strokedWith.push(context.strokeStyle);
    }),
    fillText: vi.fn((text: string) => {
      context.labels.push({ text, color: context.fillStyle });
    }),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "",
    strokedWith: [] as string[],
    labels: [] as { text: string; color: string }[],
  };
  return context;
}

/** Mean channel value of a `#rrggbb` colour — enough to compare tones. */
function brightness(color: string): number {
  const channels = color.slice(1).match(/../g) ?? [];
  return (
    channels.reduce((sum, channel) => sum + parseInt(channel, 16), 0) /
    (channels.length || 1)
  );
}

describe("TimelineRuler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.zoomScale = 1;
    mocks.resizeCallback = null;
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function (callback: ResizeObserverCallback) {
        mocks.resizeCallback = callback;
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it("does nothing until a scroll container is available", () => {
    const ref = { current: null };
    const view = render(<TimelineRuler scrollContainerRef={ref} />);
    expect(mocks.resizeCallback).toBeNull();
    expect(view.getByTestId("timeline-ruler")).toBeInTheDocument();
  });

  it("sizes, draws, redraws, and cleans up the canvas", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.scrollLeft = 40;
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as never,
    );
    const unsubscribe = vi.fn();
    mocks.subscribe.mockReturnValue(unsubscribe);
    const removeSpy = vi.spyOn(scrollContainer, "removeEventListener");
    const { container, unmount } = render(
      <TimelineRuler scrollContainerRef={{ current: scrollContainer }} />,
    );

    act(() => {
      mocks.resizeCallback?.(
        [
          {
            contentRect: { width: 500 },
          } as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    });
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 500, 24);
    expect(context.fillText).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{2}:\d{2}$/),
      expect.any(Number),
      14,
    );

    fireEvent.scroll(scrollContainer);
    expect(context.clearRect.mock.calls.length).toBeGreaterThan(1);
    const subscription = (mocks.subscribe.mock.calls as unknown[][])[0]?.[0] as
      | (() => void)
      | undefined;
    subscription?.();
    expect(context.clearRect.mock.calls.length).toBeGreaterThan(2);

    expect(container.querySelector("canvas")).toHaveAttribute("width", "500");
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("falls back to frame gradations when zoomed all the way in", () => {
    mocks.zoomScale = 20;
    const scrollContainer = document.createElement("div");
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as never,
    );
    render(<TimelineRuler scrollContainerRef={{ current: scrollContainer }} />);
    act(() => {
      mocks.resizeCallback?.(
        [{ contentRect: { width: 500 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });

    // 24fps at 2000px/s: a gradation per frame, labels every second frame.
    expect(context.labels.map((label) => label.text)).toEqual([
      "00:00",
      "2f",
      "4f",
      "6f",
    ]);
  });

  it("draws labelled gradations brighter than the interstitial ones", () => {
    mocks.zoomScale = 20;
    const scrollContainer = document.createElement("div");
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as never,
    );
    render(<TimelineRuler scrollContainerRef={{ current: scrollContainer }} />);
    act(() => {
      mocks.resizeCallback?.(
        [{ contentRect: { width: 500 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });

    // The borders are the only other strokes, so what is left is the two
    // gradation passes: interstitial first, then labelled.
    const [interstitial, labelled] = context.strokedWith.filter(
      (color) => color !== "#333",
    );
    expect(brightness(labelled)).toBeGreaterThan(brightness(interstitial) * 2);

    // Every label is painted in the same tone as the mark it names.
    const labelColors = new Set(context.labels.map((label) => label.color));
    expect([...labelColors]).toEqual([labelled]);
  });

  it("scrubs on mouse down and drag using scroll-adjusted pixels", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.scrollLeft = 50;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      canvasContext() as never,
    );
    const setTime = vi
      .spyOn(playbackClock, "setTime")
      .mockImplementation(() => undefined);
    const { container } = render(
      <TimelineRuler scrollContainerRef={{ current: scrollContainer }} />,
    );
    act(() => {
      mocks.resizeCallback?.(
        [{ contentRect: { width: 500 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    const canvas = container.querySelector("canvas")!;
    canvas.getBoundingClientRect = () =>
      ({ left: 10 }) as DOMRect;

    fireEvent.mouseDown(canvas, { clientX: 200 });
    fireEvent.mouseMove(window, { clientX: 300 });
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 400 });

    expect(mocks.pxToTicks).toHaveBeenNthCalledWith(1, 160);
    expect(mocks.pxToTicks).toHaveBeenNthCalledWith(2, 260);
    expect(mocks.snapTickToFrameGrid).toHaveBeenCalledWith(16000, 24);
    expect(setTime).toHaveBeenNthCalledWith(1, 16007);
    expect(setTime).toHaveBeenNthCalledWith(2, 26007);
    expect(setTime).toHaveBeenCalledTimes(2);
  });

  it("skips drawing when the canvas context is unavailable", () => {
    const scrollContainer = document.createElement("div");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    render(<TimelineRuler scrollContainerRef={{ current: scrollContainer }} />);
    act(() => {
      mocks.resizeCallback?.(
        [{ contentRect: { width: 500 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
});
