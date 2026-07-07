import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useSyncExternalStore,
} from "react";
import { Alert, Box, Button, Divider, Menu, MenuItem } from "@mui/material";
import { Add } from "@mui/icons-material";
import { isAssetBackedClip } from "../../../types/TimelineTypes";
import { useTransformationController } from "../hooks/useTransformationController";
import {
  getAddableTransforms,
  getLayoutGroupsForTransform,
  getLabelForTransform,
  getMissingExtensionTransformationId,
  isDefaultTransform,
  getDefaultTransforms,
  isTransformCompatible,
} from "../catalogue/TransformationRegistry";
import { TransformationGroup } from "./TransformationGroup";
import { TransformationSection } from "./TransformationSection";
import { SortableTransformationItem } from "./SortableTransformationItem";
import { DefaultTransformationSections } from "./DefaultTransformationSections";
import { AdjustmentDepthSection } from "./AdjustmentDepthSection";
import {
  useTimelineClip,
  parseMaskClipId,
  useMaskClipsForParent,
} from "../../timeline";
import { getExtensionTimelineClipMasks } from "../../timeline/api";
import { toExtensionAssetSnapshot, useAsset } from "../../userAssets/api";
import { useAssetStore } from "../../userAssets/useAssetStore";
import { useActiveTransformationSection } from "../hooks/useActiveTransformationSection";
import { useTransformationViewStore } from "../store/useTransformationViewStore";
import { useMaskViewStore } from "../../masks/store/useMaskViewStore";
import {
  canCreateTrackingPathFromMask,
  createPositionPathFromMaskTracking,
} from "../../masks/utils/maskTracking";
import { commitTrackingPositionPath } from "../../tracking/positionPathCommit";
import { getTransformLayerDomain } from "../utils/layerDomain";
import {
  getDynamicSectionId,
  getSectionGroupKeyframeColor,
} from "../utils/sectionKeyframes";
import { getDefaultTransformationSectionModels } from "../utils/defaultSectionModels";
import type {
  PositionTransform,
  SplineParameter,
} from "../types";
import { PositionPathDetailView } from "./PositionPathDetailView";
import { ExtensionSpatialPathDetailView } from "./ExtensionSpatialPathDetailView";
import {
  ExtensionEntityInspector,
  extensionEntityProviderRegistry,
} from "../../extensions/entities/publicApi";
import { ExtensionUiSlot } from "../../extensions/ui/publicApi";
import { extensionTransformationRegistry } from "../extensions/ExtensionTransformationRegistry";
import {
  CORE_MONOTONE_INTERPOLATION_ID,
  extensionSpatialPathRegistry,
  type RegisteredSpatialPath,
} from "../animation";

// DnD Kit Imports
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

