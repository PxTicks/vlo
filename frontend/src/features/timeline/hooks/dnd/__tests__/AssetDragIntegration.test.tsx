import {
  render,
  fireEvent,
  screen,
  act,
  waitFor,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DndContext,
  MouseSensor,
  useSensor,
  useSensors,
  pointerWithin,
} from "@dnd-kit/core";
import { AssetCard } from "../../../../userAssets";
import { useAssetDrag } from "../useAssetDrag";
import { useInteractionStore } from "../../useInteractionStore";
import { useTimelineStore } from "../../../useTimelineStore";
import type { Asset } from "../../../../../types/Asset";
import { TRACK_HEIGHT, RULER_HEIGHT } from "../../../constants";

// --- MOCKS ---

vi.mock("../utils/collision", () => ({
  resolveCollision: (_id: string, start: number) => start,
  hasAnyCollision: () => false,
  getResizeConstraints: () => ({ min: 0, max: 1000 }),
}));

// Mock Geometry: Ghost Height 50px is critical for the math below
vi.mock("../dragGeometry", () => ({
  getGhostClipPosition: (x: number, y: number) => ({ x, y }),
  GHOST_CLIP_HEIGHT: 50,
  snapToCursorOffset: () => ({}),
}));

vi.mock("../utils/clipFactory", () => ({
  createClipFromAsset: (asset: Asset) => ({
    id: `mock_clip_${asset.id}`,
    sourceId: asset.id,
    timelineDuration: 100,
    start: 0,
    type: asset.type,
    name: asset.name,
  }),
}));

vi.mock("../hooks/dnd/useClipResize", () => ({
  useClipResize: () => ({ handleEnd: vi.fn() }),
}));

vi.mock("../utils/selection", () => ({
  getDragStartSelectionAction: () => ({ type: "SELECT_SINGLE", id: "mock_id" }),
  getDragEndClickAction: () => ({ type: "SELECT_SINGLE", id: "mock_id" }),
}));

vi.mock("../hooks/useTimelineViewStore", () => {
  const mockState = {
    ticksToPx: (t: number) => t,
    pxToTicks: (p: number) => p,
  };
  return {
    useTimelineViewStore: Object.assign(() => mockState, {
      getState: () => mockState,
    }),
  };
});

vi.mock("../utils/formatting", () => ({
  getTrackTypeFromClipType: (type: string) => type,
  getTrackColor: () => "#000",
}));

// --- TEST COMPONENT ---

const TestDragApp = ({
  asset,
  forceNoCollision = false,
}: {
  asset?: Asset;
  forceNoCollision?: boolean;
}) => {
  const {
    handleAssetDragStart,
    handleAssetDragMove,
    handleAssetDragEnd,
    scrollContainerRef,
    insertGapIndex,
  } = useAssetDrag();

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 0 } }),
  );

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleAssetDragStart}
      onDragMove={handleAssetDragMove}
      onDragEnd={handleAssetDragEnd}
      collisionDetection={forceNoCollision ? () => [] : pointerWithin}
    >
      <div style={{ padding: 0 }}>
        {asset && <AssetCard asset={asset} />}

        {/* Helper for assertions */}
        <div data-testid="gap-index-indicator">
          {insertGapIndex === null ? "null" : insertGapIndex}
        </div>

        <div
          ref={scrollContainerRef}
          data-testid="timeline-container"
          style={{ position: "relative", height: 500, overflow: "auto" }}
        >
          {/* Ruler Visually Represented */}
          <div
            style={{ height: RULER_HEIGHT, width: "100%", background: "red" }}
          />

          {/* Tracks (1 is sufficient for this test) */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ height: TRACK_HEIGHT, width: 500 }}>Track 0</div>
          </div>
        </div>
      </div>
    </DndContext>
  );
};

// --- TESTS ---

describe("Asset Drag Integration", () => {
  const mockAsset: Asset = {
    id: "asset_1",
    name: "Test Video",
    type: "video",
    src: "video.mp4",
    duration: 10,
    createdAt: Date.now(),
    hash: "abc",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useInteractionStore.setState({ activeClip: null, operation: null });
    useTimelineStore.setState({
      clips: [],
      tracks: [
        {
          id: "track-0",
          label: "Track 0",
          isVisible: true,
          isLocked: false,
          isMuted: false,
        },
      ],
      selectedClipIds: [],
    });
  });

  const mockRect = (element: HTMLElement, rect: Partial<DOMRect>) => {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      x: rect.left ?? 0,
      y: rect.top ?? 0,
      width: rect.width ?? 0,
      height: rect.height ?? 0,
      top: rect.top ?? 0,
      left: rect.left ?? 0,
      right: (rect.left ?? 0) + (rect.width ?? 0),
      bottom: (rect.top ?? 0) + (rect.height ?? 0),
      toJSON: () => {},
    } as DOMRect);
  };

  it("REGRESSION: Correctly ignores Ruler height when calculating gap index via fallback coordinates", async () => {
    // 1. Force fallback logic so we rely on manual coordinate math (where the bug lived)
    render(<TestDragApp asset={mockAsset} forceNoCollision={true} />);

    const card = screen.getByText("Test Video");
    const container = screen.getByTestId("timeline-container");
    const gapDisplay = screen.getByTestId("gap-index-indicator");

    mockRect(container, { left: 0, top: 0, width: 800, height: 600 });
    mockRect(card, { left: 100, top: 100, width: 200, height: 100 });

    // 2. Start Drag
    await act(async () => {
      fireEvent.mouseDown(card, { clientX: 150, clientY: 150, buttons: 1 });
      fireEvent.pointerMove(window, { clientX: 155, clientY: 155, buttons: 1 });
      fireEvent.mouseMove(document, { clientX: 155, clientY: 155, buttons: 1 });
    });

    // 3. Move Cursor to Y = 30 (Relative to container)
    //
    // GEOMETRY BREAKDOWN:
    // Cursor Y: 30px
    // Ghost Height: 50px
    // Ghost Center: 30 + (50/2) = 55px (Absolute from Container Top)
    //
    // WITHOUT FIX (Buggy):
    // The code ignores Ruler Height (24px).
    // It thinks Track 0 is at 0px - 60px.
    // Center (55px) is 5px away from Bottom (60px).
    // 5px < Threshold (~21px).
    // RESULT: GAP DETECTED (Index 1).
    //
    // WITH FIX (Correct):
    // The code accounts for Ruler Height (24px).
    // It knows Track 0 is at 24px - 84px.
    // Center (55px) is 29px away from Bottom (84px).
    // 29px > Threshold (~21px).
    // RESULT: NO GAP (null) -> Drop ON the track.

    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 400, clientY: 30, buttons: 1 });
      fireEvent.mouseMove(document, { clientX: 400, clientY: 30, buttons: 1 });
    });

    await waitFor(() => {
      expect(gapDisplay.textContent).toBe("null");
    });
  }, 15000);
});
