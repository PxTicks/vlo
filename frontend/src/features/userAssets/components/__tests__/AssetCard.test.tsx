import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import { AssetCard } from "../AssetCard";
import { useAssetStore } from "../../useAssetStore";
import { useTimelineStore } from "../../../timeline";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
}));

vi.mock("../../useAssetStore");
vi.mock("../../../timeline/useTimelineStore");

const mockDeleteAsset = vi.fn();

const mockAsset: Asset = {
  id: "asset-1",
  name: "clip.mp4",
  src: "clip.mp4",
  type: "video",
  hash: "hash-1",
  createdAt: 1000,
  duration: 12,
};

type AssetStoreState = ReturnType<typeof useAssetStore.getState>;
type TimelineStoreState = ReturnType<typeof useTimelineStore.getState>;

function mockStores(timelineClipCount: number) {
  vi.mocked(useAssetStore).mockImplementation((selector: (state: AssetStoreState) => unknown) =>
    selector({
      deleteAsset: mockDeleteAsset,
    } as unknown as AssetStoreState),
  );

  vi.mocked(useTimelineStore).mockImplementation((selector: (state: TimelineStoreState) => unknown) =>
    selector({
      clips: Array.from({ length: timelineClipCount }, (_, index) => ({
        id: `clip-${index}`,
        assetId: mockAsset.id,
      })),
    } as unknown as TimelineStoreState),
  );
}

describe("AssetCard deletion messaging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteAsset.mockReset();
  });

  it("warns when timeline clips derived from the asset will be deleted", () => {
    mockStores(2);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<AssetCard asset={mockAsset} />);

    fireEvent.click(screen.getByTitle("Delete Asset"));

    expect(confirmSpy).toHaveBeenCalledWith(
      "Are you sure you want to delete this asset? This will remove it from disk permanently.\n\nThis asset is used by clips on the Timeline.\nClips on the Timeline are derived from the asset and will be deleted.",
    );
    expect(mockDeleteAsset).toHaveBeenCalledWith(mockAsset.id);
  });

  it("uses the standard delete message when the asset is not on the timeline", () => {
    mockStores(0);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<AssetCard asset={mockAsset} />);

    fireEvent.click(screen.getByTitle("Delete Asset"));

    expect(confirmSpy).toHaveBeenCalledWith(
      "Are you sure you want to delete this asset? This will remove it from disk permanently.",
    );
    expect(mockDeleteAsset).not.toHaveBeenCalled();
  });
});