export function TransformationPanel() {
  const transformationRegistryRevision = useSyncExternalStore(
    (listener) => extensionTransformationRegistry.subscribe(listener),
    () => extensionTransformationRegistry.getRevision(),
    () => extensionTransformationRegistry.getRevision(),
  );
  const entityProviderRevision = useSyncExternalStore(
    (listener) => extensionEntityProviderRegistry.subscribe(listener),
    () => extensionEntityProviderRegistry.getRevision(),
    () => extensionEntityProviderRegistry.getRevision(),
  );
  useSyncExternalStore(
    (listener) => extensionSpatialPathRegistry.subscribe(listener),
    () => extensionSpatialPathRegistry.getRevision(),
    () => extensionSpatialPathRegistry.getRevision(),
  );
  const {
    selectedClipId,
    activeTargetKind,
    activeContextId,
    activeTransforms,
    activeTimelineClip,
    setActiveTransforms,
    updateActiveTransform,
    handleAddTransform,
    handleRemoveTransform,
    handleSetTransformEnabled,
    handleSetDefaultGroupsEnabled,
    handleCommit,
    handleReorder,
    captureActiveTargetSnapshot,
    restoreTargetSnapshot,
  } = useTransformationController();

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [pathMenuAnchorEl, setPathMenuAnchorEl] =
    useState<HTMLElement | null>(null);
  const [pathTrackingError, setPathTrackingError] = useState<string | null>(null);
  const [isCreatingPathFromMask, setIsCreatingPathFromMask] = useState(false);
  const [activeDragId, setActiveDragId] = useState<UniqueIdentifier | null>(
    null,
  );
  const pathPanelView = useTransformationViewStore((state) => state.pathPanelView);
  const armedPathRecording = useTransformationViewStore(
    (state) => state.armedPathRecording,
  );
  const activePathEditor = useTransformationViewStore(
    (state) => state.activePathEditor,
  );
  const setPathPanelView = useTransformationViewStore(
    (state) => state.setPathPanelView,
  );
  const setArmedPathRecording = useTransformationViewStore(
    (state) => state.setArmedPathRecording,
  );
  const setActivePathEditor = useTransformationViewStore(
    (state) => state.setActivePathEditor,
  );

  const selectedClip = useTimelineClip(selectedClipId);
  const maskClipsForTrackingInvalidation =
    useMaskClipsForParent(selectedClipId);
  const assetsForTrackingInvalidation = useAssetStore((state) => state.assets);
  const trackingAssetLookup = useMemo(
    () =>
      Object.freeze({
        get: (assetId: string) => {
          const asset = assetsForTrackingInvalidation.find(
            (candidate) => candidate.id === assetId,
          );
          return asset ? toExtensionAssetSnapshot(asset) : undefined;
        },
      }),
    [assetsForTrackingInvalidation],
  );
  const selectedMaskIdForTracking = useMaskViewStore((state) =>
    selectedClipId
      ? (state.selectedMaskByClipId[selectedClipId] ?? null)
      : null,
  );
  const domainClip = activeTimelineClip ?? selectedClip;
  const extensionAvailability =
    selectedClip?.type === "extension"
      ? extensionEntityProviderRegistry.getAvailability(
          selectedClip.extensionPayload,
        )
      : null;
  void entityProviderRevision;
  const extensionEntityProvider =
    selectedClip?.type === "extension"
      ? extensionEntityProviderRegistry.get(selectedClip.extensionPayload)
      : undefined;
  const hasActiveExtensionInspector =
    extensionAvailability === "available" &&
    extensionEntityProvider?.definition.inspector !== undefined;
  const positionTransform = useMemo(
    () =>
      activeTransforms.find(
        (transform) => transform.type === "position",
      ) as PositionTransform | undefined,
    [activeTransforms],
  );
  const positionPath = positionTransform?.parameters.path ?? null;
  const extensionPositionPath =
    positionTransform?.parameters.extensionPath ?? null;
  const activePositionPath = extensionPositionPath ?? positionPath;
  const trackingMask = useMemo(() => {
    void maskClipsForTrackingInvalidation;
    if (!selectedClipId) return null;
    const masks = getExtensionTimelineClipMasks(selectedClipId);
    const selected = selectedMaskIdForTracking
      ? (masks.find((mask) => mask.localId === selectedMaskIdForTracking) ??
        null)
      : null;
    if (
      selected &&
      canCreateTrackingPathFromMask(selected, trackingAssetLookup)
    ) {
      return selected;
    }
    return masks.find((mask) =>
      canCreateTrackingPathFromMask(mask, trackingAssetLookup),
    ) ?? null;
  }, [
    maskClipsForTrackingInvalidation,
    selectedClipId,
    selectedMaskIdForTracking,
    trackingAssetLookup,
  ]);

  // Get the asset for the selected clip to check hasAudio
  const selectedAssetId = isAssetBackedClip(selectedClip)
    ? selectedClip.assetId
    : undefined;
  const clipAsset = useAsset(selectedAssetId);
  const compatibilityClipType =
    activeTargetKind === "mask" ? "shape" : (selectedClip?.type ?? "shape");
  const compatibilityHasAudio =
    activeTargetKind === "mask" ? false : clipAsset?.hasAudio;

  const [expandedStates, setExpandedStates] = useState<Record<string, boolean>>(
    {},
  );

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedStates((prev) => ({
      ...prev,
      [id]: !(prev[id] ?? true),
    }));
  }, []);

  // Filter transformations based on clip compatibility
  const compatibleDefaultTransforms = useMemo(() => {
    void transformationRegistryRevision;
    return getDefaultTransforms().filter((def) =>
      isTransformCompatible(def, compatibilityClipType, compatibilityHasAudio),
    );
  }, [
    compatibilityClipType,
    compatibilityHasAudio,
    transformationRegistryRevision,
  ]);

  const compatibleAddableTransforms = useMemo(() => {
    void transformationRegistryRevision;
    return getAddableTransforms({
      clipType: compatibilityClipType,
      hasAudio: compatibilityHasAudio,
    });
  }, [
    compatibilityClipType,
    compatibilityHasAudio,
    transformationRegistryRevision,
  ]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const dynamicTransforms = useMemo(
    () => activeTransforms.filter((t) => !isDefaultTransform(t.type)),
    [activeTransforms],
  );

  const itemIds = useMemo(
    () => dynamicTransforms.map((t) => t.id),
    [dynamicTransforms],
  );

  const sectionOrder = useMemo(() => {
    if (!activeContextId) return [];

    return [
      ...getDefaultTransformationSectionModels(
        compatibleDefaultTransforms,
      ).map((section) => section.sectionId),
      ...dynamicTransforms.map((transform) => getDynamicSectionId(transform.id)),
    ];
  }, [activeContextId, compatibleDefaultTransforms, dynamicTransforms]);

  const getLayerDomain = useCallback(
    (transformId?: string) => getTransformLayerDomain(domainClip, transformId),
    [domainClip],
  );

  const { activeSectionId, activateSection } = useActiveTransformationSection(
    activeContextId,
    sectionOrder,
  );

  useEffect(() => {
    // Mask-owned armed/editor state lives in the same shared store but is
    // managed by the mask panel. Don't touch it from here even when the
    // selected clip is the mask's parent — otherwise we race-clear what the
    // mask panel just wrote.
    const isArmedForMask =
      armedPathRecording !== null &&
      parseMaskClipId(armedPathRecording.clipId) !== null;
    const isEditingMaskPath =
      activePathEditor !== null &&
      parseMaskClipId(activePathEditor.clipId) !== null;

    if (!selectedClipId) {
      if (pathPanelView !== "home") {
        setPathPanelView("home");
      }
      if (armedPathRecording !== null && !isArmedForMask) {
        setArmedPathRecording(null);
      }
      if (activePathEditor !== null && !isEditingMaskPath) {
        setActivePathEditor(null);
      }
      return;
    }

    if (
      armedPathRecording !== null &&
      armedPathRecording.clipId !== selectedClipId &&
      !isArmedForMask
    ) {
      setArmedPathRecording(null);
    }

    if (
      activePathEditor !== null &&
      activePathEditor.clipId !== selectedClipId &&
      !isEditingMaskPath
    ) {
      setPathPanelView("home");
      setActivePathEditor(null);
    }

    if (!positionPath && pathPanelView === "path" && !isEditingMaskPath) {
      setPathPanelView("home");
      if (!isEditingMaskPath) {
        setActivePathEditor(null);
      }
    }
  }, [
    activePathEditor,
    armedPathRecording,
    pathPanelView,
    positionPath,
    selectedClipId,
    setActivePathEditor,
    setArmedPathRecording,
    setPathPanelView,
  ]);

  // --- Handlers ---

  const handleOpenAddMenu = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleCloseAddMenu = () => {
    setAnchorEl(null);
  };

  const onAddTransform = (typeOrName: string, isFilter: boolean) => {
    handleAddTransform(typeOrName, isFilter);
    handleCloseAddMenu();
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      setActiveDragId(null);
      return;
    }
    handleReorder(active.id, over.id);
    setActiveDragId(null);
  };

  const handleDragStart = (event: { active: { id: UniqueIdentifier } }) => {
    setActiveDragId(event.active.id);
  };

  const handleStartRecording = useCallback(() => {
    if (!selectedClipId) return;
    setPathMenuAnchorEl(null);
    setPathPanelView("home");
    setActivePathEditor(null);
    setPathTrackingError(null);
    setArmedPathRecording({
      clipId: selectedClipId,
      transformId: positionTransform?.id ?? null,
    });
  }, [
    positionTransform?.id,
    selectedClipId,
    setActivePathEditor,
    setArmedPathRecording,
    setPathPanelView,
  ]);

  const handleCancelRecording = useCallback(() => {
    setArmedPathRecording(null);
  }, [setArmedPathRecording]);

  const handleCreatePathFromMask = useCallback(async () => {
    setPathMenuAnchorEl(null);
    if (!selectedClipId || !trackingMask) return;

    setIsCreatingPathFromMask(true);
    setPathTrackingError(null);
    try {
      const { createNativeTrackingExtensionApis } = await import(
        "../../tracking/extensionApi"
      );
      const trackingExtensionApis = createNativeTrackingExtensionApis();
      const path = await createPositionPathFromMaskTracking({
        timeline: trackingExtensionApis.timeline,
        assets: trackingExtensionApis.assets,
        clipId: selectedClipId,
        mask: trackingMask,
      });
      if (!path) {
        setPathTrackingError("Mask tracking did not find enough motion.");
        return;
      }

      const commit = commitTrackingPositionPath({
        timeline: trackingExtensionApis.timeline,
        clipId: selectedClipId,
        path,
      });
      if (!commit.ok) {
        setPathTrackingError(commit.message);
        return;
      }

      setArmedPathRecording(null);
      setActivePathEditor({
        clipId: selectedClipId,
        transformId: commit.transformId,
      });
      setPathPanelView("path");
    } catch (error) {
      setPathTrackingError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCreatingPathFromMask(false);
    }
  }, [
    selectedClipId,
    setActivePathEditor,
    setArmedPathRecording,
    setPathPanelView,
    trackingMask,
  ]);

  const handleOpenPathEditor = useCallback(() => {
    if (!selectedClipId || !positionTransform || !activePositionPath) return;
    setArmedPathRecording(null);
    setActivePathEditor({
      clipId: selectedClipId,
      transformId: positionTransform.id,
    });
    setPathPanelView("path");
  }, [
    activePositionPath,
    positionTransform,
    selectedClipId,
    setActivePathEditor,
    setArmedPathRecording,
    setPathPanelView,
  ]);

  const handleBackFromPathEditor = useCallback(() => {
    setPathPanelView("home");
    setActivePathEditor(null);
  }, [setActivePathEditor, setPathPanelView]);

  const handleRemovePath = useCallback(() => {
    if (!positionTransform || !activePositionPath) return;
    const nextParameters = { ...positionTransform.parameters };
    delete nextParameters.path;
    delete nextParameters.extensionPath;
    updateActiveTransform(positionTransform.id, { parameters: nextParameters });
    setArmedPathRecording(null);
    setActivePathEditor(null);
    setPathPanelView("home");
  }, [
    activePositionPath,
    positionTransform,
    setActivePathEditor,
    setArmedPathRecording,
    setPathPanelView,
    updateActiveTransform,
  ]);

  const handlePathTimingChange = useCallback(
    (nextTiming: SplineParameter) => {
      if (!positionTransform || !positionPath) return;
      updateActiveTransform(positionTransform.id, {
        parameters: {
          ...positionTransform.parameters,
          path: {
            ...positionPath,
            timing: nextTiming,
          },
        },
      });
    },
    [positionPath, positionTransform, updateActiveTransform],
  );

  const handleExtensionPathChange = useCallback(
    (nextPath: NonNullable<PositionTransform["parameters"]["extensionPath"]>) => {
      if (!positionTransform || !extensionPositionPath) return;
      updateActiveTransform(positionTransform.id, {
        parameters: {
          ...positionTransform.parameters,
          extensionPath: nextPath,
        },
      });
    },
    [extensionPositionPath, positionTransform, updateActiveTransform],
  );

  const extensionPathProviders = extensionSpatialPathRegistry
    .list()
    .filter(({ ownerId }) => ownerId !== "vlo.core");

  const handleCreateExtensionPath = useCallback(
    (provider: RegisteredSpatialPath) => {
      setPathMenuAnchorEl(null);
      if (!positionTransform) return;
      const separator = CORE_MONOTONE_INTERPOLATION_ID.indexOf("/");
      updateActiveTransform(positionTransform.id, {
        parameters: {
          ...positionTransform.parameters,
          extensionPath: {
            type: "extension-path2d",
            geometry: {
              extensionId: provider.ownerId,
              typeId: provider.localId,
              schemaVersion: provider.definition.schemaVersion,
              data: structuredClone(provider.definition.defaultData),
            },
            timing: {
              type: "extension-keyframed-scalar",
              keyframes: [
                {
                  time: 0,
                  value: 0,
                  outgoing: {
                    extensionId: CORE_MONOTONE_INTERPOLATION_ID.slice(0, separator),
                    typeId: CORE_MONOTONE_INTERPOLATION_ID.slice(separator + 1),
                    schemaVersion: 1,
                    data: null,
                  },
                },
                { time: 1, value: 1 },
              ],
            },
          },
        },
      });
    },
    [positionTransform, updateActiveTransform],
  );

  const positionGroupHeaderActions = useMemo(() => {
    if (!selectedClipId) {
      return null;
    }

    const commonButtonSx = {
      minWidth: 0,
      px: 0.75,
      py: 0.25,
      textTransform: "none",
      fontSize: "0.7rem",
      lineHeight: 1.2,
    };

    if (armedPathRecording?.clipId === selectedClipId) {
      return (
        <Button
          size="small"
          color="warning"
          onClick={handleCancelRecording}
          sx={commonButtonSx}
        >
          Cancel Recording
        </Button>
      );
    }

    if (!activePositionPath) {
      return (
        <Box sx={{ display: "flex", gap: 0.5 }}>
          <Button
            size="small"
            onClick={(event) => setPathMenuAnchorEl(event.currentTarget)}
            sx={commonButtonSx}
            disabled={isCreatingPathFromMask}
          >
            Add Path
          </Button>
          <Menu
            anchorEl={pathMenuAnchorEl}
            open={Boolean(pathMenuAnchorEl)}
            onClose={() => setPathMenuAnchorEl(null)}
          >
            <MenuItem onClick={handleStartRecording}>From Drag</MenuItem>
            <MenuItem
              onClick={() => void handleCreatePathFromMask()}
              disabled={!trackingMask || isCreatingPathFromMask}
            >
              From Mask
            </MenuItem>
            {positionTransform && extensionPathProviders.length > 0 ? (
              <Divider />
            ) : null}
            {positionTransform &&
              extensionPathProviders.map((provider) => (
                <MenuItem
                  key={provider.id}
                  onClick={() => handleCreateExtensionPath(provider)}
                >
                  {provider.definition.label}
                </MenuItem>
              ))}
          </Menu>
        </Box>
      );
    }

    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}>
        <Button size="small" onClick={handleOpenPathEditor} sx={commonButtonSx}>
          Edit Path
        </Button>
        {!extensionPositionPath && (
          <Button size="small" onClick={handleStartRecording} sx={commonButtonSx}>
            Re-record
          </Button>
        )}
        <Button
          size="small"
          color="error"
          onClick={handleRemovePath}
          sx={commonButtonSx}
        >
          Remove Path
        </Button>
      </Box>
    );
  }, [
    armedPathRecording?.clipId,
    handleCancelRecording,
    handleCreatePathFromMask,
    handleCreateExtensionPath,
    handleOpenPathEditor,
    handleRemovePath,
    handleStartRecording,
    activePositionPath,
    extensionPathProviders,
    extensionPositionPath,
    isCreatingPathFromMask,
    pathMenuAnchorEl,
    positionTransform,
    selectedClipId,
    trackingMask,
  ]);

  const getDefaultGroupProps = useCallback(
    (groupId: string) => {
      if (groupId !== "position") {
        return {};
      }

      return {
        disabled: Boolean(activePositionPath),
        disableKeyframe: Boolean(activePositionPath),
        headerActions: positionGroupHeaderActions,
      };
    },
    [activePositionPath, positionGroupHeaderActions],
  );

  const isPathEditorOpen =
    pathPanelView === "path" &&
    !!selectedClipId &&
    !!positionTransform &&
    !!activePositionPath &&
    activePathEditor?.clipId === selectedClipId &&
    activePathEditor.transformId === positionTransform.id;

  if (!selectedClipId) return null;

  if (isPathEditorOpen && activePositionPath) {
    return (
      <Box
        data-testid="transformation-panel"
        sx={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          width: "100%",
          overflowY: "auto",
        }}
      >
        {extensionPositionPath ? (
          <ExtensionSpatialPathDetailView
            path={extensionPositionPath}
            duration={domainClip?.timelineDuration ?? 0}
            onChange={handleExtensionPathChange}
            onBack={handleBackFromPathEditor}
            onRemove={handleRemovePath}
          />
        ) : positionPath ? (
          <PositionPathDetailView
            path={positionPath}
            onBack={handleBackFromPathEditor}
            onTimingChange={handlePathTimingChange}
            onRemove={handleRemovePath}
            onRerecord={handleStartRecording}
          />
        ) : null}
      </Box>
    );
  }

  return (
    <Box
      data-testid="transformation-panel"
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        overflowY: "auto",
      }}
    >
      <Box sx={{ display: "flex", flexDirection: "column" }}>
        <ExtensionUiSlot slot="transformation-panel.before" />
        {pathTrackingError ? (
          <Alert severity="warning" sx={{ m: 1 }}>
            {pathTrackingError}
          </Alert>
        ) : null}
        {selectedClip?.type === "extension" ? (
          <>
            <ExtensionEntityInspector clip={selectedClip} />
            {!hasActiveExtensionInspector ? (
              <Alert
                data-testid="extension-inspector-placeholder"
                severity={
                  extensionAvailability === "available" ? "info" : "warning"
                }
                sx={{ m: 1 }}
              >
                {extensionAvailability === "available" ? (
                  <>
                    Extension renderer {selectedClip.extensionPayload.extensionId}/
                    {selectedClip.extensionPayload.typeId} is active. It does not
                    provide custom property UI.
                  </>
                ) : extensionAvailability === "renderer_unavailable" ? (
                  <>
                    Extension payload provider {selectedClip.extensionPayload.extensionId}/
                    {selectedClip.extensionPayload.typeId} is active, but its
                    renderer and property UI are unavailable.
                  </>
                ) : (
                  <>
                    {extensionAvailability === "incompatible"
                      ? "Incompatible"
                      : "Missing"}{" "}
                    extension provider {selectedClip.extensionPayload.extensionId}/
                    {selectedClip.extensionPayload.typeId}. Its data is preserved.
                  </>
                )}
              </Alert>
            ) : null}
          </>
        ) : null}
        {selectedClip?.type === "adjustment" ? (
          <AdjustmentDepthSection clip={selectedClip} />
        ) : null}
        <DefaultTransformationSections
          definitions={compatibleDefaultTransforms}
          activeTransforms={activeTransforms}
          activeContextId={activeContextId}
          activeSectionId={activeSectionId}
          timelineClip={domainClip}
          onCommit={handleCommit}
          onSetDefaultGroupsEnabled={handleSetDefaultGroupsEnabled}
          onUpdateTransform={updateActiveTransform}
          onSetTransforms={setActiveTransforms}
          onActivateSection={activateSection}
          dimmed={!!activeDragId}
          getGroupProps={getDefaultGroupProps}
          captureSnapshot={captureActiveTargetSnapshot}
          restoreSnapshot={restoreTargetSnapshot}
        />

        {/* 2. Dynamic Sections */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={itemIds}
            strategy={verticalListSortingStrategy}
          >
            {dynamicTransforms.map((t, index) => {
              const sectionId = getDynamicSectionId(t.id);
              const isActiveSection = activeSectionId === sectionId;
              const groups = getLayoutGroupsForTransform(t);
              const title = getLabelForTransform(t);

              if (!groups || groups.length === 0) {
                const missingContributionId =
                  getMissingExtensionTransformationId(t);
                return missingContributionId ? (
                  <Alert
                    key={t.id}
                    data-testid="missing-extension-transformation"
                    severity="warning"
                    sx={{ m: 1 }}
                  >
                    Missing transformation {missingContributionId}. Its
                    parameters are preserved.
                  </Alert>
                ) : null;
              }

              const isEven = index % 2 === 0;
              const bgColor = isEven ? "#202024" : "#18181b";

              const domain = getLayerDomain(t.id);

              return (
                <SortableTransformationItem
                  key={t.id}
                  id={t.id}
                  transform={t}
                  groups={groups}
                  title={title}
                  bgColor={bgColor}
                  onRemove={() => handleRemoveTransform(t.id)}
                  onCommit={handleCommit}
                  minTime={domain.minTime}
                  duration={domain.duration}
                  isPanelDragging={!!activeDragId}
                  isOpen={expandedStates[t.id] ?? true}
                  onToggle={() => handleToggleExpand(t.id)}
                  isEnabled={t.isEnabled}
                  onToggleEnabled={(enabled) =>
                    handleSetTransformEnabled(t.id, enabled)
                  }
                  clipId={activeContextId}
                  timelineClip={domainClip}
                  targetTransforms={activeTransforms}
                  onUpdateTransform={updateActiveTransform}
                  onSetTransforms={setActiveTransforms}
                  isActiveSection={isActiveSection}
                  onSectionClick={() => activateSection(sectionId)}
                  keyframeColor={getSectionGroupKeyframeColor(0)}
                  captureSnapshot={captureActiveTargetSnapshot}
                  restoreSnapshot={restoreTargetSnapshot}
                />
              );
            })}
          </SortableContext>

          <DragOverlay>
            {(() => {
              if (!activeDragId) return null;

              const t = dynamicTransforms.find(
                (item) => item.id === activeDragId,
              );
              if (!t) return null;

              const groups = getLayoutGroupsForTransform(t);
              const title = getLabelForTransform(t);

              const bgColor = "#18181b";

              if (!groups || groups.length === 0) return null;

              const domain = getLayerDomain(t.id);

              return (
                <Box sx={{ opacity: 0.9 }}>
                  <TransformationSection
                    title={title}
                    bgColor={bgColor}
                    defaultOpen={true}
                    isDragging={true}
                    dragHandleProps={{}}
                    isOpen={expandedStates[t.id] ?? true}
                    onToggle={() => {}}
                    sectionToggle={{
                      checked: t.isEnabled,
                      onChange: () => {},
                      ariaLabel: `${title} enabled`,
                      disabled: true,
                    }}
                  >
                    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      {groups.map((group) => (
                        <TransformationGroup
                          key={group.id}
                          group={group}
                          transform={t}
                          onCommit={() => {}}
                          minTime={domain.minTime}
                          duration={domain.duration}
                          clipId={activeContextId}
                          timelineClip={domainClip}
                          targetTransforms={activeTransforms}
                          onUpdateTransform={updateActiveTransform}
                          onSetTransforms={setActiveTransforms}
                          keyframeColor={getSectionGroupKeyframeColor(0)}
                          captureSnapshot={captureActiveTargetSnapshot}
                          restoreSnapshot={restoreTargetSnapshot}
                        />
                      ))}
                    </Box>
                  </TransformationSection>
                </Box>
              );
            })()}
          </DragOverlay>
        </DndContext>

        <Box sx={{ mt: 2, px: 2, pb: 2 }}>
          <Button
            data-testid="transformation-add-button"
            fullWidth
            variant="outlined"
            startIcon={<Add />}
            onClick={handleOpenAddMenu}
            sx={{
              borderStyle: "dashed",
              color: "text.secondary",
              borderColor: "divider",
              py: 1,
              textTransform: "none",
              "&:hover": {
                borderColor: "primary.main",
                color: "primary.main",
                bgcolor: "action.hover",
              },
            }}
          >
            Add Transformation
          </Button>

          <Menu
            data-testid="transformation-add-menu"
            anchorEl={anchorEl}
            open={Boolean(anchorEl)}
            onClose={handleCloseAddMenu}
          >
            {compatibleAddableTransforms.map((entry) => (
              <MenuItem
                key={entry.filterName || entry.type}
                onClick={() =>
                  onAddTransform(
                    entry.filterName || entry.type,
                    entry.type === "filter",
                  )
                }
              >
                {entry.label}
              </MenuItem>
            ))}
          </Menu>
        </Box>
      </Box>
    </Box>
  );
}
