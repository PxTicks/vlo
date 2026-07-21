import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { Alert, Box, Button, Typography } from "@mui/material";
import { AppMenu } from "../../../core/shell/AppMenu";
import type { HostMenuItemDescriptor } from "../../../core/shell/menuDescriptors";
import { isAssetBackedClip } from "../../../types/TimelineTypes";
import { useTransformationController } from "../hooks/useTransformationController";
import {
  getEntryForTransform,
  getEntryByFilterName,
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
import type { ExtensionTimelineMaskSnapshot } from "../../extensions/types";
import { ExtensionUiSlot } from "../../extensions/ui/publicApi";
import { extensionTransformationRegistry } from "../extensions/ExtensionTransformationRegistry";
import {
  CORE_MONOTONE_INTERPOLATION_ID,
  extensionSpatialPathRegistry,
  type RegisteredSpatialPath,
} from "../animation";
import { PanelTabs } from "../../panelUI";
import {
  getTransformationDefinitionTab,
  getTransformationTab,
  TRANSFORMATION_TABS,
  type TransformationTabId,
} from "../utils/transformationTabs";

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

function getTrackingMaskMenuLabel(
  mask: ExtensionTimelineMaskSnapshot,
  maskCount: number,
): string {
  if (maskCount <= 1) {
    return "From Mask";
  }
  const label = mask.name.trim() || mask.localId || "Mask";
  return `From Mask: ${label}`;
}

interface TransformationPanelContainerProps {
  readonly effectsOnly: boolean;
  readonly activeTab: TransformationTabId;
  readonly onTabChange: (tab: TransformationTabId) => void;
  readonly children: React.ReactNode;
}

function TransformationPanelContainer({
  effectsOnly,
  activeTab,
  onTabChange,
  children,
}: TransformationPanelContainerProps) {
  if (effectsOnly) return children;
  return (
    <PanelTabs
      ariaLabel="Transformation categories"
      tabs={TRANSFORMATION_TABS}
      value={activeTab}
      onChange={onTabChange}
    >
      {children}
    </PanelTabs>
  );
}

interface TransformationPanelSurfaceProps {
  readonly variant: "transformations" | "effects";
}

export function TransformationPanelSurface({
  variant,
}: TransformationPanelSurfaceProps) {
  const effectsOnly = variant === "effects";
  // Both sidebar views render this surface, and the shell may keep an inactive
  // view mounted, so the variants carry distinct test IDs rather than a shared
  // one that would become ambiguous the moment both are in the DOM.
  const panelTestId = effectsOnly ? "effects-panel" : "adjust-panel";
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
    handleCommitMany,
    handleReorder,
    captureActiveTargetSnapshot,
    restoreTargetSnapshot,
  } = useTransformationController();

  const [activeTab, setActiveTab] =
    useState<TransformationTabId>("display");
  const colorGradeMaterializationRef = useRef<string | null>(null);
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
  const trackableMasks = useMemo(() => {
    void maskClipsForTrackingInvalidation;
    if (!selectedClipId) return [];
    return getExtensionTimelineClipMasks(selectedClipId).filter((mask) =>
      canCreateTrackingPathFromMask(mask, trackingAssetLookup),
    );
  }, [
    maskClipsForTrackingInvalidation,
    selectedClipId,
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
    activeTargetKind === "mask"
      ? false
      : selectedClip?.type === "video"
        ? true
        : clipAsset?.hasAudio;

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

  const colorGradeTransform = useMemo(
    () =>
      dynamicTransforms.find(
        (transform) =>
          transform.type === "filter" &&
          "filterName" in transform &&
          transform.filterName === "ColorGradeFilter",
      ),
    [dynamicTransforms],
  );

  const canUseColorGrade = useMemo(() => {
    const definition = getEntryByFilterName("ColorGradeFilter");
    return (
      activeTargetKind !== "mask" &&
      definition !== undefined &&
      isTransformCompatible(
        definition,
        compatibilityClipType,
        compatibilityHasAudio,
      )
    );
  }, [activeTargetKind, compatibilityClipType, compatibilityHasAudio]);

  useEffect(() => {
    if (effectsOnly) return;
    if (colorGradeTransform) {
      colorGradeMaterializationRef.current = null;
      return;
    }
    if (
      activeTab !== "color" ||
      !activeContextId ||
      !canUseColorGrade ||
      colorGradeMaterializationRef.current === activeContextId
    ) {
      return;
    }

    colorGradeMaterializationRef.current = activeContextId;
    handleAddTransform("ColorGradeFilter", true);
  }, [
    activeContextId,
    activeTab,
    canUseColorGrade,
    colorGradeTransform,
    effectsOnly,
    handleAddTransform,
  ]);

  const visibleDefaultTransforms = useMemo(
    () =>
      effectsOnly
        ? []
        : compatibleDefaultTransforms.filter(
            (definition) =>
              getTransformationDefinitionTab(definition) === activeTab,
          ),
    [activeTab, compatibleDefaultTransforms, effectsOnly],
  );

  const visibleDynamicTransforms = useMemo(
    () =>
      dynamicTransforms.filter((transform) => {
        const definition = getEntryForTransform(transform);
        const isCompatible =
          !definition ||
          isTransformCompatible(
            definition,
            compatibilityClipType,
            compatibilityHasAudio,
          );
        const tab = getTransformationTab(transform);
        return (
          isCompatible &&
          (effectsOnly
            ? tab === "display"
            : tab !== "display" && tab === activeTab)
        );
      }),
    [
      activeTab,
      compatibilityClipType,
      compatibilityHasAudio,
      dynamicTransforms,
      effectsOnly,
    ],
  );

  const itemIds = useMemo(
    () => visibleDynamicTransforms.map((transform) => transform.id),
    [visibleDynamicTransforms],
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
    if (effectsOnly) return;
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
    effectsOnly,
    pathPanelView,
    positionPath,
    selectedClipId,
    setActivePathEditor,
    setArmedPathRecording,
    setPathPanelView,
  ]);

  // --- Handlers ---

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

  const handleCreatePathFromMask = useCallback(async (
    mask: ExtensionTimelineMaskSnapshot,
  ) => {
    setPathMenuAnchorEl(null);
    if (!selectedClipId) return;

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
        mask,
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
          <AppMenu
            menuId="transformations.path.add"
            subject={{
              slot: "transformations.path.add",
              target: {
                clipId: selectedClipId ?? "",
                trackableMaskCount: trackableMasks.length,
              },
            }}
            items={[
              {
                kind: "action",
                id: "from-drag",
                label: "From Drag",
                group: "1_record",
                run: handleStartRecording,
              },
              ...(trackableMasks.length > 0
                ? trackableMasks.map(
                    (mask, index): HostMenuItemDescriptor => ({
                      kind: "action",
                      id: `from-mask-${mask.id}`,
                      label: getTrackingMaskMenuLabel(
                        mask,
                        trackableMasks.length,
                      ),
                      group: "2_masks",
                      order: index,
                      disabled: isCreatingPathFromMask,
                      selected: mask.localId === selectedMaskIdForTracking,
                      run: () => void handleCreatePathFromMask(mask),
                    }),
                  )
                : [
                    {
                      kind: "action",
                      id: "from-mask-none",
                      label: "From Mask",
                      group: "2_masks",
                      disabled: true,
                      run: () => undefined,
                    } satisfies HostMenuItemDescriptor,
                  ]),
              ...(positionTransform
                ? extensionPathProviders.map(
                    (provider, index): HostMenuItemDescriptor => ({
                      kind: "action",
                      id: `provider-${provider.id}`,
                      label: provider.definition.label,
                      group: "3_providers",
                      order: index,
                      run: () => handleCreateExtensionPath(provider),
                    }),
                  )
                : []),
            ]}
            open={Boolean(pathMenuAnchorEl)}
            onClose={() => setPathMenuAnchorEl(null)}
            anchorEl={pathMenuAnchorEl}
          />
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
    selectedMaskIdForTracking,
    trackableMasks,
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

  if (!effectsOnly && isPathEditorOpen && activePositionPath) {
    return (
      <Box
        data-testid={panelTestId}
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
      data-testid={panelTestId}
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        overflowY: "auto",
      }}
    >
      <Box sx={{ display: "flex", flexDirection: "column" }}>
        {!effectsOnly ? (
          <ExtensionUiSlot slot="transformation-panel.before" />
        ) : null}
        {!effectsOnly && pathTrackingError ? (
          <Alert severity="warning" sx={{ m: 1 }}>
            {pathTrackingError}
          </Alert>
        ) : null}
        {!effectsOnly && selectedClip?.type === "extension" ? (
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
        {!effectsOnly && selectedClip?.type === "adjustment" ? (
          <AdjustmentDepthSection clip={selectedClip} />
        ) : null}
        <TransformationPanelContainer
          effectsOnly={effectsOnly}
          activeTab={activeTab}
          onTabChange={setActiveTab}
        >
        <DefaultTransformationSections
          definitions={visibleDefaultTransforms}
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
            {visibleDynamicTransforms.map((t, index) => {
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
                  onRemove={
                    getTransformationTab(t) === "color"
                      ? undefined
                      : () => handleRemoveTransform(t.id)
                  }
                  onCommit={handleCommit}
                  onCommitMany={handleCommitMany}
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

              const t = visibleDynamicTransforms.find(
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

        {visibleDefaultTransforms.length === 0 &&
        visibleDynamicTransforms.length === 0 &&
        !(!effectsOnly && activeTab === "color" && canUseColorGrade) ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ px: 2, py: 3, textAlign: "center" }}
          >
            {effectsOnly
              ? "No effects have been added to this clip."
              : activeTab === "audio"
              ? "No audio controls are available for this clip."
              : activeTab === "speed"
                ? "No speed controls are available for this clip."
              : activeTab === "color"
                ? "No color grading transformations have been added."
                : "No display controls are available for this clip."}
          </Typography>
        ) : null}
        </TransformationPanelContainer>
      </Box>
    </Box>
  );
}

export function TransformationPanel() {
  return <TransformationPanelSurface variant="transformations" />;
}
