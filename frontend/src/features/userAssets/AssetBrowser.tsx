import React, {
  useState,
  useRef,
  useMemo,
  useSyncExternalStore,
  memo,
} from "react";
import { AppMenu } from "../../core/shell/AppMenu";
import { hostContextKeys } from "../../core/shell/contextKeys";
import { useHostContextMenu } from "../../core/shell/useHostContextMenu";
import type { HostMenuItemDescriptor } from "../../core/shell/menuDescriptors";
import { hostOptionCatalog } from "../../core/shell/optionCatalog";
import {
  compareAssetsBySortValue,
  declareLibrarySortModes,
  DEFAULT_LIBRARY_SORT_MODE_ID,
  isLibrarySortMode,
  LIBRARY_SORT_MODES_CATALOGUE,
} from "./sortModesCatalogue";
import { isAssetBackedClip } from "../../types/TimelineTypes";
import {
  Box,
  Tabs,
  Tab,
  CircularProgress,
  Typography,
  IconButton,
  Tooltip,
} from "@mui/material";

// Icons
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import VideoLibraryIcon from "@mui/icons-material/VideoLibrary";
import PhotoLibraryIcon from "@mui/icons-material/PhotoLibrary";
import LibraryMusicIcon from "@mui/icons-material/LibraryMusic";
import GradientIcon from "@mui/icons-material/Gradient";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import SortIcon from "@mui/icons-material/Sort";
import FavoriteIcon from "@mui/icons-material/Favorite";
import FavoriteBorderIcon from "@mui/icons-material/FavoriteBorder";

import type { Asset, AssetType } from "../../types/Asset";
import { doesAssetBelongToFamily } from "../../shared/utils/assetFamilies";
import {
  getSelectedTimelineClipIds,
  getTimelineClipCountForAsset,
  selectTimelineClip,
  useTimelineClips,
} from "../timeline/api";
import { useInteractionStore } from "../timeline/hooks/useInteractionStore";
import { useProjectStore } from "../project/useProjectStore";
import { LibraryBrowserGrid, type LibraryBrowserGridApi } from "../libraryBrowser";
import {
  useRegionFocus,
  useEditorFocusStore,
} from "../editorFocus";
import { useAssetStore } from "./useAssetStore";
import { AssetCard } from "./components/AssetCard";
import {
  invalidateMiniEditorWorkspaceAsset,
  useMiniEditorStore,
} from "../miniEditor";
import { openAssetInMiniEditor } from "./openAssetInMiniEditor";
import { useAssetBrowserRevealStore } from "./useAssetBrowserRevealStore";
import { useAssetBrowserSelectionStore } from "./useAssetBrowserSelectionStore";
import {
  deleteAssetBatchWithConfirmation,
  deleteAssetWithConfirmation,
} from "./utils/deleteAssetWithConfirmation";
import { isAssetVisibleInBrowser } from "./utils/assetVisibility";
import { getAssetsForFamilyId, getFamilyMembers } from "./utils/familyMembers";

// Catalogue initialization is owned by the consuming feature and explicit
// (the declareHostMenus pattern): rendering the browser never depends on
// bootstrap import order.
declareLibrarySortModes();

const ASSET_TYPE_PRIORITY: AssetType[] = ["video", "image", "audio", "lut"];
const ASSET_BROWSER_MINI_EDITOR_OPENER_ID = "asset-browser";

interface FamilyScope {
  familyId: string;
  assetType: AssetType;
}

