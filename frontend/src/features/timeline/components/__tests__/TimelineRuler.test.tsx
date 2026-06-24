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

vi.mock("../../../project/useProjectStore", () => ({
  useProjectStore: {
    getState: () => ({ config: { fps: 24 } }),
  },
}));

vi.mock("../../../../core/time/frameGrid", () => ({
  snapTickToFrameGrid: mocks.snapTickToFrameGrid,
}));

function canvasContext() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "",
  };
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
      expect.stringMatching(/\d+s/),
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
