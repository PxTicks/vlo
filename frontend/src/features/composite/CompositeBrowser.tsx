import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import AddBoxIcon from "@mui/icons-material/AddBox";
import LayersIcon from "@mui/icons-material/Layers";
import { LibraryBrowserGrid, type LibraryBrowserGridApi } from "../libraryBrowser";
import { useInteractionStore } from "../timeline/hooks/useInteractionStore";
import {
  useEditorFocusStore,
  useRegionFocus,
} from "../editorFocus";
import { playbackClock } from "../../core/playback/PlaybackClock";
import {
  getSelectedTimelineClipIds,
  getTimelineCompositePlacementIds,
  selectTimelineClip,
  useSelectedTimelineClipIds,
} from "../timeline/api";
import { useCompositeLibraryStore } from "./useCompositeLibraryStore";
import { useCompositeTimelineStore } from "./useCompositeTimelineStore";
import { CompositeCard } from "./components/CompositeCard";

interface CompositeBrowserProps {
  isCreatingFromSelection: boolean;
  selectionError: string | null;
  onCreateBlank: () => void;
  onCreateFromSelection: () => void;
  onClearSelectionError: () => void;
}

function getTimelinePlacementIds(compositeAssetIds: readonly string[]): string[] {
  return getTimelineCompositePlacementIds(compositeAssetIds);
}

function getCompositeDeleteMessage(placementCount: number): string {
  return placementCount > 0
    ? "Delete this composite asset? This removes it from the composite browser and deletes all timeline placements that reference it."
    : "Delete this composite asset?";
}

