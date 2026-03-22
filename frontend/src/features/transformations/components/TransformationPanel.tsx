import { useState, useMemo, useCallback } from "react";
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
import { getTransformLayerDomain } from "../utils/layerDomain";
import {
  getDefaultSectionId,
  getDynamicSectionId,
  getSectionGroupKeyframeColor,
} from "../utils/sectionKeyframes";

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

  const selectedClip = useTimelineClip(selectedClipId);
  const domainClip = activeTimelineClip ?? selectedClip;

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

  if (!selectedClipId) return null;

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
