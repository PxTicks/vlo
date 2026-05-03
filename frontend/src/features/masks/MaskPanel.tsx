import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  Menu,
  MenuItem,
  Tab,
  Tabs,
  TextField,
  Typography,
  Divider,
  Chip,
  FormControlLabel,
  IconButton,
  Tooltip,
} from "@mui/material";
import {
  DeleteOutline,
  Add,
  ArrowBack,
  InfoOutlined,
} from "@mui/icons-material";
import { MASK_TYPES } from "./model/maskFactory";
import { useMaskPanel } from "./hooks/useMaskPanel";
import {
  DefaultTransformationSections,
  getDefaultTransforms,
  getEntryByType,
  getDefaultSectionId,
  useTransformationController,
} from "../transformations";
import { Sam2MaskPanel } from "./components/Sam2MaskPanel";
import { BrushMaskPanel } from "./components/BrushMaskPanel";
import { flushBrushMaskCommit } from "./runtime/brushAssetSync";
import { Sam2ModelDownloadOverlay } from "./components/Sam2ModelDownloadOverlay";
import { MaskEquationBuilder } from "./components/MaskEquationBuilder";
import { MaskActiveRangeSection } from "./components/MaskActiveRangeSection";
import { RangeMaskSection } from "./components/RangeMaskSection";
import { parseMaskClipId } from "../timeline";
import type { MaskTimelineClip } from "../../types/TimelineTypes";
import type { MaskCompositionAlgebra } from "../../types/Components";

const connectedButtonSx = {
  textTransform: "none",
  borderColor: "#2f333a",
  bgcolor: "#4a4f57",
  color: "#f2f3f5",
  "&:hover": {
    bgcolor: "#5a606b",
    borderColor: "#2f333a",
  },
  "&.Mui-disabled": {
    bgcolor: "#3a3f47",
    color: "#8a8f98",
    borderColor: "#2f333a",
  },
};

const selectedConnectedButtonSx = {
  ...connectedButtonSx,
  bgcolor: "#6b7280",
  color: "#ffffff",
  "&:hover": {
    bgcolor: "#7a8292",
  },
};

type MaskPanelView = "home" | "mask";
type MaskHomeSubTab = "clip" | "range";

function getMaskDisplayLabel(
  mask: MaskTimelineClip | null,
  fallbackLabel: string,
): string {
  if (!mask) {
    return fallbackLabel;
  }

  const localId = parseMaskClipId(mask.id)?.maskId;
  const name = mask.name.trim();
  if (!name || (localId && name === `Mask ${localId}`)) {
    return fallbackLabel;
  }
  return name;
}

function getAlgebraForInverseChecked(
  checked: boolean,
): MaskCompositionAlgebra {
  return checked ? "inverse" : "normal";
}

function useLocalActiveSection(
  activeContextId: string | undefined,
  sectionOrder: string[],
) {
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);

  const activeSectionId = useMemo(() => {
    if (!activeContextId || sectionOrder.length === 0) {
      return null;
    }
    if (selectedSectionId && sectionOrder.includes(selectedSectionId)) {
      return selectedSectionId;
    }
    return sectionOrder[0] ?? null;
  }, [activeContextId, sectionOrder, selectedSectionId]);

  const activateSection = useCallback(
    (sectionId: string) => {
      if (!activeContextId) return;
      setSelectedSectionId(sectionId);
    },
    [activeContextId],
  );

  return {
    activeSectionId,
    activateSection,
  };
}