function hasDraggedFiles(event: React.DragEvent<HTMLDivElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function getPreferredUploadedAssetType(
  assetTypes: readonly AssetType[],
): AssetType | null {
  for (const assetType of ASSET_TYPE_PRIORITY) {
    if (assetTypes.includes(assetType)) {
      return assetType;
    }
  }

  return null;
}

function isRepresentativeAsset(
  assetId: string,
  assetType: AssetType,
  familyId: string | null | undefined,
  families: ReturnType<typeof useAssetStore.getState>["families"],
  assets: ReturnType<typeof useAssetStore.getState>["assets"],
): boolean {
  if (!familyId) {
    return true;
  }

  const family = families.find((candidate) => candidate.id === familyId);
  if (!family?.representativeAssetId) {
    return true;
  }

  const asset = assets.find((candidate) => candidate.id === assetId);
  if (!asset || !doesAssetBelongToFamily(asset, family)) {
    return true;
  }

  if (family.representativeAssetId === assetId) {
    return true;
  }

  const representativeAsset = assets.find(
    (candidate) => candidate.id === family.representativeAssetId,
  );

  // If family data is inconsistent, prefer showing the asset rather than hiding it.
  if (
    !representativeAsset ||
    !doesAssetBelongToFamily(representativeAsset, family) ||
    representativeAsset.type !== assetType
  ) {
    return true;
  }

  return false;
}

function resolveFamilyScopeForAsset(
  asset: Asset,
  assets: ReturnType<typeof useAssetStore.getState>["assets"],
  families: ReturnType<typeof useAssetStore.getState>["families"],
): FamilyScope | null {
  if (!asset.familyId) {
    return null;
  }

  const family = families.find((candidate) => candidate.id === asset.familyId);
  if (!family) {
    return null;
  }

  return getFamilyMembers(assets, family, asset.type).length > 1
    ? {
        familyId: family.id,
        assetType: asset.type,
      }
    : null;
}

function AssetBrowserComponent() {
  const assetBrowserFocusProps = useRegionFocus("assetBrowser");
  const [activeTab, setActiveTab] = useState<AssetType>("video");
  const [sortOption, setSortOption] = useState<string>(
    DEFAULT_LIBRARY_SORT_MODE_ID,
  );
  const [sortAnchorEl, setSortAnchorEl] = useState<null | HTMLElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showFavouritesOnly, setShowFavouritesOnly] = useState(false);
  const [familyScope, setFamilyScope] = useState<FamilyScope | null>(null);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);

  const assets = useAssetStore((state) => state.assets);
  const families = useAssetStore((state) => state.families);
  const addLocalAssets = useAssetStore((state) => state.addLocalAssets);
  const deleteAsset = useAssetStore((state) => state.deleteAsset);
  const isUploading = useAssetStore((state) => state.isUploading);
  const timelineClips = useTimelineClips();
  const assetBrowserDisplay = useProjectStore(
    (state) => state.config.assetBrowserDisplay,
  );
  const revealRequest = useAssetBrowserRevealStore((state) => state.revealRequest);
  const clearRevealRequest = useAssetBrowserRevealStore(
    (state) => state.clearRevealRequest,
  );
  const selectedAssetIds = useAssetBrowserSelectionStore(
    (state) => state.selectedAssetIds,
  );
  const clearSelectedAssets = useAssetBrowserSelectionStore(
    (state) => state.clearSelection,
  );
  const selectAsset = useAssetBrowserSelectionStore((state) => state.selectAsset);
  const setSelectedAssetIds = useAssetBrowserSelectionStore(
    (state) => state.setSelectedAssetIds,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isDeletingSelectedAssetsRef = useRef(false);
  const [pendingScrollAssetId, setPendingScrollAssetId] = useState<string | null>(
    null,
  );
  const dragDepthRef = useRef(0);
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<LibraryBrowserGridApi>(null);
  const isAssetDragActive = useInteractionStore(
    (state) =>
      state.operation === "move" &&
      state.activeClip !== null &&
      !("trackId" in state.activeClip),
  );
  // Keep the dragged card mounted while the list could scroll, so dnd-kit never
  // loses its drag source. The asset draggable id is `asset_<assetId>`.
  const pinnedAssetId = useInteractionStore((state) =>
    state.operation === "move" && state.activeId?.startsWith("asset_")
      ? state.activeId.slice("asset_".length)
      : null,
  );

  React.useLayoutEffect(() => {
    const scrollRegion = scrollRegionRef.current;
    if (!scrollRegion || !isAssetDragActive) {
      return;
    }

    const lockedScrollTop = scrollRegion.scrollTop;
    const lockedScrollLeft = scrollRegion.scrollLeft;

    const restoreScrollPosition = () => {
      if (scrollRegion.scrollTop !== lockedScrollTop) {
        scrollRegion.scrollTop = lockedScrollTop;
      }
      if (scrollRegion.scrollLeft !== lockedScrollLeft) {
        scrollRegion.scrollLeft = lockedScrollLeft;
      }
    };

    const preventWheelScroll = (event: WheelEvent) => {
      event.preventDefault();
      restoreScrollPosition();
    };

    const preventTouchScroll = (event: TouchEvent) => {
      event.preventDefault();
      restoreScrollPosition();
    };

    restoreScrollPosition();
    scrollRegion.addEventListener("scroll", restoreScrollPosition);
    scrollRegion.addEventListener("wheel", preventWheelScroll, {
      passive: false,
    });
    scrollRegion.addEventListener("touchmove", preventTouchScroll, {
      passive: false,
    });

    return () => {
      scrollRegion.removeEventListener("scroll", restoreScrollPosition);
      scrollRegion.removeEventListener("wheel", preventWheelScroll);
      scrollRegion.removeEventListener("touchmove", preventTouchScroll);
    };
  }, [isAssetDragActive]);

  const handleTabChange = (
    _event: React.SyntheticEvent,
    newValue: AssetType,
  ) => {
    setActiveTab(newValue);
  };

  const handleAssetFiles = async (files: readonly File[]) => {
    if (files.length === 0) {
      return;
    }

    const { assets: uploadedAssets, skippedExistingFiles } = await addLocalAssets(
      files,
      { source: "uploaded" },
    );

    if (skippedExistingFiles > 0) {
      const skippedLabel =
        skippedExistingFiles === 1 ? "file was" : "files were";
      const message = `${skippedExistingFiles} ${skippedLabel} skipped because the asset already exists in this project.`;
      console.log("[AssetBrowser] Skipped preexisting uploaded assets", {
        skippedExistingFiles,
      });
      window.alert(message);
    }

    const nextTab = getPreferredUploadedAssetType(
      uploadedAssets.map((asset) => asset.type),
    );

    if (nextTab) {
      setActiveTab(nextTab);
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    void handleAssetFiles(files);
    event.target.value = "";
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = isUploading ? "none" : "copy";
    if (!isUploading) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);

    if (dragDepthRef.current === 0) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);

    if (isUploading) {
      return;
    }

    void handleAssetFiles(Array.from(event.dataTransfer.files));
  };

  // --- Sort Handlers ---
  const handleSortClick = (event: React.MouseEvent<HTMLElement>) => {
    setSortAnchorEl(event.currentTarget);
  };

  // Sort modes come from the `library.sort-modes` catalogue (plan §3.7);
  // both sort surfaces (dropdown + background menu) render its options.
  const sortModeRevision = useSyncExternalStore(
    (listener) => hostOptionCatalog.subscribe(listener),
    () => hostOptionCatalog.getRevision(),
    () => hostOptionCatalog.getRevision(),
  );
  const sortContextRevision = useSyncExternalStore(
    (listener) => hostContextKeys.subscribe(listener),
    () => hostContextKeys.getRevision(),
    () => hostContextKeys.getRevision(),
  );
  const sortModes = hostOptionCatalog.resolveOptions(
    LIBRARY_SORT_MODES_CATALOGUE,
  );
  const activeSortValue = sortModes.find(
    (mode) => mode.id === sortOption,
  )?.value;
  const activeSortMode = isLibrarySortMode(activeSortValue)
    ? activeSortValue
    : null;
  const missingSortModeItem: HostMenuItemDescriptor | null = activeSortMode
    ? null
    : {
        kind: "action",
        id: `missing-sort-${sortOption}`,
        label: `Missing sort provider: ${sortOption}`,
        group: "3_sort",
        order: -1,
        disabled: true,
        selected: true,
        run: () => undefined,
      };

  const familyMembersByType = useMemo(() => {
    const membersByType = new Map<string, number>();

    for (const family of families) {
      for (const asset of getFamilyMembers(assets, family)) {
        const key = `${family.id}:${asset.type}`;
        membersByType.set(key, (membersByType.get(key) ?? 0) + 1);
      }
    }

    return membersByType;
  }, [assets, families]);

  const selectedFamily = useMemo(
    () =>
      familyScope
        ? families.find((family) => family.id === familyScope.familyId)
        : undefined,
    [families, familyScope],
  );
  const effectiveFamilyScope = selectedFamily ? familyScope : null;

  const scopedFamilyAssets = useMemo(() => {
    if (!effectiveFamilyScope || !selectedFamily) {
      return [];
    }

    return getFamilyMembers(
      assets,
      selectedFamily,
      effectiveFamilyScope.assetType,
    );
  }, [assets, selectedFamily, effectiveFamilyScope]);

  React.useEffect(() => {
    if (!effectiveFamilyScope) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      const target = event.target;
      if (target instanceof Element && target.closest('[role="dialog"]')) {
        return;
      }

      event.preventDefault();
      setFamilyScope(null);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [effectiveFamilyScope]);

  const sortedAssets = useMemo(() => {
    // These tokens make external-store changes part of this memo's contract.
    void sortModeRevision;
    void sortContextRevision;
    const baseAssets = effectiveFamilyScope
      ? activeTab === effectiveFamilyScope.assetType
        ? scopedFamilyAssets
        : []
      : assets.filter(
          (asset) =>
            asset.type === activeTab &&
            isAssetVisibleInBrowser(asset) &&
            (assetBrowserDisplay === "ungrouped" ||
              isRepresentativeAsset(
                asset.id,
                asset.type,
                asset.familyId,
                families,
                assets,
              )),
        );

    const filtered = baseAssets.filter(
      (asset) => !showFavouritesOnly || asset.favourite,
    );

    // Pull inside the memo so its dependencies are the primitive registry,
    // context, and selection revisions rather than a frozen JSON object whose
    // immutability React's compiler cannot infer.
    const sortValue = hostOptionCatalog
      .resolveOptions(LIBRARY_SORT_MODES_CATALOGUE)
      .find((mode) => mode.id === sortOption)?.value;
    return filtered.sort((a, b) =>
      compareAssetsBySortValue(sortValue, a, b),
    );
  }, [
    assets,
    families,
    activeTab,
    assetBrowserDisplay,
    effectiveFamilyScope,
    scopedFamilyAssets,
    sortOption,
    sortModeRevision,
    sortContextRevision,
    showFavouritesOnly,
  ]);

  // Wave-2 browser background menu (plan §3.5, `library.browser.context`):
  // import, filter, and sort as descriptor items; extension placements merge
  // into the trailing group. State-coupled handlers stay `action` items.
  // Background only: asset cards and interactive descendants keep their own
  // context behaviour (and inputs keep the native menu), mirroring the
  // asset-card exclusion in `handleBrowserBackgroundClick`.
  const showContextMenu = useHostContextMenu();
  const handleBrowserContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        '[data-testid="asset-card"], button, input, textarea, select, a, [role="button"], [role="tab"]',
      )
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    showContextMenu({
      menuId: "library.browser.context",
      subject: {
        slot: "library.browser.context",
        browser: {
          assetType: activeTab,
          assetCount: sortedAssets.length,
          showFavouritesOnly,
          sortOption,
        },
      },
      items: [
        {
          kind: "action",
          id: "import-assets",
          label: "Import assets…",
          group: "1_import",
          icon: <UploadFileIcon fontSize="small" />,
          disabled: isUploading,
          run: () => fileInputRef.current?.click(),
        },
        {
          kind: "action",
          id: "favourites-only",
          label: "Show favourites only",
          group: "2_filter",
          selected: showFavouritesOnly,
          run: () => setShowFavouritesOnly((current) => !current),
        },
        ...sortModes.map(
          (mode, index): HostMenuItemDescriptor => ({
            kind: "action",
            id: `sort-${mode.id}`,
            label: mode.label,
            group: "3_sort",
            order: index,
            selected: sortOption === mode.id,
            run: () => setSortOption(mode.id),
          }),
        ),
        ...(missingSortModeItem ? [missingSortModeItem] : []),
      ],
      position: { x: event.clientX, y: event.clientY },
    });
  };

  const handleShowFamily = (familyId: string) => {
    setFamilyScope({
      familyId,
      assetType: activeTab,
    });
  };

  const handleDeleteAll = React.useCallback(
    (familyId: string) => {
      const familyAssetIds = getAssetsForFamilyId(assets, familyId).map(
        (asset) => asset.id,
      );
      const timelineClipCount = familyAssetIds.reduce(
        (count, assetId) => count + getTimelineClipCountForAsset(assetId),
        0,
      );

      void deleteAssetBatchWithConfirmation({
        assetIds: familyAssetIds,
        deleteAsset,
        timelineClipCount,
      });
    },
    [assets, deleteAsset],
  );

  const handleClearFamilyScope = () => setFamilyScope(null);
  const isFamilyScopeActive = Boolean(effectiveFamilyScope);
  const emptyStateMessage = isFamilyScopeActive
    ? `No ${activeTab} assets in this family.`
    : `No ${activeTab} assets.`;
  const isMultiSelectActive = selectedAssetIds.length > 1;
  const visibleAssetIds = useMemo(
    () => new Set(sortedAssets.map((asset) => asset.id)),
    [sortedAssets],
  );

  React.useEffect(() => {
    if (selectedAssetIds.length === 0) {
      return;
    }

    const nextSelectedAssetIds = selectedAssetIds.filter((assetId) =>
      visibleAssetIds.has(assetId),
    );

    if (nextSelectedAssetIds.length === selectedAssetIds.length) {
      return;
    }

    setSelectedAssetIds(nextSelectedAssetIds);

    if (nextSelectedAssetIds.length === 0) {
      selectTimelineClip(null);
    }
  }, [selectedAssetIds, setSelectedAssetIds, visibleAssetIds]);

  React.useEffect(() => {
    if (selectedAssetIds.length === 0) {
      return;
    }

    const selectedAssetIdSet = new Set(selectedAssetIds);
    const nextSelectedClipIds = timelineClips
      .filter(
        (clip) => isAssetBackedClip(clip) && selectedAssetIdSet.has(clip.assetId),
      )
      .map((clip) => clip.id);
    const selectedClipIds = getSelectedTimelineClipIds();

    if (
      selectedClipIds.length === nextSelectedClipIds.length &&
      selectedClipIds.every(
        (clipId, index) => clipId === nextSelectedClipIds[index],
      )
    ) {
      return;
    }

    selectTimelineClip(null);
    nextSelectedClipIds.forEach((clipId) => {
      selectTimelineClip(clipId, true);
    });
  }, [selectedAssetIds, timelineClips]);

  React.useEffect(() => {
    if (selectedAssetIds.length === 0) {
      return;
    }

    function handleWindowMouseDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (
        target.closest('[data-testid="asset-browser"]') ||
        target.closest('[role="dialog"]') ||
        target.closest('[role="menu"]')
      ) {
        return;
      }

      clearSelectedAssets();
      selectTimelineClip(null);
    }

    window.addEventListener("mousedown", handleWindowMouseDown);
    return () => window.removeEventListener("mousedown", handleWindowMouseDown);
  }, [clearSelectedAssets, selectedAssetIds]);

  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        useEditorFocusStore.getState().region !== "assetBrowser" ||
        selectedAssetIds.length === 0 ||
        event.defaultPrevented ||
        isDeletingSelectedAssetsRef.current
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

      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest('[role="dialog"]') || target.closest('[role="menu"]'))
      ) {
        return;
      }

      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      isDeletingSelectedAssetsRef.current = true;

      const assetIdsToDelete = [...selectedAssetIds];

      void (async () => {
        let remainingAssetIds: string[] = [];

        try {
          for (let index = 0; index < assetIdsToDelete.length; index += 1) {
            const assetId = assetIdsToDelete[index];
            const assetStillExists = assets.some((asset) => asset.id === assetId);

            if (!assetStillExists) {
              continue;
            }

            const wasDeleted = await deleteAssetWithConfirmation({
              assetId,
              deleteAsset,
              timelineClipCount: getTimelineClipCountForAsset(assetId),
            });

            if (!wasDeleted) {
              remainingAssetIds = assetIdsToDelete.slice(index);
              break;
            }
          }

          setSelectedAssetIds(remainingAssetIds);

          if (remainingAssetIds.length === 0) {
            selectTimelineClip(null);
          }
        } finally {
          isDeletingSelectedAssetsRef.current = false;
        }
      })();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [assets, deleteAsset, selectedAssetIds, setSelectedAssetIds]);

  // Consume reveal requests dispatched from outside the browser. The handler
  // dispatches store mutations (selectAsset / clearRevealRequest) alongside
  // the React state updates, so it has to live in an effect rather than the
  // render body.
  React.useEffect(() => {
    if (!revealRequest) {
      return;
    }

    if (
      useAssetBrowserRevealStore.getState().revealRequest?.requestId !==
      revealRequest.requestId
    ) {
      return;
    }

    const assetToReveal = assets.find(
      (asset) => asset.id === revealRequest.assetId,
    );
    if (!assetToReveal) {
      return;
    }

    if (!isAssetVisibleInBrowser(assetToReveal)) {
      clearRevealRequest(revealRequest.requestId);
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTab(assetToReveal.type);
    setShowFavouritesOnly(false);
    setFamilyScope(resolveFamilyScopeForAsset(assetToReveal, assets, families));
    selectAsset(assetToReveal.id);
    setPendingScrollAssetId(assetToReveal.id);
    clearRevealRequest(revealRequest.requestId);
  }, [assets, clearRevealRequest, families, revealRequest, selectAsset]);

  React.useEffect(() => {
    if (!pendingScrollAssetId || !visibleAssetIds.has(pendingScrollAssetId)) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      gridApiRef.current?.scrollToItemId(pendingScrollAssetId);
      setPendingScrollAssetId(null);
    });

    return () => cancelAnimationFrame(frameId);
  }, [pendingScrollAssetId, visibleAssetIds]);

  const handleAssetSelect = React.useCallback(
    (assetId: string, event: React.MouseEvent<HTMLDivElement>) => {
      const isMulti = event.ctrlKey || event.metaKey;

      if (isMulti) {
        const nextSelectedAssetIds = selectedAssetIds.includes(assetId)
          ? selectedAssetIds.filter((id) => id !== assetId)
          : [...selectedAssetIds, assetId];

        setSelectedAssetIds(nextSelectedAssetIds);

        if (nextSelectedAssetIds.length === 0) {
          selectTimelineClip(null);
        }
        return;
      }

      selectAsset(assetId);
    },
    [selectAsset, selectedAssetIds, setSelectedAssetIds],
  );

  const previewIndex = React.useMemo(
    () =>
      previewAssetId
        ? sortedAssets.findIndex((asset) => asset.id === previewAssetId)
        : -1,
    [previewAssetId, sortedAssets],
  );
  const handleRequestPreview = React.useCallback((assetId: string) => {
    setPreviewAssetId(assetId);
  }, []);

  const handleClosePreview = React.useCallback(() => {
    setPreviewAssetId(null);
  }, []);

  const previewNavigationRef = React.useRef({
    assetIds: [] as string[],
    previewIndex: -1,
  });
  React.useEffect(() => {
    previewNavigationRef.current = {
      assetIds: sortedAssets.map((asset) => asset.id),
      previewIndex,
    };
  }, [previewIndex, sortedAssets]);

  const handlePreviewPrev = React.useCallback(() => {
    const navigation = previewNavigationRef.current;
    if (navigation.previewIndex > 0) {
      setPreviewAssetId(navigation.assetIds[navigation.previewIndex - 1]);
    }
  }, []);

  const handlePreviewNext = React.useCallback(() => {
    const navigation = previewNavigationRef.current;
    if (
      navigation.previewIndex >= 0 &&
      navigation.previewIndex < navigation.assetIds.length - 1
    ) {
      setPreviewAssetId(navigation.assetIds[navigation.previewIndex + 1]);
    }
  }, []);

  React.useEffect(() => {
    if (!previewAssetId) {
      return;
    }

    const asset = useAssetStore
      .getState()
      .assets.find((candidate) => candidate.id === previewAssetId);
    if (!asset) {
      return;
    }

    const navigation = previewNavigationRef.current;
    void openAssetInMiniEditor(asset, {
      openerId: ASSET_BROWSER_MINI_EDITOR_OPENER_ID,
      presentation: "workspace",
      onClose: handleClosePreview,
      navigation: {
        onPrevious: handlePreviewPrev,
        onNext: handlePreviewNext,
        hasPrevious: navigation.previewIndex > 0,
        hasNext:
          navigation.previewIndex >= 0 &&
          navigation.previewIndex < navigation.assetIds.length - 1,
      },
    });
  }, [
    handleClosePreview,
    handlePreviewNext,
    handlePreviewPrev,
    previewAssetId,
  ]);

  React.useEffect(() => {
    if (!previewAssetId) return;

    useMiniEditorStore.getState().setNavigationState(
      ASSET_BROWSER_MINI_EDITOR_OPENER_ID,
      {
        onPrevious: handlePreviewPrev,
        onNext: handlePreviewNext,
        hasPrevious: previewIndex > 0,
        hasNext: previewIndex >= 0 && previewIndex < sortedAssets.length - 1,
      },
    );
  }, [
    handlePreviewNext,
    handlePreviewPrev,
    previewAssetId,
    previewIndex,
    sortedAssets,
  ]);

  React.useEffect(() => {
    if (
      !previewAssetId ||
      assets.some((candidate) => candidate.id === previewAssetId)
    ) {
      return;
    }
    const invalidAssetId = previewAssetId;
    void invalidateMiniEditorWorkspaceAsset(invalidAssetId).then((closed) => {
      if (closed) return;
      setPreviewAssetId((current) =>
        current === invalidAssetId ? null : current,
      );
    });
  }, [assets, previewAssetId]);

  const handleBrowserBackgroundClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target;

      if (target instanceof Element && target.closest('[data-testid="asset-card"]')) {
        return;
      }

      clearSelectedAssets();
      selectTimelineClip(null);
    },
    [clearSelectedAssets],
  );

  return (
    <Box
      data-testid="asset-browser"
      {...assetBrowserFocusProps}
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        position: "relative",
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onContextMenu={handleBrowserContextMenu}
    >
      {/* 1. Combined Header Row */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          // Removed borderBottom here as requested
          minHeight: 48,
          px: 1,
          bgcolor: "#121212",
          position: "relative",
          zIndex: 1,
        }}
      >
        {/* Left: Tabs (Compact) */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            minWidth: 0,
            gap: 1,
          }}
        >
          {isFamilyScopeActive ? (
            <Tooltip title="Back to all assets">
              <IconButton
                aria-label="Back to all assets"
                onClick={handleClearFamilyScope}
                size="small"
                sx={{ color: "#c9d1d9", flexShrink: 0 }}
              >
                <ArrowBackIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}

          <Tabs
            value={activeTab}
            onChange={handleTabChange}
            textColor="primary"
            indicatorColor="primary"
            sx={{
              minHeight: 48,
              "& .MuiTab-root": {
                minWidth: 50,
                minHeight: 48,
                px: 2, // Tighter horizontal padding on tabs
              },
            }}
          >
            <Tab
              icon={<VideoLibraryIcon fontSize="small" />}
              value="video"
              aria-label="Videos"
              data-testid="asset-browser-tab-video"
            />
            <Tab
              icon={<PhotoLibraryIcon fontSize="small" />}
              value="image"
              aria-label="Images"
              data-testid="asset-browser-tab-image"
            />
            <Tab
              icon={<LibraryMusicIcon fontSize="small" />}
              value="audio"
              aria-label="Audio"
              data-testid="asset-browser-tab-audio"
            />
            <Tab
              icon={<GradientIcon fontSize="small" />}
              value="lut"
              aria-label="LUTs"
              data-testid="asset-browser-tab-lut"
            />
          </Tabs>

          {isFamilyScopeActive && selectedFamily ? (
            <Box
              data-testid="asset-browser-family-scope"
              sx={{
                display: { xs: "none", sm: "flex" },
                alignItems: "center",
                gap: 0.75,
                minWidth: 0,
                px: 1.25,
                py: 0.75,
                borderRadius: 999,
                bgcolor: "#1b1b1b",
                border: "1px solid #2b2b2b",
              }}
            >
              <Typography
                variant="caption"
                sx={{
                  color: "#9aa0a6",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                Family
              </Typography>
              <Typography
                variant="caption"
                sx={{
                  color: "#f1f3f4",
                  fontFamily: "monospace",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={selectedFamily.id}
              >
                {selectedFamily.id}
              </Typography>
            </Box>
          ) : null}
        </Box>

        {/* Right: Actions Container */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            bgcolor: "#333", // Distinct background color
            borderRadius: "16px", // Rounded capsule shape
            px: 1,
            py: 0.5,
          }}
        >
          {/* Sort Icon */}
          <Tooltip title="Sort Assets">
            <IconButton
              onClick={handleSortClick}
              size="small"
              sx={{ color: "#aaa" }}
              data-testid="asset-browser-sort-button"
            >
              <SortIcon fontSize="small" />
            </IconButton>
          </Tooltip>

          <Tooltip
            title={showFavouritesOnly ? "Show all assets" : "Show favourites"}
          >
            <IconButton
              onClick={() => setShowFavouritesOnly((current) => !current)}
              size="small"
              aria-label={
                showFavouritesOnly ? "Show all assets" : "Show favourite assets"
              }
              aria-pressed={showFavouritesOnly}
              sx={{ color: showFavouritesOnly ? "#ff4d4f" : "#aaa" }}
            >
              {showFavouritesOnly ? (
                <FavoriteIcon fontSize="small" />
              ) : (
                <FavoriteBorderIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>

          {/* Sort Menu — options from the library.sort-modes catalogue */}
          <AppMenu
            menuId="library.sort.options"
            subject={{
              slot: "library.sort.options",
              browser: { sortOption },
            }}
            items={[
              ...sortModes.map((mode, index) => ({
                kind: "action" as const,
                id: `sort-${mode.id}`,
                label: mode.label,
                group: "1_sort",
                order: index,
                selected: sortOption === mode.id,
                run: () => setSortOption(mode.id),
              })),
              ...(missingSortModeItem
                ? [{ ...missingSortModeItem, group: "1_sort" }]
                : []),
            ]}
            open={Boolean(sortAnchorEl)}
            onClose={() => setSortAnchorEl(null)}
            anchorEl={sortAnchorEl}
            slotProps={{
              paper: { sx: { bgcolor: "#333", color: "white" } },
            }}
          />

          {/* Upload Icon */}
          <input
            type="file"
            hidden
            data-testid="hidden-file-input"
            ref={fileInputRef}
            onChange={handleFileSelect}
            accept="video/*,image/*,audio/*,.cube"
            multiple
          />
          <Tooltip title="Import Asset">
            <span>
              <IconButton
                aria-label="Import Asset"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                size="small"
                sx={{
                  // Bright blue color to stand out, similar to the old primary button
                  color: isUploading ? "#666" : "#4dabf5",
                }}
              >
                {isUploading ? (
                  <CircularProgress size={20} color="inherit" />
                ) : (
                  <UploadFileIcon fontSize="small" />
                )}
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Box>

      {/* 2. Scrollable Grid Area */}
      <LibraryBrowserGrid
        items={sortedAssets}
        getItemId={(asset) => asset.id}
        emptyMessage={emptyStateMessage}
        scrollRegionRef={scrollRegionRef}
        apiRef={gridApiRef}
        pinnedItemId={pinnedAssetId}
        testId="asset-browser-scroll-region"
        isScrollLocked={isAssetDragActive}
        onBackgroundClick={handleBrowserBackgroundClick}
        renderItem={(asset) => (
          <AssetCard
            asset={asset}
            disableDrag={isMultiSelectActive}
            isSelected={selectedAssetIds.includes(asset.id)}
            onDeleteAll={
              !isFamilyScopeActive &&
              asset.familyId &&
              getAssetsForFamilyId(assets, asset.familyId).length > 1
                ? handleDeleteAll
                : undefined
            }
            onShowFamily={
              assetBrowserDisplay !== "ungrouped" &&
              !isFamilyScopeActive &&
              asset.familyId &&
              (familyMembersByType.get(`${asset.familyId}:${asset.type}`) ?? 0) >
                1
                ? handleShowFamily
                : undefined
            }
            onSelect={(event) => handleAssetSelect(asset.id, event)}
            onRequestPreview={handleRequestPreview}
          />
        )}
      />

      {(isUploading || isDragOver) && (
        <Box
          aria-label={
            isUploading ? "Importing assets overlay" : "Drop assets overlay"
          }
          data-testid={
            isUploading
              ? "asset-browser-upload-overlay"
              : "asset-browser-drop-overlay"
          }
          sx={{
            position: "absolute",
            inset: 0,
            zIndex: 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            bgcolor: isUploading
              ? "rgba(18, 18, 18, 0.72)"
              : "rgba(77, 171, 245, 0.14)",
            border: isDragOver && !isUploading ? "2px dashed #4dabf5" : "none",
            pointerEvents: "none",
          }}
        >
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 1.5,
              px: 3,
              py: 2,
              borderRadius: 2,
              bgcolor: "rgba(18, 18, 18, 0.92)",
            }}
          >
            {isUploading ? (
              <>
                <CircularProgress size={32} />
                <Typography variant="body2">Importing assets...</Typography>
              </>
            ) : (
              <Typography variant="body2">Drop files to import</Typography>
            )}
          </Box>
        </Box>
      )}

    </Box>
  );
}

export const AssetBrowser = memo(AssetBrowserComponent);
