import { useState, useMemo, useCallback, useEffect } from "react";
import { Box, Button, Menu, MenuItem } from "@mui/material";
import { Add } from "@mui/icons-material";
import { useTransformationController } from "../hooks/useTransformationController";
import {
  getAddableTransforms,
  getLayoutGroupsForTransform,
  getLabelForTransform,
  isDefaultTransform,
  getDefaultTransforms,
  isTransformCompatible,
} from "../catalogue/TransformationRegistry";
import { TransformationGroup } from "./TransformationGroup";
import { TransformationSection } from "./TransformationSection";
import { SortableTransformationItem } from "./SortableTransformationItem";
import { DefaultTransformationSections } from "./DefaultTransformationSections";
import { useTimelineClip } from "../../timeline";
import { useAsset } from "../../userAssets";
import { useActiveTransformationSection } from "../hooks/useActiveTransformationSection";
import { useTransformationViewStore } from "../store/useTransformationViewStore";
import { getTransformLayerDomain } from "../utils/layerDomain";
import {
  getDefaultSectionId,
  getDynamicSectionId,
  getSectionGroupKeyframeColor,
} from "../utils/sectionKeyframes";
import type { PositionTransform, SplineParameter } from "../types";
import { PositionPathDetailView } from "./PositionPathDetailView";

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
  } = useTransformationController();

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
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
  const domainClip = activeTimelineClip ?? selectedClip;
  const positionTransform = useMemo(
    () =>
      activeTransforms.find(
        (transform) => transform.type === "position",
      ) as PositionTransform | undefined,
    [activeTransforms],
  );
  const positionPath = positionTransform?.parameters.path ?? null;

  // Get the asset for the selected clip to check hasAudio
  const clipAsset = useAsset(selectedClip?.assetId);
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
    return getDefaultTransforms().filter((def) =>
      isTransformCompatible(def, compatibilityClipType, compatibilityHasAudio),
    );
  }, [compatibilityClipType, compatibilityHasAudio]);

  const compatibleAddableTransforms = useMemo(() => {
    return getAddableTransforms().filter((def) =>
      isTransformCompatible(def, compatibilityClipType, compatibilityHasAudio),
    );
  }, [compatibilityClipType, compatibilityHasAudio]);

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
      ...compatibleDefaultTransforms.map((definition) =>
        getDefaultSectionId(definition.type),
      ),
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
    if (!selectedClipId) {
      if (pathPanelView !== "home") {
        setPathPanelView("home");
      }
      if (armedPathRecording !== null) {
        setArmedPathRecording(null);
      }
      if (activePathEditor !== null) {
        setActivePathEditor(null);
      }
      return;
    }

    if (
      armedPathRecording !== null &&
      armedPathRecording.clipId !== selectedClipId
    ) {
      setArmedPathRecording(null);
    }

    if (activePathEditor !== null && activePathEditor.clipId !== selectedClipId) {
      setPathPanelView("home");
      setActivePathEditor(null);
    }

    if (!positionPath && pathPanelView === "path") {
      setPathPanelView("home");
      setActivePathEditor(null);
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
    setPathPanelView("home");
    setActivePathEditor(null);
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

  const handleOpenPathEditor = useCallback(() => {
    if (!selectedClipId || !positionTransform || !positionPath) return;
    setArmedPathRecording(null);
    setActivePathEditor({
      clipId: selectedClipId,
      transformId: positionTransform.id,
    });
    setPathPanelView("path");
  }, [
    positionPath,
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
    if (!positionTransform || !positionPath) return;
    const nextParameters = { ...positionTransform.parameters };
    delete nextParameters.path;
    updateActiveTransform(positionTransform.id, { parameters: nextParameters });
    setArmedPathRecording(null);
    setActivePathEditor(null);
    setPathPanelView("home");
  }, [
    positionPath,
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

    if (!positionPath) {
      return (
        <Button size="small" onClick={handleStartRecording} sx={commonButtonSx}>
          Record Path
        </Button>
      );
    }

    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}>
        <Button size="small" onClick={handleOpenPathEditor} sx={commonButtonSx}>
          Edit Path
        </Button>
        <Button size="small" onClick={handleStartRecording} sx={commonButtonSx}>
          Re-record
        </Button>
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
    handleOpenPathEditor,
    handleRemovePath,
    handleStartRecording,
    positionPath,
    selectedClipId,
  ]);

  const getDefaultGroupProps = useCallback(
    (groupId: string) => {
      if (groupId !== "position") {
        return {};
      }

      return {
        disabled: Boolean(positionPath),
        disableKeyframe: Boolean(positionPath),
        headerActions: positionGroupHeaderActions,
      };
    },
    [positionGroupHeaderActions, positionPath],
  );

  const isPathEditorOpen =
    pathPanelView === "path" &&
    !!selectedClipId &&
    !!positionTransform &&
    !!positionPath &&
    activePathEditor?.clipId === selectedClipId &&
    activePathEditor.transformId === positionTransform.id;

  if (!selectedClipId) return null;

  if (isPathEditorOpen && positionPath) {
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
        <PositionPathDetailView
          path={positionPath}
          onBack={handleBackFromPathEditor}
          onTimingChange={handlePathTimingChange}
          onRemove={handleRemovePath}
          onRerecord={handleStartRecording}
        />
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

              if (!groups || groups.length === 0) return null;

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
