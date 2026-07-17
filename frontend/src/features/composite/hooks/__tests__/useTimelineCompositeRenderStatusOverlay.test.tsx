import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompositeAsset,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import { useTimelineCompositeRenderStatusOverlay } from "../useTimelineCompositeRenderStatusOverlay";
import { useCompositeLibraryStore } from "../../useCompositeLibraryStore";
import { useCompositeRenderStatusStore } from "../../useCompositeRenderStatusStore";

const composite: CompositeAsset = {
  id: "composite-1",
  name: "Composite",
  revision: 2,
  content: { clips: [], durationTicks: 100 },
  bake: {
    status: "failed",
    requestedKey: "key-2",
    error: "encoder failed",
  },
  createdAt: 1,
  updatedAt: 2,
};

const clip = {
  id: "placement-1",
  type: "video",
  compositeId: composite.id,
  assetId: `composite-live:${composite.id}`,
  trackId: "track-1",
  start: 0,
  timelineDuration: 100,
} as TimelineClip;

describe("useTimelineCompositeRenderStatusOverlay", () => {
  beforeEach(() => {
    useCompositeRenderStatusStore.setState({
      renderingClipIds: new Set(),
      directRenderErrors: new Map(),
      bakeStatusByCompositeId: new Map(),
      forceLiveCompositeIds: new Set(),
    });
  });

  it("offers retry and force-live controls for a failed placement bake", () => {
    const retryCompositeBake = vi.fn(async () => true);
    useCompositeLibraryStore.setState({
      composites: [composite],
      retryCompositeBake,
    });
    const definition = renderHook(() =>
      useTimelineCompositeRenderStatusOverlay(),
    ).result.current;
    const items = renderHook(() =>
      definition.useItems({ clip, isSelected: false }),
    ).result.current;
    expect(items).toHaveLength(1);
    render(<>{items[0].content}</>);

    expect(screen.getByText("Bake failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry composite bake" }));
    expect(retryCompositeBake).toHaveBeenCalledWith(composite.id);

    fireEvent.click(
      screen.getByRole("button", { name: "Force live composite rendering" }),
    );
    expect(useCompositeRenderStatusStore.getState().forceLiveCompositeIds).toContain(
      composite.id,
    );
  });
});
