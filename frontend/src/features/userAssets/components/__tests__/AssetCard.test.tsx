import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import { AssetCard } from "../AssetCard";
import { useAssetStore } from "../../useAssetStore";

const mocks = vi.hoisted(() => ({
  mockDeleteAsset: vi.fn(),
  mockUpdateAsset: vi.fn(),
  mockInsertAssetAtTime: vi.fn(),
  mockCreateClipFromAsset: vi.fn(),
  mockLoadWorkflowFromAssetMetadata: vi.fn(),
  mockOpenFamily: vi.fn(),
  mockUseDraggable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  })),
  timelineClipCount: 0,
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: mocks.mockUseDraggable,
}));

vi.mock("../../../timeline", () => {
  return {
    createClipFromAsset: mocks.mockCreateClipFromAsset,
    insertAssetAtTime: mocks.mockInsertAssetAtTime,
    useTimelineClipCountForAsset: () => mocks.timelineClipCount,
    useTimelineStore: {
      getState: () => ({ clips: [] }),
    },
  };
});

vi.mock("../../../generation/publicApi", () => ({
  useGenerationStore: {
    getState: () => ({
      loadWorkflowFromAssetMetadata: mocks.mockLoadWorkflowFromAssetMetadata,
    }),
  },
  canRegenerateFromAssetMetadata: (metadata: Asset["creationMetadata"]) =>
    metadata?.source === "generated" &&
    Boolean(metadata.comfyuiPrompt || metadata.comfyuiWorkflow || metadata.workflowName),
}));

vi.mock("../../useAssetStore");

const mockAsset: Asset = {
  id: "asset-1",
  name: "clip.mp4",
  src: "blob:http://localhost/clip-mp4",
  proxySrc: "proxy-clip.mp4",
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

const generatedWithWorkflowNameOnlyAsset: Asset = {
  ...mockAsset,
  id: "asset-generated-workflow-name-only",
  creationMetadata: {
    source: "generated",
    workflowName: "video_ltx2_3_i2v",
    inputs: [
      {
        nodeId: "node-1",
        kind: "draggedAsset",
        parentAssetId: "source-asset",
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

const generatedFamilyAsset: Asset = {
  ...mockAsset,
  id: "asset-family-generated",
  familyId: "family-1",
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
      updateAsset: mocks.mockUpdateAsset,
      assets: [mockAsset] as Asset[],
    } as unknown as AssetStoreState),
  );
}

describe("AssetCard actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockDeleteAsset.mockReset();
    mocks.mockUpdateAsset.mockReset();
    mocks.mockInsertAssetAtTime.mockReset();
    mocks.mockCreateClipFromAsset.mockReset();
    mocks.mockCreateClipFromAsset.mockImplementation((asset: Asset) => ({
      id: `clip-${asset.id}`,
      type: asset.type,
      timelineDuration: 1,
    }));
    mocks.mockLoadWorkflowFromAssetMetadata.mockReset();
    mocks.mockLoadWorkflowFromAssetMetadata.mockResolvedValue(undefined);
    mocks.mockOpenFamily.mockReset();
    mocks.mockUseDraggable.mockClear();
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

  it("shows regenerate for generated assets with a saved workflow name", () => {
    mockStores(0);

    render(<AssetCard asset={generatedWithWorkflowNameOnlyAsset} />);

    fireEvent.click(screen.getByLabelText("Asset actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Regenerate" }));

    expect(mocks.mockLoadWorkflowFromAssetMetadata).toHaveBeenCalledWith(
      generatedWithWorkflowNameOnlyAsset,
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

  it("keeps the menu actions and adds a folder action for family cards", () => {
    mockStores(0);
    const deleteAllSpy = vi.fn();

    render(
      <AssetCard
        asset={generatedFamilyAsset}
        onDeleteAll={deleteAllSpy}
        onShowFamily={mocks.mockOpenFamily}
      />,
    );

    const menuButton = screen.getByRole("button", { name: "Asset actions" });
    const familyButton = screen.getByRole("button", { name: "Open family" });

    expect(menuButton).toBeInTheDocument();
    expect(familyButton).toBeInTheDocument();

    fireEvent.click(menuButton);

    expect(
      screen.getByRole("menuitem", { name: "Send to Timeline" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Regenerate" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete all" }),
    ).toBeInTheDocument();

    fireEvent.click(familyButton);

    expect(mocks.mockOpenFamily).toHaveBeenCalledWith("family-1");

    fireEvent.click(menuButton);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete all" }));

    expect(deleteAllSpy).toHaveBeenCalledWith("family-1");
  });

  it("requests a preview when the video play button is clicked", () => {
    mockStores(0);
    const onRequestPreview = vi.fn();

    render(<AssetCard asset={mockAsset} onRequestPreview={onRequestPreview} />);

    fireEvent.click(screen.getByRole("button", { name: "Preview video" }));

    expect(onRequestPreview).toHaveBeenCalledWith(mockAsset.id);
  });

  it("toggles the favourite flag from the heart button", () => {
    mockStores(0);

    render(<AssetCard asset={mockAsset} />);

    fireEvent.click(screen.getByRole("button", { name: "Add to favourites" }));

    expect(mocks.mockUpdateAsset).toHaveBeenCalledWith(mockAsset.id, {
      favourite: true,
    });
  });

  it("disables dragging when multiselect mode turns drag off", () => {
    mockStores(0);

    render(<AssetCard asset={mockAsset} disableDrag />);

    expect(mocks.mockUseDraggable).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `asset_${mockAsset.id}`,
        disabled: true,
      }),
    );
    expect(screen.getByTestId("asset-card")).toHaveAttribute(
      "data-drag-disabled",
      "true",
    );
  });

  it("passes a clip payload through dnd data", () => {
    mockStores(0);

    render(<AssetCard asset={mockAsset} />);

    expect(mocks.mockUseDraggable).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `asset_${mockAsset.id}`,
        data: expect.objectContaining({
          type: "asset",
          asset: mockAsset,
          clip: expect.objectContaining({
            id: `clip-${mockAsset.id}`,
          }),
        }),
      }),
    );
  });
});
