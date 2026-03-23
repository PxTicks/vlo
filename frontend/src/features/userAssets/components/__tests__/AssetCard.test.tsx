import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import { AssetCard } from "../AssetCard";
import { useAssetStore } from "../../useAssetStore";

const mocks = vi.hoisted(() => ({
  mockDeleteAsset: vi.fn(),
  mockInsertAssetAtTime: vi.fn(),
  mockLoadWorkflowFromAssetMetadata: vi.fn(),
  timelineClipCount: 0,
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
}));

vi.mock("../../../timeline", () => {
  return {
    createClipFromAsset: (asset: Asset) => ({
      id: `clip-${asset.id}`,
      type: asset.type,
      timelineDuration: 1,
    }),
    insertAssetAtTime: mocks.mockInsertAssetAtTime,
    useTimelineClipCountForAsset: () => mocks.timelineClipCount,
  };
});

vi.mock("../../../generation/useGenerationStore", () => ({
  useGenerationStore: {
    getState: () => ({
      loadWorkflowFromAssetMetadata: mocks.mockLoadWorkflowFromAssetMetadata,
    }),
  },
}));

vi.mock("../../useAssetStore");

const mockAsset: Asset = {
  id: "asset-1",
  name: "clip.mp4",
  src: "clip.mp4",
  type: "video",
  hash: "hash-1",
  createdAt: 1000,
  duration: 12,
};

const mockTimelineSelection = {
  start: 240,
  end: 480,
  clips: [],
};

const extractedAsset: Asset = {
  ...mockAsset,
  id: "asset-extracted",
  creationMetadata: {
    source: "extracted",
    timelineSelection: mockTimelineSelection,
  },
};

const generatedFromSelectionAsset: Asset = {
  ...mockAsset,
  id: "asset-generated",
  creationMetadata: {
    source: "generated",
    workflowName: "Workflow",
    inputs: [
      {
        nodeId: "node-1",
        kind: "timelineSelection",
        timelineSelection: mockTimelineSelection,
      },
    ],
  },
};

const generatedWithWorkflowMetadataAsset: Asset = {
  ...mockAsset,
  id: "asset-generated-metadata",
  creationMetadata: {
    source: "generated",
    workflowName: "Workflow",
    inputs: [],
    comfyuiPrompt: {
      "1": {
        class_type: "LoadVideo",
        inputs: { file: "clip.mp4" },
      },
    },
  },
};

type AssetStoreState = ReturnType<typeof useAssetStore.getState>;

function mockStores(timelineClipCount: number) {
  mocks.timelineClipCount = timelineClipCount;
  vi.mocked(useAssetStore).mockImplementation((selector: (state: AssetStoreState) => unknown) =>
    selector({
      deleteAsset: mocks.mockDeleteAsset,
    } as unknown as AssetStoreState),
  );
}

describe("AssetCard actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockDeleteAsset.mockReset();
    mocks.mockInsertAssetAtTime.mockReset();
    mocks.mockLoadWorkflowFromAssetMetadata.mockReset();
    mocks.mockLoadWorkflowFromAssetMetadata.mockResolvedValue(undefined);
    mocks.timelineClipCount = 0;
  });

  it("warns when timeline clips derived from the asset will be deleted", () => {
    mockStores(2);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<AssetCard asset={mockAsset} />);

    fireEvent.click(screen.getByLabelText("Asset actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(confirmSpy).toHaveBeenCalledWith(
      "Are you sure you want to delete this asset? This will remove it from disk permanently.\n\nThis asset is used by clips on the Timeline.\nClips on the Timeline are derived from the asset and will be deleted.",
    );
    expect(mocks.mockDeleteAsset).toHaveBeenCalledWith(mockAsset.id);
  });

  it("uses the standard delete message when the asset is not on the timeline", () => {
    mockStores(0);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<AssetCard asset={mockAsset} />);

    fireEvent.click(screen.getByLabelText("Asset actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(confirmSpy).toHaveBeenCalledWith(
      "Are you sure you want to delete this asset? This will remove it from disk permanently.",
    );
    expect(mocks.mockDeleteAsset).not.toHaveBeenCalled();
  });

  it("shows send to timeline for extracted assets and inserts at selection start", () => {
    mockStores(0);

    render(<AssetCard asset={extractedAsset} />);

    fireEvent.click(screen.getByLabelText("Asset actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send to Timeline" }));

    expect(mocks.mockInsertAssetAtTime).toHaveBeenCalledWith(
      extractedAsset,
      mockTimelineSelection.start,
    );
  });

  it("shows send to timeline for assets generated from a timeline selection", () => {
    mockStores(0);

    render(<AssetCard asset={generatedFromSelectionAsset} />);

    fireEvent.click(screen.getByLabelText("Asset actions"));

    expect(
      screen.getByRole("menuitem", { name: "Send to Timeline" }),
    ).toBeInTheDocument();
  });

  it("shows regenerate for generated assets with saved workflow metadata", () => {
    mockStores(0);

    render(<AssetCard asset={generatedWithWorkflowMetadataAsset} />);

    fireEvent.click(screen.getByLabelText("Asset actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Regenerate" }));

    expect(mocks.mockLoadWorkflowFromAssetMetadata).toHaveBeenCalledWith(
      generatedWithWorkflowMetadataAsset,
    );
  });

  it("does not show send to timeline when no selection metadata exists", () => {
    mockStores(0);

    render(<AssetCard asset={mockAsset} />);

    fireEvent.click(screen.getByLabelText("Asset actions"));

    expect(
      screen.queryByRole("menuitem", { name: "Send to Timeline" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Regenerate" }),
    ).not.toBeInTheDocument();
  });

  it("opens a video preview modal from the play button and closes with the x button", async () => {
    mockStores(0);

    render(<AssetCard asset={mockAsset} />);

    fireEvent.click(screen.getByRole("button", { name: "Preview video" }));

    expect(screen.getByRole("dialog", { name: mockAsset.name })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: mockAsset.name }),
      ).not.toBeInTheDocument();
    });
  });

  it("closes the video preview modal on escape", async () => {
    mockStores(0);

    render(<AssetCard asset={mockAsset} />);

    fireEvent.click(screen.getByRole("button", { name: "Preview video" }));

    fireEvent.keyDown(screen.getByRole("dialog", { name: mockAsset.name }), {
      key: "Escape",
      code: "Escape",
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: mockAsset.name }),
      ).not.toBeInTheDocument();
    });
  });

  it("closes the video preview modal when the window blurs", async () => {
    mockStores(0);

    render(<AssetCard asset={mockAsset} />);

    fireEvent.click(screen.getByRole("button", { name: "Preview video" }));
    fireEvent(window, new Event("blur"));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: mockAsset.name }),
      ).not.toBeInTheDocument();
    });
  });
});
