import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompositeAsset, TimelineClip } from "../../../types/TimelineTypes";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import { useEditorFocusStore } from "../../editorFocus";
import { useInteractionStore } from "../../timeline/hooks/useInteractionStore";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { CompositeBrowser } from "../CompositeBrowser";
import { useCompositeLibraryStore } from "../useCompositeLibraryStore";
import { useCompositeTimelineStore } from "../useCompositeTimelineStore";

const mocks = vi.hoisted(() => ({
  scrollToItemId: vi.fn(),
}));

vi.mock("../../libraryBrowser", () => ({
  LibraryBrowserGrid: ({
    items,
    renderItem,
    emptyMessage,
    apiRef,
    pinnedItemId,
    onBackgroundClick,
  }: {
    items: CompositeAsset[];
    renderItem: (item: CompositeAsset) => React.ReactNode;
    emptyMessage: string;
    apiRef: React.MutableRefObject<{ scrollToItemId: (id: string) => void } | null>;
    pinnedItemId?: string | null;
    onBackgroundClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  }) => {
    apiRef.current = { scrollToItemId: mocks.scrollToItemId };
    return (
      <div
        data-testid="mock-grid"
        data-pinned-item-id={pinnedItemId ?? ""}
        onClick={onBackgroundClick}
      >
        {items.length === 0 ? emptyMessage : items.map(renderItem)}
      </div>
    );
  },
}));

vi.mock("../components/CompositeCard", () => ({
  CompositeCard: ({
    composite,
    isSelected,
    disableDrag,
    onSelect,
    onOpen,
    onRename,
    onDelete,
    onPlaceOnTimeline,
  }: {
    composite: CompositeAsset;
    isSelected: boolean;
    disableDrag?: boolean;
    onSelect: (event: React.MouseEvent<HTMLDivElement>) => void;
    onOpen: () => void;
    onRename: () => void;
    onDelete: () => void;
    onPlaceOnTimeline: () => void;
  }) => (
    <div
      data-testid="composite-card"
      data-composite-id={composite.id}
      data-selected={String(isSelected)}
      data-disable-drag={String(Boolean(disableDrag))}
      onClick={onSelect}
    >
      <span>{composite.name}</span>
      <button onClick={(event) => { event.stopPropagation(); onOpen(); }}>
        Open {composite.id}
      </button>
      <button onClick={(event) => { event.stopPropagation(); onRename(); }}>
        Rename {composite.id}
      </button>
      <button onClick={(event) => { event.stopPropagation(); onDelete(); }}>
        Delete {composite.id}
      </button>
      <button
        onClick={(event) => {
          event.stopPropagation();
          onPlaceOnTimeline();
        }}
      >
        Place {composite.id}
      </button>
    </div>
  ),
}));

function composite(id: string, name = id): CompositeAsset {
  return {
    id,
    name,
    bakedAssetId: `bake-${id}`,
    createdAt: 1,
    updatedAt: 1,
    content: {
      clips: [],
      tracks: [],
      durationTicks: 96000,
    },
  };
}

const libraryActions = {
  fetchComposites: useCompositeLibraryStore.getState().fetchComposites,
  createCompositeAsset: useCompositeLibraryStore.getState().createCompositeAsset,
  updateCompositeAssetContent:
    useCompositeLibraryStore.getState().updateCompositeAssetContent,
  renameCompositeAsset: vi.fn(async () => undefined),
  deleteCompositeAsset: vi.fn(async () => undefined),
  placeCompositeAssetAtTime: vi.fn(() => null as string | null),
  selectComposite: vi.fn(),
  setSelectedCompositeIds: vi.fn(),
  clearSelection: vi.fn(),
  revealCompositeInBrowser:
    useCompositeLibraryStore.getState().revealCompositeInBrowser,
  clearRevealRequest: vi.fn(),
};

const realSelectClip = useTimelineStore.getState().selectClip;
const timelineActions = {
  selectClip: vi.fn((clipId: string | null, additive?: boolean) =>
    realSelectClip(clipId, additive),
  ),
};

function renderBrowser(
  props: Partial<React.ComponentProps<typeof CompositeBrowser>> = {},
) {
  return render(
    <CompositeBrowser
      isCreatingFromSelection={false}
      selectionError={null}
      onCreateBlank={vi.fn()}
      onCreateFromSelection={vi.fn()}
      onClearSelectionError={vi.fn()}
      {...props}
    />,
  );
}

