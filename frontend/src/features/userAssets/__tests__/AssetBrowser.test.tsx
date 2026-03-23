import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AssetBrowser } from "../AssetBrowser";
import { useAssetStore } from "../useAssetStore";
import type { Asset } from "../../../types/Asset";

// Mock the Zustand store hook
vi.mock("../useAssetStore");

describe("AssetBrowser Component", () => {
  const mockAddLocalAssets = vi.fn();

  const mockAssets: Asset[] = [
    {
      id: "1",
      type: "video",
      name: "vacation.mp4",
      src: "vid.mp4",
      hash: "1",
      createdAt: 0,
      favourite: true,
    },
    {
      id: "1b",
      type: "video",
      name: "b-roll.mp4",
      src: "b-roll.mp4",
      hash: "1b",
      createdAt: 2,
      favourite: false,
    },
    {
      id: "mask-video",
      type: "video",
      name: "vacation_sam2_mask.webm",
      src: "mask.webm",
      hash: "mask-hash",
      createdAt: 0,
      creationMetadata: {
        source: "sam2_mask",
        parentAssetId: "1",
        parentClipId: "clip-1",
        maskClipId: "clip-1::mask::mask-1",
        pointCount: 3,
        sourceHash: "source-hash",
      },
    },
    {
      id: "2",
      type: "image",
      name: "thumbnail.jpg",
      src: "img.jpg",
      hash: "2",
      createdAt: 0,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockAddLocalAssets.mockReset();
    mockAddLocalAssets.mockResolvedValue([]);
  });

  const mockStore = (state: Partial<ReturnType<typeof useAssetStore>> = {}) => {
    const defaultState = {
      assets: [],
      uploadAsset: vi.fn(),
      isUploading: false,
      uploadingCount: 0,
      isLoading: false,
      inputCache: new Map(),
      fetchAssets: vi.fn(),
      getInput: vi.fn(),
      addLocalAsset: vi.fn(),
      addLocalAssets: mockAddLocalAssets,
      updateAsset: vi.fn(),
      scanForNewAssets: vi.fn(),
      _ingestAsset: vi.fn(),
      isScanning: false,
      deleteAsset: vi.fn(),
    };
    const mergedState = { ...defaultState, ...state };
    vi.mocked(useAssetStore).mockImplementation((selector) =>
      selector(mergedState),
    );
  };

  it("renders empty state correctly", () => {
    // Mock empty store
    mockStore({ assets: [] });

    render(<AssetBrowser />);

    // Check for upload button
    expect(
      screen.getByRole("button", { name: /Import Asset/i }),
    ).toBeInTheDocument();
    // Check for empty message (default tab is video)
    expect(screen.getByText(/No video assets/i)).toBeInTheDocument();
  });

  it("displays assets and filters them by active tab", () => {
    // Mock populated store
    mockStore({ assets: mockAssets });

    render(<AssetBrowser />);

    // 1. Initial State: Video Tab
    expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
    expect(
      screen.queryByText("vacation_sam2_mask.webm"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("thumbnail.jpg")).not.toBeInTheDocument();

    // 2. Switch to Image Tab
    const imageTab = screen.getByLabelText("Images");
    fireEvent.click(imageTab);

    // 3. Verify Filtering
    expect(screen.getByText("thumbnail.jpg")).toBeInTheDocument();
    expect(screen.queryByText("vacation.mp4")).not.toBeInTheDocument();
  });

  it("hides SAM2 mask assets from the video tab", () => {
    mockStore({
      assets: mockAssets.filter(
        (asset) =>
          asset.type === "video" &&
          asset.creationMetadata?.source === "sam2_mask",
      ),
    });

    render(<AssetBrowser />);

    expect(screen.getByText(/No video assets/i)).toBeInTheDocument();
    expect(
      screen.queryByText("vacation_sam2_mask.webm"),
    ).not.toBeInTheDocument();
  });

  it("triggers upload when files are selected", () => {
    mockStore({ assets: [] });

    render(<AssetBrowser />);

    // Simulate file input
    const input = screen.getByTestId("hidden-file-input") as HTMLInputElement;
    const file = new File(["dummy"], "video.mp4", { type: "video/mp4" });

    // Fire change event
    fireEvent.change(input, { target: { files: [file] } });

    expect(mockAddLocalAssets).toHaveBeenCalledWith([file], {
      source: "uploaded",
    });
  });

  it("accepts dropped files for upload", () => {
    mockStore({ assets: [] });

    render(<AssetBrowser />);

    const assetBrowser = screen.getByTestId("asset-browser");
    const file = new File(["dummy"], "song.mp3", { type: "audio/mpeg" });

    fireEvent.drop(assetBrowser, {
      dataTransfer: {
        files: [file],
        types: ["Files"],
      },
    });

    expect(mockAddLocalAssets).toHaveBeenCalledWith([file], {
      source: "uploaded",
    });
  });

  it("switches tabs to the uploaded asset type", async () => {
    mockAddLocalAssets.mockResolvedValue([
      {
        id: "3",
        type: "image",
        name: "poster.png",
        src: "poster.png",
        hash: "3",
        createdAt: 1,
      } satisfies Asset,
    ]);
    mockStore({ assets: [] });

    render(<AssetBrowser />);

    const input = screen.getByTestId("hidden-file-input") as HTMLInputElement;
    const file = new File(["dummy"], "poster.png", { type: "image/png" });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByLabelText("Images")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  it("prefers video, then image, then audio when multiple types upload", async () => {
    mockAddLocalAssets.mockResolvedValue([
      {
        id: "4",
        type: "image",
        name: "frame.png",
        src: "frame.png",
        hash: "4",
        createdAt: 1,
      } satisfies Asset,
      {
        id: "5",
        type: "video",
        name: "clip.mp4",
        src: "clip.mp4",
        hash: "5",
        createdAt: 2,
      } satisfies Asset,
    ]);
    mockStore({ assets: [] });

    render(<AssetBrowser />);

    fireEvent.click(screen.getByLabelText("Audio"));

    const input = screen.getByTestId("hidden-file-input") as HTMLInputElement;
    const imageFile = new File(["img"], "frame.png", { type: "image/png" });
    const videoFile = new File(["vid"], "clip.mp4", { type: "video/mp4" });

    fireEvent.change(input, { target: { files: [imageFile, videoFile] } });

    await waitFor(() => {
      expect(screen.getByLabelText("Videos")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  it("shows loading state on button", () => {
    mockStore({ isUploading: true });

    render(<AssetBrowser />);

    expect(
      screen.getByTestId("asset-browser-upload-overlay"),
    ).toBeInTheDocument();
    expect(screen.getByText("Importing assets...")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Import Asset/i }),
    ).toBeDisabled();
  });

  it("filters the current tab to favourite assets when the toolbar heart is enabled", () => {
    mockStore({ assets: mockAssets });

    render(<AssetBrowser />);

    expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
    expect(screen.getByText("b-roll.mp4")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Show favourite assets" }),
    );

    expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
    expect(screen.queryByText("b-roll.mp4")).not.toBeInTheDocument();
  });
});