export const MaskPanel = memo(function MaskPanel() {
  const [panelView, setPanelView] = useState<MaskPanelView>("home");
  const [homeSubTab, setHomeSubTab] = useState<MaskHomeSubTab>("clip");
  const {
    selection,
    panel,
    mask,
    sam2,
    brush,
    rangeMask,
  } = useMaskPanel();
  const {
    selectedClipId,
    masks,
    selectedMask,
    selectMask,
    duplicateMask,
    deleteMask,
    deleteSelectedMask,
  } = selection;
  const {
    addMenuAnchorEl,
    isAddDisabled,
    addDisabledReason,
    setAddMenuAnchorEl,
    requestDraw,
  } = panel;
  const {
    maskBooleanExpression,
    setMaskMode,
    setMaskBooleanExpression,
    setMaskName,
    maskInverted,
    setMaskInverted,
    maskCompositionAlgebra,
    setMaskCompositionAlgebra,
  } = mask;
  const {
    sam2GrowAmount,
    setSam2GrowAmount,
    sam2PointMode,
    setSam2PointMode,
    sam2Points,
    isSam2Available,
    isSam2Checking,
    sam2AvailabilityError,
    ensureSam2Available,
    sam2CurrentFramePointsCount,
    clearSam2Points,
    clearSam2CurrentFramePoints,
    generateSam2FramePreview,
    isSam2FrameGenerating,
    sam2FramePreviewError,
    generateSam2Mask,
    isSam2Generating,
    sam2GenerateError,
    isSam2Dirty,
    hasSam2MaskAsset,
  } = sam2;
  const {
    brushTool,
    setBrushTool,
    brushRadius,
    setBrushRadius,
    hasBrushAsset,
    clearBrush,
  } = brush;
  const {
    rangeMaskComponents,
    startAddRangeMask,
    startEditRangeMask,
    removeRangeMask,
    toggleRangeMaskActive,
    selectedMaskActiveRange,
    startSetSelectedMaskActiveRange,
    clearSelectedMaskActiveRange,
  } = rangeMask;
  const {
    activeContextId: sharedMaskContextId,
    activeTransforms: sharedMaskTransforms,
    activeTimelineClip: sharedMaskTimelineClip,
    setActiveTransforms: setSharedMaskTransforms,
    updateActiveTransform: updateSharedMaskTransform,
    handleSetDefaultGroupsEnabled: handleSetSharedMaskGroupsEnabled,
    handleCommit: handleSharedMaskCommit,
  } = useTransformationController({ target: "maskComposite" });
  const {
    activeContextId: selectedMaskContextId,
    activeTransforms: selectedMaskTransforms,
    activeTimelineClip: selectedMaskTimelineClip,
    setActiveTransforms: setSelectedMaskTransforms,
    updateActiveTransform: updateSelectedMaskTransform,
    handleSetDefaultGroupsEnabled: handleSetSelectedMaskGroupsEnabled,
    handleCommit: handleSelectedMaskCommit,
  } = useTransformationController({ target: "mask" });

  const normalizedSelectedClipId = selectedClipId ?? undefined;
  const [clipIdForPanelView, setClipIdForPanelView] = useState<
    string | undefined
  >(normalizedSelectedClipId);
  if (clipIdForPanelView !== normalizedSelectedClipId) {
    setClipIdForPanelView(normalizedSelectedClipId);
    setPanelView("home");
  }
  const [hadSelectedMask, setHadSelectedMask] = useState(!!selectedMask);
  const currentlyHasSelectedMask = !!selectedMask;
  if (hadSelectedMask !== currentlyHasSelectedMask) {
    setHadSelectedMask(currentlyHasSelectedMask);
    if (!currentlyHasSelectedMask) {
      setPanelView("home");
    }
  }

  const layoutDefinitions = useMemo(
    () =>
      getDefaultTransforms().filter(
        (definition) => definition.type === "layout",
      ),
    [],
  );
  const growDefinitions = useMemo(() => {
    const grow = getEntryByType("mask_grow");
    return grow ? [grow] : [];
  }, []);
  const featherDefinitions = useMemo(() => {
    const feather = getEntryByType("feather");
    return feather ? [feather] : [];
  }, []);
  const sharedMaskOperationDefinitions = useMemo(
    () => [...growDefinitions, ...featherDefinitions],
    [growDefinitions, featherDefinitions],
  );
  const isMaskCompositionInverse = maskCompositionAlgebra === "inverse";

  // SAM2 masks are point-based and don't use shape transformation sections.
  // Compute this before the section hook to pass an empty sectionOrder.
  const selectedMaskIsSam2 =
    selectedMask?.type === "mask" && selectedMask.maskType === "sam2";
  const selectedMaskIsBrush =
    selectedMask?.type === "mask" && selectedMask.maskType === "brush";

  // Flush any unsaved brush strokes when the user leaves the brush detail
  // view (clicking "Back to Masks" → panelView "mask" → "home"). The
  // interaction controller already handles flushing on clip / mask / tab
  // change; this covers the in-panel "back" action where selectedMask stays
  // the same but the user is no longer editing it.
  const focusedBrushMaskClipIdRef = useRef<string | null>(null);
  useEffect(() => {
    const isBrushDetail =
      panelView === "mask" && selectedMaskIsBrush && !!selectedMask;
    const next = isBrushDetail && selectedMask ? selectedMask.id : null;
    const previous = focusedBrushMaskClipIdRef.current;
    if (previous && previous !== next) {
      void flushBrushMaskCommit(previous);
    }
    focusedBrushMaskClipIdRef.current = next;
  }, [panelView, selectedMaskIsBrush, selectedMask]);

  const sharedSectionOrder = useMemo(
    () =>
      sharedMaskOperationDefinitions.map((definition) =>
        getDefaultSectionId(definition.type),
      ),
    [sharedMaskOperationDefinitions],
  );
  const brushHidesLayoutSections = selectedMaskIsBrush && brushTool !== "gizmo";
  const selectedMaskSectionOrder = useMemo(
    () =>
      selectedMaskIsSam2 || brushHidesLayoutSections
        ? []
        : layoutDefinitions.map((definition) =>
            getDefaultSectionId(definition.type),
          ),
    [brushHidesLayoutSections, layoutDefinitions, selectedMaskIsSam2],
  );

  const {
    activeSectionId: activeSharedSectionId,
    activateSection: activateSharedSection,
  } = useLocalActiveSection(
    sharedMaskContextId,
    selectedClipId ? sharedSectionOrder : [],
  );
  const {
    activeSectionId: activeSelectedMaskSectionId,
    activateSection: activateSelectedMaskSection,
  } = useLocalActiveSection(
    selectedMaskContextId,
    selectedMask ? selectedMaskSectionOrder : [],
  );

  const handleModelsInstalled = useCallback(() => {
    void ensureSam2Available();
  }, [ensureSam2Available]);

  const handleSharedMaskEdgeInvertChange = useCallback(
    (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
      setMaskCompositionAlgebra(getAlgebraForInverseChecked(checked));
    },
    [setMaskCompositionAlgebra],
  );

  const handleRequestDraw = useCallback(
    (shape: (typeof MASK_TYPES)[number]) => {
      requestDraw(shape);
      setPanelView("mask");
    },
    [requestDraw],
  );

  const handleOpenMaskDetail = useCallback(
    (maskId: string) => {
      selectMask(maskId);
      setPanelView("mask");
    },
    [selectMask],
  );

  const handleBackToHome = useCallback(() => {
    setPanelView("home");
  }, []);

  if (!selectedClipId) return null;

  const selectedMaskIndex = selectedMask
    ? masks.findIndex((mask) => mask.id === selectedMask.id)
    : -1;
  const fallbackSelectedMaskLabel =
    selectedMaskIndex >= 0 ? `Mask ${selectedMaskIndex + 1}` : "Mask";
  const selectedMaskLabel = getMaskDisplayLabel(
    selectedMask?.type === "mask" ? selectedMask : null,
    fallbackSelectedMaskLabel,
  );
  const selectedMaskNameValue =
    selectedMask?.type === "mask" ? selectedMask.name : selectedMaskLabel;
  const selectedMaskMode =
    (selectedMask?.type === "mask" ? selectedMask.maskMode : undefined) ??
    "apply";
  const hasSam2Masks = masks.some(
    (mask) => mask.type === "mask" && mask.maskType === "sam2",
  );
  const showSam2DownloadOverlay = hasSam2Masks && !isSam2Available;
  const isDetailView = panelView === "mask" && !!selectedMask;

  return (
    <Box
      data-testid="mask-panel"
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        overflowY: "auto",
      }}
    >
      {isDetailView && selectedMask ? (
        <>
          <Box sx={{ px: 2, pt: 2, pb: 1 }}>
            <Button
              data-testid="mask-back-button"
              size="small"
              startIcon={<ArrowBack fontSize="small" />}
              onClick={handleBackToHome}
              sx={{
                textTransform: "none",
                color: "text.secondary",
                px: 0,
                minWidth: 0,
              }}
            >
              Back To Masks
            </Button>
          </Box>

          {selectedMaskIsBrush ? (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <Box sx={{ px: 2 }}>
                <TextField
                  label="Mask Name"
                  size="small"
                  fullWidth
                  value={selectedMaskNameValue}
                  onChange={(event) => setMaskName(event.target.value)}
                />
              </Box>
              <BrushMaskPanel
                maskMode={selectedMaskMode}
                maskInverted={maskInverted}
                maskLabel={selectedMaskLabel}
                brushTool={brushTool}
                brushRadius={brushRadius}
                hasBrushAsset={hasBrushAsset}
                onSetBrushTool={setBrushTool}
                onSetBrushRadius={setBrushRadius}
                onClearBrush={clearBrush}
                onSetMaskMode={setMaskMode}
                onSetMaskInverted={setMaskInverted}
              />
              {brushTool === "gizmo" && (
                <DefaultTransformationSections
                  definitions={layoutDefinitions}
                  activeTransforms={selectedMaskTransforms}
                  activeContextId={selectedMaskContextId}
                  activeSectionId={activeSelectedMaskSectionId}
                  timelineClip={selectedMaskTimelineClip}
                  onCommit={handleSelectedMaskCommit}
                  onSetDefaultGroupsEnabled={handleSetSelectedMaskGroupsEnabled}
                  onUpdateTransform={updateSelectedMaskTransform}
                  onSetTransforms={setSelectedMaskTransforms}
                  onActivateSection={activateSelectedMaskSection}
                />
              )}
              <Box sx={{ px: 2, pb: 2 }}>
                <Divider sx={{ borderColor: "#2a2d33", mb: 2 }} />
                <Box sx={{ mb: 2 }}>
                  <MaskActiveRangeSection
                    activeRange={selectedMaskActiveRange}
                    onAdd={startSetSelectedMaskActiveRange}
                    onEdit={startSetSelectedMaskActiveRange}
                    onRemove={clearSelectedMaskActiveRange}
                  />
                </Box>
                <Button
                  data-testid="mask-delete-button"
                  variant="outlined"
                  color="error"
                  startIcon={<DeleteOutline fontSize="small" />}
                  onClick={deleteSelectedMask}
                  sx={{ textTransform: "none", width: "100%" }}
                >
                  Delete Mask
                </Button>
              </Box>
            </Box>
          ) : selectedMaskIsSam2 ? (
            <>
              <Box sx={{ px: 2, pb: 1 }}>
                <TextField
                  label="Mask Name"
                  size="small"
                  fullWidth
                  value={selectedMaskNameValue}
                  onChange={(event) => setMaskName(event.target.value)}
                />
              </Box>
              <Sam2MaskPanel
                maskMode={selectedMaskMode}
                maskInverted={maskInverted}
                maskLabel={selectedMaskLabel}
                sam2PointMode={sam2PointMode}
                points={sam2Points}
                currentFramePointsCount={sam2CurrentFramePointsCount}
                isSam2Available={isSam2Available}
                isSam2Checking={isSam2Checking}
                sam2AvailabilityError={sam2AvailabilityError}
                onClearPoints={clearSam2Points}
                onClearCurrentFramePoints={clearSam2CurrentFramePoints}
                onGenerateFramePreview={generateSam2FramePreview}
                isFrameGenerating={isSam2FrameGenerating}
                framePreviewError={sam2FramePreviewError}
                onGenerateMask={generateSam2Mask}
                isGenerating={isSam2Generating}
                generateError={sam2GenerateError}
                isDirty={isSam2Dirty}
                hasMaskAsset={hasSam2MaskAsset}
                sam2GrowAmount={sam2GrowAmount}
                onSetMaskMode={setMaskMode}
                onSetMaskInverted={setMaskInverted}
                onSetSam2GrowAmount={setSam2GrowAmount}
                onSetSam2PointMode={setSam2PointMode}
              />
              <Box sx={{ px: 2, pb: 2 }}>
                <Divider sx={{ borderColor: "#2a2d33", mb: 2 }} />
                <Box sx={{ mb: 2 }}>
                  <MaskActiveRangeSection
                    activeRange={selectedMaskActiveRange}
                    onAdd={startSetSelectedMaskActiveRange}
                    onEdit={startSetSelectedMaskActiveRange}
                    onRemove={clearSelectedMaskActiveRange}
                  />
                </Box>
                <Button
                  data-testid="mask-delete-button"
                  variant="outlined"
                  color="error"
                  startIcon={<DeleteOutline fontSize="small" />}
                  onClick={deleteSelectedMask}
                  sx={{ textTransform: "none", width: "100%" }}
                >
                  Delete Mask
                </Button>
              </Box>
            </>
          ) : (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <Box sx={{ px: 2 }}>
                <TextField
                  label="Mask Name"
                  size="small"
                  fullWidth
                  value={selectedMaskNameValue}
                  onChange={(event) => setMaskName(event.target.value)}
                  sx={{ mb: 1 }}
                />
                <Typography
                  variant="caption"
                  sx={{ color: "text.secondary", display: "inline-block", mr: 1 }}
                >
                  {selectedMaskLabel}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{ color: "text.disabled", display: "inline-block" }}
                >
                  {`— Shape: ${selectedMask.type === "mask" ? (selectedMask.maskType ?? "rectangle") : "rectangle"}`}
                </Typography>
              </Box>

              <DefaultTransformationSections
                definitions={layoutDefinitions}
                activeTransforms={selectedMaskTransforms}
                activeContextId={selectedMaskContextId}
                activeSectionId={activeSelectedMaskSectionId}
                timelineClip={selectedMaskTimelineClip}
                onCommit={handleSelectedMaskCommit}
                onSetDefaultGroupsEnabled={handleSetSelectedMaskGroupsEnabled}
                onUpdateTransform={updateSelectedMaskTransform}
                onSetTransforms={setSelectedMaskTransforms}
                onActivateSection={activateSelectedMaskSection}
              />

              <Box sx={{ px: 2, pb: 2 }}>
                <Divider sx={{ borderColor: "#2a2d33", mb: 2 }} />

                <Typography
                  variant="caption"
                  sx={{ color: "text.secondary", display: "block", mb: 1 }}
                >
                  Mode
                </Typography>
                <ButtonGroup
                  variant="contained"
                  disableElevation
                  size="small"
                  fullWidth
                  sx={{ mb: 1 }}
                >
                  <Button
                    data-testid="mask-mode-apply"
                    onClick={() => setMaskMode("apply")}
                    sx={
                      selectedMaskMode === "apply"
                        ? selectedConnectedButtonSx
                        : connectedButtonSx
                    }
                  >
                    Apply
                  </Button>
                  <Button
                    data-testid="mask-mode-preview"
                    onClick={() => setMaskMode("preview")}
                    sx={
                      selectedMaskMode === "preview"
                        ? selectedConnectedButtonSx
                        : connectedButtonSx
                    }
                  >
                    Preview
                  </Button>
                </ButtonGroup>

                <Typography
                  variant="caption"
                  sx={{ color: "text.secondary", display: "block", mb: 1 }}
                >
                  Inversion
                </Typography>
                <ButtonGroup
                  variant="contained"
                  disableElevation
                  size="small"
                  fullWidth
                  sx={{ mb: 1 }}
                >
                  <Button
                    data-testid="mask-inversion-normal"
                    onClick={() => setMaskInverted(false)}
                    sx={
                      !maskInverted
                        ? selectedConnectedButtonSx
                        : connectedButtonSx
                    }
                  >
                    Normal
                  </Button>
                  <Button
                    data-testid="mask-inversion-inverted"
                    onClick={() => setMaskInverted(true)}
                    sx={
                      maskInverted ? selectedConnectedButtonSx : connectedButtonSx
                    }
                  >
                    Inverted
                  </Button>
                </ButtonGroup>

                <Box sx={{ mb: 2 }}>
                  <MaskActiveRangeSection
                    activeRange={selectedMaskActiveRange}
                    onAdd={startSetSelectedMaskActiveRange}
                    onEdit={startSetSelectedMaskActiveRange}
                    onRemove={clearSelectedMaskActiveRange}
                  />
                </Box>

                <Button
                  data-testid="mask-delete-button"
                  variant="outlined"
                  color="error"
                  startIcon={<DeleteOutline fontSize="small" />}
                  onClick={deleteSelectedMask}
                  sx={{ textTransform: "none", width: "100%" }}
                >
                  Delete Mask
                </Button>
              </Box>
            </Box>
          )}
        </>
      ) : (
        <>
          <Tabs
            data-testid="mask-panel-subtabs"
            value={homeSubTab}
            onChange={(_event, value: MaskHomeSubTab) => setHomeSubTab(value)}
            variant="fullWidth"
            sx={{
              borderBottom: "1px solid #2a2d33",
              minHeight: 36,
              "& .MuiTab-root": {
                minHeight: 36,
                textTransform: "none",
                fontSize: "0.8rem",
              },
            }}
          >
            <Tab value="clip" label="Clip Masks" />
            <Tab value="range" label="Range Masks" />
          </Tabs>

          {homeSubTab === "clip" ? (
            <>
              {sharedMaskContextId && (
                <Box
                  sx={{
                    px: 2,
                    pt: 2,
                    pb: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 1,
                  }}
                >
                  <FormControlLabel
                    sx={{ mr: 0 }}
                    control={
                      <Checkbox
                        size="small"
                        checked={isMaskCompositionInverse}
                        onChange={handleSharedMaskEdgeInvertChange}
                      />
                    }
                    label="Inverse Masking"
                  />
                  <Tooltip
                    title="Inverse masking performs operations on the mask 'holes', which is useful for inpainting, intuitively allowing union and intersection of areas to be replaced. Normal masking acts on opaque areas, which is useful for intuitively stacking parts which we want to remain visible."
                    placement="top"
                  >
                    <IconButton
                      size="small"
                      aria-label="Inverse masking information"
                      sx={{ color: "text.secondary" }}
                    >
                      <InfoOutlined sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
                </Box>
              )}
              <Menu
                data-testid="mask-add-menu"
                anchorEl={addMenuAnchorEl}
                open={Boolean(addMenuAnchorEl)}
                onClose={() => setAddMenuAnchorEl(null)}
              >
                {MASK_TYPES.map((shape) => (
                  <MenuItem key={shape} onClick={() => handleRequestDraw(shape)}>
                    {shape[0].toUpperCase() + shape.slice(1)}
                  </MenuItem>
                ))}
              </Menu>

              <MaskEquationBuilder
                masks={masks as MaskTimelineClip[]}
                expression={maskBooleanExpression}
                onExpressionChange={setMaskBooleanExpression}
                onOpenMaskDetail={handleOpenMaskDetail}
                onDuplicateMask={duplicateMask}
                onDeleteMask={deleteMask}
                addAction={
                  <Chip
                    size="small"
                    data-testid="mask-add-chip"
                    label="Add mask"
                    variant="outlined"
                    icon={<Add sx={{ fontSize: "1rem !important" }} />}
                    onClick={(event) => setAddMenuAnchorEl(event.currentTarget)}
                    disabled={isAddDisabled}
                    sx={{
                      fontSize: "0.75rem",
                      height: 24,
                      cursor: isAddDisabled ? "default" : "pointer",
                    }}
                  />
                }
              />

              {addDisabledReason && (
                <Box sx={{ px: 2, pb: 1 }}>
                  <Typography
                    variant="caption"
                    sx={{ color: "text.secondary", display: "block" }}
                  >
                    {addDisabledReason}
                  </Typography>
                </Box>
              )}

              {showSam2DownloadOverlay && (
                <Box sx={{ px: 2, pb: 2 }}>
                  <Sam2ModelDownloadOverlay
                    onModelsInstalled={handleModelsInstalled}
                  />
                </Box>
              )}

              {masks.length > 0 &&
                sharedMaskContextId &&
                sharedMaskOperationDefinitions.length > 0 && (
                  <DefaultTransformationSections
                    definitions={sharedMaskOperationDefinitions}
                    activeTransforms={sharedMaskTransforms}
                    activeContextId={sharedMaskContextId}
                    activeSectionId={activeSharedSectionId}
                    timelineClip={sharedMaskTimelineClip}
                    onCommit={handleSharedMaskCommit}
                    onSetDefaultGroupsEnabled={handleSetSharedMaskGroupsEnabled}
                    onUpdateTransform={updateSharedMaskTransform}
                    onSetTransforms={setSharedMaskTransforms}
                    onActivateSection={activateSharedSection}
                  />
                )}
            </>
          ) : (
            <Box sx={{ pt: 2 }}>
              <RangeMaskSection
                rangeMaskComponents={rangeMaskComponents}
                onAdd={startAddRangeMask}
                onEdit={startEditRangeMask}
                onRemove={removeRangeMask}
                onToggleActive={toggleRangeMaskActive}
              />
            </Box>
          )}
        </>
      )}
    </Box>
  );
});