describe("CompositeBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    useEditorFocusStore.getState().setRegion(null);
    useInteractionStore.setState({
      activeId: null,
      operation: null,
    });
    useCompositeLibraryStore.setState({
      composites: [composite("one", "One"), composite("two", "Two")],
      isLoading: false,
      selectedCompositeIds: [],
      revealRequest: null,
      ...libraryActions,
    });
    useCompositeTimelineStore.setState({
      openCompositeAsset: vi.fn(() => true),
    });
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        {
          id: "track-1",
          label: "Track",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
      clips: [],
    });
    useTimelineStore.setState(timelineActions);
    playbackClock.setTime(500);
  });

  it("renders actions, loading state, errors, and empty content", () => {
    const onCreateBlank = vi.fn();
    const onCreateFromSelection = vi.fn();
    const onClearSelectionError = vi.fn();
    const view = renderBrowser({
      isCreatingFromSelection: true,
      selectionError: "Selection failed",
      onCreateBlank,
      onCreateFromSelection,
      onClearSelectionError,
    });

    fireEvent.click(screen.getByTestId("composite-add-scene"));
    expect(onCreateBlank).toHaveBeenCalled();
    expect(screen.getByTestId("composite-create-from-selection")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClearSelectionError).toHaveBeenCalled();

    act(() => {
      useCompositeLibraryStore.setState({ composites: [] });
    });
    expect(screen.getByText("No composite clips yet.")).toBeInTheDocument();
    view.unmount();
  });

  it("selects normally or additively and clears from the background", () => {
    renderBrowser();
    const cards = screen.getAllByTestId("composite-card");
    fireEvent.click(cards[0]);
    fireEvent.click(cards[1], { ctrlKey: true });
    expect(libraryActions.selectComposite).toHaveBeenNthCalledWith(
      1,
      "one",
      false,
    );
    expect(libraryActions.selectComposite).toHaveBeenNthCalledWith(
      2,
      "two",
      true,
    );

    fireEvent.click(screen.getByTestId("mock-grid"));
    expect(libraryActions.clearSelection).toHaveBeenCalled();
    expect(timelineActions.selectClip).toHaveBeenCalledWith(null);
  });

  it("opens, renames, deletes, and places a composite", () => {
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Renamed");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    libraryActions.placeCompositeAssetAtTime.mockReturnValue("placed-clip");
    renderBrowser();

    fireEvent.click(screen.getByRole("button", { name: "Open one" }));
    expect(
      useCompositeTimelineStore.getState().openCompositeAsset,
    ).toHaveBeenCalledWith("one");

    fireEvent.click(screen.getByRole("button", { name: "Rename one" }));
    expect(prompt).toHaveBeenCalledWith("Rename composite", "One");
    expect(libraryActions.renameCompositeAsset).toHaveBeenCalledWith(
      "one",
      "Renamed",
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete one" }));
    expect(confirm).toHaveBeenCalledWith("Delete this composite asset?");
    expect(libraryActions.deleteCompositeAsset).toHaveBeenCalledWith("one");

    fireEvent.click(screen.getByRole("button", { name: "Place one" }));
    expect(libraryActions.placeCompositeAssetAtTime).toHaveBeenCalledWith(
      "one",
      500,
    );
    expect(timelineActions.selectClip).toHaveBeenCalledWith("placed-clip");
  });

  it("respects cancelled rename/delete dialogs and mentions placements", () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: useTimelineStore.getState().tracks,
      clips: [
        {
          id: "placement",
          type: "video",
          compositeId: "one",
          assetId: "bake-one",
          trackId: "track-1",
          start: 0,
          timelineDuration: 100,
        } as TimelineClip,
      ],
    });
    renderBrowser();

    fireEvent.click(screen.getByRole("button", { name: "Rename one" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete one" }));
    expect(libraryActions.renameCompositeAsset).not.toHaveBeenCalled();
    expect(libraryActions.deleteCompositeAsset).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("deletes all timeline placements"),
    );
  });

  it("deletes selected composites by keyboard only when the browser owns focus", () => {
    useCompositeLibraryStore.setState({
      selectedCompositeIds: ["one", "two"],
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderBrowser();

    fireEvent.keyDown(window, { key: "Delete" });
    expect(confirm).not.toHaveBeenCalled();

    useEditorFocusStore.getState().setRegion("assetBrowser");
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(libraryActions.deleteCompositeAsset).toHaveBeenCalledWith("one");
    expect(libraryActions.deleteCompositeAsset).toHaveBeenCalledWith("two");

    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "Delete" });
    expect(confirm).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("pins the dragged composite and disables multi-selection dragging", () => {
    useInteractionStore.setState({
      operation: "move",
      activeId: "composite-asset-two",
    });
    useCompositeLibraryStore.setState({
      selectedCompositeIds: ["one", "two"],
    });
    renderBrowser();
    expect(screen.getByTestId("mock-grid")).toHaveAttribute(
      "data-pinned-item-id",
      "two",
    );
    expect(screen.getAllByTestId("composite-card")[0]).toHaveAttribute(
      "data-disable-drag",
      "true",
    );
  });

  it("prunes hidden selection and clears stale reveal requests", () => {
    useCompositeLibraryStore.setState({
      selectedCompositeIds: ["one", "missing"],
      revealRequest: {
        compositeAssetId: "missing",
        requestId: 9,
      },
    });
    renderBrowser();
    expect(libraryActions.setSelectedCompositeIds).toHaveBeenCalledWith([
      "one",
    ]);
    expect(libraryActions.clearRevealRequest).toHaveBeenCalledWith(9);
  });

  it("selects and scrolls to a revealed composite", () => {
    useCompositeLibraryStore.setState({
      revealRequest: {
        compositeAssetId: "two",
        requestId: 10,
      },
    });
    renderBrowser();
    expect(libraryActions.selectComposite).toHaveBeenCalledWith("two");
    expect(libraryActions.clearRevealRequest).toHaveBeenCalledWith(10);
    expect(mocks.scrollToItemId).toHaveBeenCalledWith("two");
  });
});
