import { describe, expect, it } from "vitest";
import { getDragEndClickAction, getDragStartSelectionAction } from "../../../utils/selection";
import { getGhostClipPosition, snapToCursorOffset } from "../dragGeometry";
import { getEdgeSnapCandidate, getMoveSnapCandidate } from "../snapUtils";

const ticksToPx = (ticks: number) => ticks / 10;

describe("timeline drag snapping and selection", () => {
  it("positions ghost clips with defaults and overrides", () => {
    expect(getGhostClipPosition(100, 80)).toEqual({ x: 40, y: 55 });
    expect(getGhostClipPosition(100, 80, 20, 5)).toEqual({ x: 95, y: 70 });
  });

  it("leaves transforms unchanged without usable pointer geometry", () => {
    const transform = { x: 3, y: 4, scaleX: 1, scaleY: 1 };
    const rect = { left: 10, top: 20 } as DOMRect;
    expect(
      snapToCursorOffset({
        activatorEvent: null,
        draggingNodeRect: rect,
        overlayNodeRect: rect,
        transform,
        active: {} as never,
        over: null,
        activeNodeRect: null,
        containerNodeRect: null,
        scrollableAncestorRects: [],
        scrollableAncestors: [],
        windowRect: null,
      }),
    ).toBe(transform);
    expect(
      snapToCursorOffset({
        activatorEvent: new Event("keyboard"),
        draggingNodeRect: rect,
        overlayNodeRect: rect,
        transform,
        active: {} as never,
        over: null,
        activeNodeRect: null,
        containerNodeRect: null,
        scrollableAncestorRects: [],
        scrollableAncestors: [],
        windowRect: null,
      }),
    ).toBe(transform);
  });

  it("snaps mouse and touch overlays to the shared ghost offset", () => {
    const common = {
      draggingNodeRect: { left: 20, top: 30 } as DOMRect,
      overlayNodeRect: { left: 0, top: 0 } as DOMRect,
      transform: { x: 10, y: 15, scaleX: 1, scaleY: 1 },
      active: {} as never,
      over: null,
      activeNodeRect: null,
      containerNodeRect: null,
      scrollableAncestorRects: [],
      scrollableAncestors: [],
      windowRect: null,
    };
    expect(
      snapToCursorOffset({
        ...common,
        activatorEvent: { clientX: 100, clientY: 80 } as MouseEvent,
      }),
    ).toMatchObject({ x: 30, y: 40 });
    expect(
      snapToCursorOffset({
        ...common,
        activatorEvent: {
          touches: [{ clientX: 100, clientY: 80 }],
        } as unknown as TouchEvent,
      }),
    ).toMatchObject({ x: 30, y: 40 });
  });

  it("chooses the closest start or end move snap within the threshold", () => {
    expect(getMoveSnapCandidate(100, 50, [], ticksToPx, 2)).toBeNull();
    expect(getMoveSnapCandidate(100, 50, [70], ticksToPx, 2)).toBeNull();
    expect(getMoveSnapCandidate(100, 50, [90, 152], ticksToPx, 2)).toEqual({
      snapTick: 152,
      snappedStartTicks: 102,
      distancePx: 0.2,
    });
    expect(getMoveSnapCandidate(100, 50, [99, 151], ticksToPx, 2)).toEqual({
      snapTick: 99,
      snappedStartTicks: 99,
      distancePx: 0.1,
    });
  });

  it("chooses the closest edge snap and rejects distant candidates", () => {
    expect(getEdgeSnapCandidate(100, [], ticksToPx, 2)).toBeNull();
    expect(getEdgeSnapCandidate(100, [70], ticksToPx, 2)).toBeNull();
    expect(getEdgeSnapCandidate(100, [85, 99, 101], ticksToPx, 2)).toEqual({
      snapTick: 99,
      distancePx: 0.1,
    });
  });

  it("resolves selection actions for click, toggle, and drag paths", () => {
    expect(getDragStartSelectionAction("a", false, false)).toEqual({
      type: "SELECT_SINGLE",
      id: "a",
    });
    expect(getDragStartSelectionAction("a", false, true)).toEqual({
      type: "TOGGLE",
      id: "a",
    });
    expect(getDragStartSelectionAction("a", true, true)).toEqual({
      type: "TOGGLE",
      id: "a",
    });
    expect(getDragStartSelectionAction("a", true, false)).toEqual({
      type: "NONE",
    });
    expect(getDragEndClickAction("a", true, false, true)).toEqual({
      type: "NONE",
    });
    expect(getDragEndClickAction("a", false, false, true)).toEqual({
      type: "SELECT_SINGLE",
      id: "a",
    });
    expect(getDragEndClickAction("a", false, true, true)).toEqual({
      type: "NONE",
    });
    expect(getDragEndClickAction("a", false, false, false)).toEqual({
      type: "NONE",
    });
  });
});
