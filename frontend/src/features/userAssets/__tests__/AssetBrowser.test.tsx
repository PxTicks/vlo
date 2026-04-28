import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AssetBrowser } from "../AssetBrowser";
import { useAssetStore } from "../useAssetStore";
import type { Asset, AssetFamily } from "../../../types/Asset";
import type { BaseClip, TimelineClip } from "../../../types/TimelineTypes";
import { useInteractionStore } from "../../timeline/hooks/useInteractionStore";
import { useTimelineStore } from "../../timeline";
import { useProjectStore } from "../../project";
import {
  revealAssetInBrowser,
  useAssetBrowserRevealStore,
} from "../useAssetBrowserRevealStore";
import { useAssetBrowserSelectionStore } from "../useAssetBrowserSelectionStore";

// Mock the Zustand store hook
vi.mock("../useAssetStore");

describe("AssetBrowser Component", () => {
  const mockAddLocalAssets = vi.fn();
  const mockDeleteAsset = vi.fn();
  const externalAssetDragClip: BaseClip = {
    id: "dragged-asset",
    type: "video",
    name: "Dragged asset",
    sourceDuration: null,
    transformedDuration: 100,
    transformedOffset: 0,
    timelineDuration: 100,
    croppedSourceDuration: 100,
    offset: 0,
    transformations: [],
  };

  const mockAssets: Asset[] = [
    {
      id: "1",
      type: "video",
      name: "vacation.mp4",
      src: "vid.mp4",
      hash: "1",
      familyId: "family-1",
      duration: 5,
      fps: 24,
      createdAt: 0,
      favourite: true,
    },
    {
      id: "1b",
      type: "video",
      name: "b-roll.mp4",
      src: "b-roll.mp4",
      hash: "1b",
      familyId: "family-1",
      duration: 5,
      fps: 24,
      createdAt: 2,
      favourite: false,
    },
    {
      id: "solo-video",
      type: "video",
      name: "solo.mp4",
      src: "solo.mp4",
      hash: "solo",
      familyId: "family-2",
      duration: 5,
      fps: 24,
      createdAt: 1,
      favourite: false,
    },
    {
      id: "mask-video",
      type: "video",
      name: "vacation_sam2_mask.mp4",
      src: "mask.mp4",
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

  const mockFamilies: AssetFamily[] = [
    {
      id: "family-1",
      representativeAssetId: "1",
      autoMatchKeys: ["generation-family:v1:test"],
      compatibility: {
        assetType: "video",
        durationMs: 5000,
        fpsMilli: 24000,
      },
      createdAt: 1,
      updatedAt: 2,
    },
    {
      id: "family-2",
      representativeAssetId: "solo-video",
      autoMatchKeys: ["generation-family:v1:solo"],
      compatibility: {
        assetType: "video",
        durationMs: 5000,
        fpsMilli: 24000,
      },
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockAddLocalAssets.mockReset();
    mockAddLocalAssets.mockResolvedValue({
      assets: [],
      skippedExistingFiles: 0,
    });
    mockDeleteAsset.mockReset();
    useInteractionStore.getState().stopDrag();
    useAssetBrowserRevealStore.setState({ revealRequest: null });
    useAssetBrowserSelectionStore.setState({ selectedAssetIds: [] });
    useProjectStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        assetBrowserDisplay: "grouped",
      },
    }));
    useTimelineStore.setState({
      tracks: [
        {
          id: "track-1",
          label: "Track 1",
          isVisible: true,
          isLocked: false,
          isMuted: false,
        },
      ],
      clips: [],
      selectedClipIds: [],
      copiedClips: [],
    });
  });

  function createTimelineClip(id: string, assetId: string): TimelineClip {
    return {
      id,
      assetId,
      trackId: "track-1",
      start: 0,
      type: "video",
      name: `${id}.mp4`,
      sourceDuration: 100,
      transformedDuration: 100,
      transformedOffset: 0,
      timelineDuration: 100,
      croppedSourceDuration: 100,
      offset: 0,
      transformations: [],
    };
  }

  const mockStore = (state: Partial<ReturnType<typeof useAssetStore>> = {}) => {
    const defaultState = {
      assets: [],
      families: [],
      uploadAsset: vi.fn(),
      isUploading: false,
      uploadingCount: 0,
      isLoading: false,
      inputCache: new Map(),
      fetchAssets: vi.fn(),
      getInput: vi.fn(),
      addLocalAsset: vi.fn(),
      addLocalAssetWithFamily: vi.fn(),
      addLocalAssets: mockAddLocalAssets,
      upsertFamily: vi.fn(),
      setFamilyRepresentative: vi.fn(),
      updateAsset: vi.fn(),
      scanForNewAssets: vi.fn(),
      ensureAssetSourceLoaded: vi.fn(),
      _ingestAsset: vi.fn(),
      isScanning: false,
      deleteAsset: mockDeleteAsset,
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
    mockStore({ assets: mockAssets, families: mockFamilies });

    render(<AssetBrowser />);

    // 1. Initial State: Video Tab
    expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
    expect(screen.getByText("solo.mp4")).toBeInTheDocument();
    expect(screen.queryByText("b-roll.mp4")).not.toBeInTheDocument();
    expect(
      screen.queryByText("vacation_sam2_mask.mp4"),
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
      screen.queryByText("vacation_sam2_mask.mp4"),
    ).not.toBeInTheDocument();
  });

  it("falls back to per-asset cards when a family spans multiple media types", () => {
    mockStore({
      assets: [
        {
          id: "mixed-video",
          type: "video",
          name: "mixed.mp4",
          src: "mixed.mp4",
          hash: "mixed-video",
          familyId: "mixed-family",
          createdAt: 2,
        },
        {
          id: "mixed-image",
          type: "image",
          name: "mixed.png",
          src: "mixed.png",
          hash: "mixed-image",
          familyId: "mixed-family",
          createdAt: 1,
        },
      ],
      families: [
        {
          id: "mixed-family",
          representativeAssetId: "mixed-video",
          autoMatchKeys: ["generation-family:v1:mixed"],
          compatibility: {
            assetType: "video",
            durationMs: 5000,
            fpsMilli: 24000,
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });

    render(<AssetBrowser />);

    expect(screen.getByText("mixed.mp4")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open family" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Images"));

    expect(screen.getByText("mixed.png")).toBeInTheDocument();
    expect(screen.queryByText("mixed.mp4")).not.toBeInTheDocument();
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
    mockAddLocalAssets.mockResolvedValue({
      assets: [
        {
          id: "3",
          type: "image",
          name: "poster.png",
          src: "poster.png",
          hash: "3",
          createdAt: 1,
        } satisfies Asset,
      ],
      skippedExistingFiles: 0,
    });
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
    mockAddLocalAssets.mockResolvedValue({
      assets: [
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
      ],
      skippedExistingFiles: 0,
    });
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

  it("alerts when uploaded files are skipped because they already exist", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockAddLocalAssets.mockResolvedValue({
      assets: [],
      skippedExistingFiles: 1,
    });
    mockStore({ assets: [] });

    render(<AssetBrowser />);

    const input = screen.getByTestId("hidden-file-input") as HTMLInputElement;
    const file = new File(["dummy"], "poster.png", { type: "image/png" });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        "1 file was skipped because the asset already exists in this project.",
      );
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[AssetBrowser] Skipped preexisting uploaded assets",
      {
        skippedExistingFiles: 1,
      },
    );
  });

  it("locks the asset browser scroll region during an external asset drag", async () => {
    mockStore({ assets: mockAssets, families: mockFamilies });
    useInteractionStore.setState({
      activeClip: externalAssetDragClip,
      operation: "move",
    });

    render(<AssetBrowser />);

    const scrollRegion = screen.getByTestId("asset-browser-scroll-region");

    expect(scrollRegion).toHaveAttribute("data-scroll-locked", "true");

    scrollRegion.scrollTop = 120;
    fireEvent.scroll(scrollRegion);

    await waitFor(() => {
      expect(scrollRegion.scrollTop).toBe(0);
    });
  });

  it("filters the current tab to favourite assets when the toolbar heart is enabled", () => {
    mockStore({ assets: mockAssets, families: mockFamilies });

    render(<AssetBrowser />);

    expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
    expect(screen.getByText("solo.mp4")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Show favourite assets" }),
    );

    expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
    expect(screen.queryByText("solo.mp4")).not.toBeInTheDocument();
  });

  it("opens a family scope in the browser and only populates the matching media tab", async () => {
    mockStore({
      assets: mockAssets,
      families: mockFamilies,
    });

    render(<AssetBrowser />);

    expect(screen.getAllByRole("button", { name: "Open family" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Asset actions" })).toHaveLength(2);

    const soloCard = screen.getByText("solo.mp4").closest('[data-testid="asset-card"]');
    expect(soloCard).not.toBeNull();
    expect(
      within(soloCard as HTMLElement).queryByRole("button", {
        name: "Open family",
      }),
    ).not.toBeInTheDocument();

    const representativeCard = screen
      .getByText("vacation.mp4")
      .closest('[data-testid="asset-card"]');
    expect(representativeCard).not.toBeNull();

    fireEvent.click(
      within(representativeCard as HTMLElement).getByRole("button", {
        name: "Open family",
      }),
    );

    expect(screen.getByTestId("asset-browser-family-scope")).toBeInTheDocument();
    expect(screen.getByText("family-1")).toBeInTheDocument();
    expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
    expect(screen.getByText("b-roll.mp4")).toBeInTheDocument();
    expect(screen.queryByText("solo.mp4")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open family" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Images"));

    expect(screen.getByText("No image assets in this family.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to all assets" }));

    await waitFor(() => {
      expect(
        screen.queryByTestId("asset-browser-family-scope"),
      ).not.toBeInTheDocument();
    });

    expect(screen.getByText("thumbnail.jpg")).toBeInTheDocument();
    expect(screen.queryByText("vacation.mp4")).not.toBeInTheDocument();
  });

  it("clears the family scope when escape is pressed", async () => {
    mockStore({
      assets: mockAssets,
      families: mockFamilies,
    });

    render(<AssetBrowser />);

    fireEvent.click(screen.getByRole("button", { name: "Open family" }));

    expect(screen.getByTestId("asset-browser-family-scope")).toBeInTheDocument();
    expect(screen.getByText("b-roll.mp4")).toBeInTheDocument();
    expect(screen.queryByText("solo.mp4")).not.toBeInTheDocument();

    fireEvent.keyDown(window, {
      key: "Escape",
      code: "Escape",
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("asset-browser-family-scope"),
      ).not.toBeInTheDocument();
    });

    expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
    expect(screen.getByText("solo.mp4")).toBeInTheDocument();
    expect(screen.queryByText("b-roll.mp4")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Open family" })).toHaveLength(1);
  });

  it("shows delete all from the main browser and deletes the full batch after confirmation", async () => {
    mockStore({
      assets: mockAssets,
      families: mockFamilies,
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<AssetBrowser />);

    const representativeCard = screen
      .getByText("vacation.mp4")
      .closest('[data-testid="asset-card"]');

    expect(representativeCard).not.toBeNull();

    fireEvent.click(
      within(representativeCard as HTMLElement).getByRole("button", {
        name: "Asset actions",
      }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete all" }));

    expect(confirmSpy).toHaveBeenCalledWith(
      "Are you sure you want to delete this entire asset batch? This will remove all assets in this batch from disk permanently.",
    );

    await waitFor(() => {
      expect(mockDeleteAsset).toHaveBeenCalledWith("1");
      expect(mockDeleteAsset).toHaveBeenCalledWith("1b");
    });
  });

  it("hides delete all when viewing a family scope", async () => {
    mockStore({
      assets: mockAssets,
      families: mockFamilies,
    });

    render(<AssetBrowser />);

    fireEvent.click(screen.getByRole("button", { name: "Open family" }));

    const familyCard = screen
      .getByText("vacation.mp4")
      .closest('[data-testid="asset-card"]');

    expect(familyCard).not.toBeNull();

    fireEvent.click(
      within(familyCard as HTMLElement).getByRole("button", {
        name: "Asset actions",
      }),
    );

    expect(
      screen.queryByRole("menuitem", { name: "Delete all" }),
    ).not.toBeInTheDocument();
  });

  it("shows individual family members and hides family buttons when asset browser display is ungrouped", () => {
    useProjectStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        assetBrowserDisplay: "ungrouped",
      },
    }));
    mockStore({
      assets: mockAssets,
      families: mockFamilies,
    });

    render(<AssetBrowser />);

    expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
    expect(screen.getByText("b-roll.mp4")).toBeInTheDocument();
    expect(screen.getByText("solo.mp4")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open family" }),
    ).not.toBeInTheDocument();
  });

  it("selects an asset card and highlights all timeline clips that use it", async () => {
    mockStore({ assets: mockAssets, families: mockFamilies });
    useTimelineStore.setState({
      clips: [
        createTimelineClip("clip-1", "1"),
        createTimelineClip("clip-2", "1"),
        createTimelineClip("clip-3", "solo-video"),
      ],
      selectedClipIds: [],
    });

    render(<AssetBrowser />);

    const assetCard = screen
      .getByText("vacation.mp4")
      .closest('[data-testid="asset-card"]');

    expect(assetCard).not.toBeNull();

    fireEvent.click(assetCard as HTMLElement);

    await waitFor(() => {
      expect(useTimelineStore.getState().selectedClipIds).toEqual([
        "clip-1",
        "clip-2",
      ]);
    });

    expect(assetCard).toHaveAttribute("data-selected", "true");
  });

  it("supports ctrl+click multiselect and disables asset dragging while multiple assets are selected", async () => {
    mockStore({ assets: mockAssets, families: mockFamilies });
    useTimelineStore.setState({
      clips: [
        createTimelineClip("clip-1", "1"),
        createTimelineClip("clip-2", "solo-video"),
      ],
      selectedClipIds: [],
    });

    render(<AssetBrowser />);

    const firstCard = screen
      .getByText("vacation.mp4")
      .closest('[data-testid="asset-card"]');
    const secondCard = screen
      .getByText("solo.mp4")
      .closest('[data-testid="asset-card"]');

    expect(firstCard).not.toBeNull();
    expect(secondCard).not.toBeNull();

    fireEvent.click(firstCard as HTMLElement);
    fireEvent.click(secondCard as HTMLElement, { ctrlKey: true });

    await waitFor(() => {
      expect(useTimelineStore.getState().selectedClipIds).toEqual([
        "clip-1",
        "clip-2",
      ]);
    });

    expect(firstCard).toHaveAttribute("data-selected", "true");
    expect(secondCard).toHaveAttribute("data-selected", "true");
    expect(firstCard).toHaveAttribute("data-drag-disabled", "true");
    expect(secondCard).toHaveAttribute("data-drag-disabled", "true");
  });

  it("deletes the selected asset with the existing confirmation flow", async () => {
    mockStore({ assets: mockAssets, families: mockFamilies });
    useTimelineStore.setState({
      clips: [createTimelineClip("clip-1", "1")],
      selectedClipIds: [],
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<AssetBrowser />);

    const assetCard = screen
      .getByText("vacation.mp4")
      .closest('[data-testid="asset-card"]');

    expect(assetCard).not.toBeNull();

    fireEvent.click(assetCard as HTMLElement);
    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => {
      expect(mockDeleteAsset).toHaveBeenCalledWith("1");
    });

    expect(confirmSpy).toHaveBeenCalledWith(
      "Are you sure you want to delete this asset? This will remove it from disk permanently.\n\nThis asset is used by clips on the Timeline.\nClips on the Timeline are derived from the asset and will be deleted.",
    );
  });

  it("reveals a requested asset by switching tabs, clearing favourite-only mode, and opening the family scope when needed", async () => {
    useProjectStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        assetBrowserDisplay: "ungrouped",
      },
    }));
    mockStore({ assets: mockAssets, families: mockFamilies });

    render(<AssetBrowser />);

    fireEvent.click(screen.getByLabelText("Images"));
    fireEvent.click(
      screen.getByRole("button", { name: "Show favourite assets" }),
    );

    act(() => {
      revealAssetInBrowser("1b");
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Videos")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    expect(screen.getByTestId("asset-browser-family-scope")).toBeInTheDocument();
    expect(screen.getByText("family-1")).toBeInTheDocument();
    expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
    expect(screen.getByText("b-roll.mp4")).toBeInTheDocument();
    expect(screen.queryByText("thumbnail.jpg")).not.toBeInTheDocument();

    const targetCard = screen
      .getByText("b-roll.mp4")
      .closest('[data-testid="asset-card"]');

    expect(targetCard).not.toBeNull();
    expect(targetCard).toHaveAttribute("data-selected", "true");
    expect(
      screen.getByRole("button", { name: "Show favourite assets" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("does not reopen a previously revealed family when unrelated assets are ingested later", async () => {
    mockStore({ assets: mockAssets, families: mockFamilies });

    const { rerender } = render(<AssetBrowser />);

    act(() => {
      revealAssetInBrowser("1b");
    });

    await waitFor(() => {
      expect(screen.getByTestId("asset-browser-family-scope")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Back to all assets" }));

    await waitFor(() => {
      expect(
        screen.queryByTestId("asset-browser-family-scope"),
      ).not.toBeInTheDocument();
    });

    mockStore({
      assets: [
        ...mockAssets,
        {
          id: "new-video",
          type: "video",
          name: "new-upload.mp4",
          src: "new-upload.mp4",
          hash: "new-video",
          createdAt: 3,
        },
      ],
      families: mockFamilies,
    });

    rerender(<AssetBrowser />);

    expect(
      screen.queryByTestId("asset-browser-family-scope"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
    expect(screen.getByText("solo.mp4")).toBeInTheDocument();
    expect(screen.queryByText("b-roll.mp4")).not.toBeInTheDocument();
  });
});
