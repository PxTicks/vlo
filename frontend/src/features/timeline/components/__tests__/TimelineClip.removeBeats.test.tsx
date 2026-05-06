import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TimelineClipItem } from "../TimelineClip";
import { useTimelineStore } from "../../useTimelineStore";
import { useInteractionStore } from "../../hooks/useInteractionStore";
import type {
  StandardTimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import type { MarkersComponent } from "../../../../types/Components";
import { PIXELS_PER_SECOND, TICKS_PER_SECOND } from "../../constants";

const extractionState = vi.hoisted(() => ({
  mockUseAsset: vi.fn(),
  mockExtractTimelineClipAudioAsset: vi.fn(),
  mockRevealAssetInBrowser: vi.fn(),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
    transform: null,
  }),
}));

vi.mock("../ThumbnailCanvas", () => ({
  ThumbnailCanvas: () => <div data-testid="thumbnail-canvas" />,
}));

vi.mock("../../hooks/useTimelineViewStore", () => ({
  useTimelineViewStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        zoomScale: 1,
        ticksToPx: (ticks: number) =>
          (ticks / TICKS_PER_SECOND) * PIXELS_PER_SECOND,
        pxToTicks: (pixels: number) =>
          Math.round((pixels / PIXELS_PER_SECOND) * TICKS_PER_SECOND),
        setZoomScale: vi.fn(),
        setScrollContainer: vi.fn(),
        scrollContainer: null,
      }),
    {
      getState: () => ({
        zoomScale: 1,
        ticksToPx: (ticks: number) =>
          (ticks / TICKS_PER_SECOND) * PIXELS_PER_SECOND,
        pxToTicks: (pixels: number) =>
          Math.round((pixels / PIXELS_PER_SECOND) * TICKS_PER_SECOND),
        setZoomScale: vi.fn(),
        setScrollContainer: vi.fn(),
        scrollContainer: null,
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
  ),
}));

vi.mock("../../../userAssets/publicApi", () => ({
  useAsset: extractionState.mockUseAsset,
}));

vi.mock("../../utils/clipAudioExtraction", () => ({
  extractTimelineClipAudioAsset: extractionState.mockExtractTimelineClipAudioAsset,
}));

vi.mock("../../../userAssets/useAssetBrowserRevealStore", () => ({
  revealAssetInBrowser: extractionState.mockRevealAssetInBrowser,
}));

const baseClip: StandardTimelineClip = {
  id: "clip_1",
  trackId: "track_1",
  start: 0,
  timelineDuration: TICKS_PER_SECOND,
  type: "audio",
  name: "Test Audio",
  assetId: "asset-1",
  transformations: [],
  offset: 0,
  sourceDuration: TICKS_PER_SECOND,
  transformedDuration: TICKS_PER_SECOND,
  transformedOffset: 0,
  croppedSourceDuration: TICKS_PER_SECOND,
};

const track: TimelineTrack = {
  id: "track_1",
  type: "audio",
  label: "Audio",
  isVisible: true,
  isMuted: false,
  isLocked: false,
};

function seedStore(clip: StandardTimelineClip) {
  useTimelineStore.setState({
    clips: [clip],
    tracks: [track],
    selectedClipIds: [],
  });
}

describe("TimelineClip Remove Beats menu", () => {
  beforeEach(() => {
    extractionState.mockUseAsset.mockReset();
    extractionState.mockUseAsset.mockReturnValue({
      id: "asset-1",
      hasAudio: true,
    });
    extractionState.mockExtractTimelineClipAudioAsset.mockReset();
    extractionState.mockRevealAssetInBrowser.mockReset();
    useInteractionStore.setState({ activeId: null, operation: null });

    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = vi.fn();
    }
  });

  it("does not show 'Remove Beats' when the clip has no markers", () => {
    seedStore(baseClip);
    render(<TimelineClipItem clip={baseClip} isOverlay={false} />);

    fireEvent.contextMenu(screen.getByTestId("timeline-clip"));

    expect(
      screen.queryByRole("menuitem", { name: "Remove Beats" }),
    ).not.toBeInTheDocument();
  });

  it("does not show 'Remove Beats' when only plain (non-beat) markers exist", () => {
    const markers: MarkersComponent = {
      id: "markers-1",
      type: "markers",
      parameters: {
        markers: [{ id: "m1", sourceTimeTicks: 1000 }],
      },
    };
    const clip = { ...baseClip, components: [markers] };
    seedStore(clip);
    render(<TimelineClipItem clip={clip} isOverlay={false} />);

    fireEvent.contextMenu(screen.getByTestId("timeline-clip"));

    expect(
      screen.queryByRole("menuitem", { name: "Remove Beats" }),
    ).not.toBeInTheDocument();
  });

  it("removes only beat-kind markers and preserves user-added markers", () => {
    const markers: MarkersComponent = {
      id: "markers-1",
      type: "markers",
      parameters: {
        markers: [
          { id: "user-1", sourceTimeTicks: 0 },
          { id: "beat-1", sourceTimeTicks: 1000, kind: "beat" },
          { id: "downbeat-1", sourceTimeTicks: 2000, kind: "downbeat" },
          { id: "user-2", sourceTimeTicks: 3000, name: "chorus" },
        ],
      },
    };
    const clip = { ...baseClip, components: [markers] };
    seedStore(clip);

    render(<TimelineClipItem clip={clip} isOverlay={false} />);

    fireEvent.contextMenu(screen.getByTestId("timeline-clip"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove Beats" }));

    const updatedClip = useTimelineStore
      .getState()
      .clips.find((c) => c.id === clip.id) as StandardTimelineClip;
    const updatedMarkers = (updatedClip.components ?? []).find(
      (component): component is MarkersComponent =>
        component.type === "markers",
    );
    expect(updatedMarkers).toBeDefined();
    expect(updatedMarkers?.parameters.markers.map((m) => m.id)).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  it("removes the markers component entirely when only beats remain", () => {
    const markers: MarkersComponent = {
      id: "markers-1",
      type: "markers",
      parameters: {
        markers: [
          { id: "beat-1", sourceTimeTicks: 1000, kind: "beat" },
          { id: "beat-2", sourceTimeTicks: 2000, kind: "downbeat" },
        ],
      },
    };
    const clip = { ...baseClip, components: [markers] };
    seedStore(clip);

    render(<TimelineClipItem clip={clip} isOverlay={false} />);

    fireEvent.contextMenu(screen.getByTestId("timeline-clip"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove Beats" }));

    const updatedClip = useTimelineStore
      .getState()
      .clips.find((c) => c.id === clip.id) as StandardTimelineClip;
    expect(updatedClip.components ?? []).toEqual([]);
  });
});