export function CompositeBrowser({
  isCreatingFromSelection,
  selectionError,
  onCreateBlank,
  onCreateFromSelection,
  onClearSelectionError,
}: CompositeBrowserProps) {
  const compositeBrowserFocusProps = useRegionFocus("assetBrowser");
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<LibraryBrowserGridApi>(null);
  const pendingScrollCompositeId = useRef<string | null>(null);
  // The composite list is not scroll-locked during a drag, so keep the dragged
  // card mounted to stop dnd-kit losing its source if auto-scroll moves it out
  // of the virtual window. Draggable id is `composite-asset-<compositeId>`.
  const pinnedCompositeId = useInteractionStore((state) =>
    state.operation === "move" &&
    state.activeId?.startsWith("composite-asset-")
      ? state.activeId.slice("composite-asset-".length)
      : null,
  );
  const composites = useCompositeLibraryStore((state) => state.composites);
  const selectedCompositeIds = useCompositeLibraryStore(
    (state) => state.selectedCompositeIds,
  );
  const revealRequest = useCompositeLibraryStore((state) => state.revealRequest);
  const selectComposite = useCompositeLibraryStore(
    (state) => state.selectComposite,
  );
  const clearSelection = useCompositeLibraryStore(
    (state) => state.clearSelection,
  );
  const setSelectedCompositeIds = useCompositeLibraryStore(
    (state) => state.setSelectedCompositeIds,
  );
  const clearRevealRequest = useCompositeLibraryStore(
    (state) => state.clearRevealRequest,
  );
  const renameCompositeAsset = useCompositeLibraryStore(
    (state) => state.renameCompositeAsset,
  );
  const deleteCompositeAsset = useCompositeLibraryStore(
    (state) => state.deleteCompositeAsset,
  );
  const placeCompositeAssetAtTime = useCompositeLibraryStore(
    (state) => state.placeCompositeAssetAtTime,
  );
  const openCompositeAsset = useCompositeTimelineStore(
    (state) => state.openCompositeAsset,
  );
  const selectedClipIds = useSelectedTimelineClipIds();
  const visibleCompositeIds = useMemo(
    () => new Set(composites.map((composite) => composite.id)),
    [composites],
  );
  const isMultiSelectActive = selectedCompositeIds.length > 1;

  useEffect(() => {
    if (selectedCompositeIds.length === 0) {
      return;
    }

    const nextSelectedCompositeIds = selectedCompositeIds.filter((id) =>
      visibleCompositeIds.has(id),
    );
    if (nextSelectedCompositeIds.length === selectedCompositeIds.length) {
      return;
    }

    setSelectedCompositeIds(nextSelectedCompositeIds);
    if (nextSelectedCompositeIds.length === 0) {
      selectTimelineClip(null);
    }
  }, [selectedCompositeIds, setSelectedCompositeIds, visibleCompositeIds]);

  useEffect(() => {
    if (selectedCompositeIds.length === 0) {
      return;
    }

    const placementIds = getTimelinePlacementIds(selectedCompositeIds);
    const selectedClipIds = getSelectedTimelineClipIds();
    if (
      selectedClipIds.length === placementIds.length &&
      selectedClipIds.every((clipId, index) => clipId === placementIds[index])
    ) {
      return;
    }

    selectTimelineClip(null);
    placementIds.forEach((clipId) => selectTimelineClip(clipId, true));
  }, [selectedCompositeIds, selectedClipIds]);

  useEffect(() => {
    if (!revealRequest) {
      return;
    }
    const composite = composites.find(
      (candidate) => candidate.id === revealRequest.compositeAssetId,
    );
    if (!composite) {
      clearRevealRequest(revealRequest.requestId);
      return;
    }

    selectComposite(composite.id);
    pendingScrollCompositeId.current = composite.id;
    clearRevealRequest(revealRequest.requestId);
  }, [clearRevealRequest, composites, revealRequest, selectComposite]);

  useEffect(() => {
    const compositeId = pendingScrollCompositeId.current;
    if (!compositeId || !visibleCompositeIds.has(compositeId)) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      gridApiRef.current?.scrollToItemId(compositeId);
      pendingScrollCompositeId.current = null;
    });

    return () => cancelAnimationFrame(frameId);
  }, [composites, visibleCompositeIds]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        useEditorFocusStore.getState().region !== "assetBrowser" ||
        selectedCompositeIds.length === 0 ||
        event.defaultPrevented
      ) {
        return;
      }

      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      ) {
        return;
      }

      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }

      event.preventDefault();
      const placementCount = getTimelinePlacementIds(selectedCompositeIds).length;
      if (!window.confirm(getCompositeDeleteMessage(placementCount))) {
        return;
      }
      void Promise.all(
        selectedCompositeIds.map((compositeId) =>
          deleteCompositeAsset(compositeId),
        ),
      );
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteCompositeAsset, selectedCompositeIds]);

  const handleSelectComposite = (
    compositeAssetId: string,
    event: MouseEvent<HTMLDivElement>,
  ) => {
    selectComposite(compositeAssetId, event.ctrlKey || event.metaKey);
  };

  const handleBrowserBackgroundClick = (
    event: MouseEvent<HTMLDivElement>,
  ) => {
    const target = event.target;
    if (target instanceof Element && target.closest('[data-testid="composite-card"]')) {
      return;
    }

    clearSelection();
    selectTimelineClip(null);
  };

  const handleRename = (compositeAssetId: string, currentName: string) => {
    const nextName = window.prompt("Rename composite", currentName);
    if (nextName === null) {
      return;
    }
    void renameCompositeAsset(compositeAssetId, nextName);
  };

  const handleDelete = (compositeAssetId: string) => {
    const placementCount = getTimelinePlacementIds([compositeAssetId]).length;
    if (!window.confirm(getCompositeDeleteMessage(placementCount))) {
      return;
    }
    void deleteCompositeAsset(compositeAssetId);
  };

  const handlePlaceOnTimeline = (compositeAssetId: string) => {
    const placedClipId = placeCompositeAssetAtTime(
      compositeAssetId,
      playbackClock.time,
    );
    if (placedClipId) {
      selectTimelineClip(placedClipId);
    }
  };

  return (
    <Box
      data-testid="composite-browser"
      {...compositeBrowserFocusProps}
      sx={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        flex: 1,
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{ px: 2, py: 1.25 }}
      >
        <Tooltip title="Add blank composite">
          <IconButton
            aria-label="Add blank composite"
            data-testid="composite-add-scene"
            onClick={onCreateBlank}
            sx={{
              color: "#f5f5f5",
              bgcolor: "#1f1830",
              border: "1px solid rgba(167, 139, 250, 0.32)",
              "&:hover": { bgcolor: "#2b2142" },
            }}
          >
            <AddBoxIcon />
          </IconButton>
        </Tooltip>
        <Button
          variant="outlined"
          size="small"
          startIcon={
            isCreatingFromSelection ? (
              <CircularProgress size={14} color="inherit" />
            ) : (
              <LayersIcon />
            )
          }
          disabled={isCreatingFromSelection}
          onClick={onCreateFromSelection}
          data-testid="composite-create-from-selection"
          sx={{ color: "#ddd6fe", borderColor: "rgba(167, 139, 250, 0.36)" }}
        >
          From selection
        </Button>
      </Stack>

      {selectionError ? (
        <Alert
          severity="error"
          onClose={onClearSelectionError}
          sx={{ mx: 2, mb: 1 }}
        >
          {selectionError}
        </Alert>
      ) : null}

      <Typography
        variant="caption"
        sx={{
          color: "#9ca3af",
          px: 2,
          pb: 0.5,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Composite clips
      </Typography>

      <LibraryBrowserGrid
        items={composites}
        getItemId={(composite) => composite.id}
        emptyMessage="No composite clips yet."
        scrollRegionRef={scrollRegionRef}
        apiRef={gridApiRef}
        pinnedItemId={pinnedCompositeId}
        testId="composite-browser-scroll-region"
        onBackgroundClick={handleBrowserBackgroundClick}
        renderItem={(composite) => (
          <CompositeCard
            composite={composite}
            disableDrag={isMultiSelectActive}
            isSelected={selectedCompositeIds.includes(composite.id)}
            onSelect={(event) => handleSelectComposite(composite.id, event)}
            onOpen={() => openCompositeAsset(composite.id)}
            onRename={() => handleRename(composite.id, composite.name)}
            onDelete={() => handleDelete(composite.id)}
            onPlaceOnTimeline={() => handlePlaceOnTimeline(composite.id)}
          />
        )}
      />
    </Box>
  );
}
