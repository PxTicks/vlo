import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MaskPanel } from "../MaskPanel";
import { useMaskPanel } from "../hooks/useMaskPanel";
import type { TimelineClip } from "../../../types/TimelineTypes";

vi.mock("../hooks/useMaskPanel");
vi.mock("../../transformations", () => ({
  useTransformationController: () => ({
    activeContextId: "mask-context",
    activeTransforms: [],
    activeTimelineClip: null,
    setActiveTransforms: vi.fn(),
    updateActiveTransform: vi.fn(),
    handleSetDefaultGroupsEnabled: vi.fn(),
    handleCommit: vi.fn(),
  }),
  useActiveTransformationSection: () => ({
    activeSectionId: null,
    activateSection: vi.fn(),
  }),
  DefaultTransformationSections: (props: {
    definitions: Array<{ type: string }>;
  }) => (
    <div data-testid="default-sections-order">
      {props.definitions.map((definition) => definition.type).join(">")}
    </div>
  ),
  getDefaultSectionId: (definitionType: string) => `default:${definitionType}`,
  getDefaultTransforms: () => [
    { type: "layout", label: "Layout", uiConfig: { groups: [] } },
  ],
  getEntryByType: (type: string) =>
    type === "mask_grow"
      ? { type: "mask_grow", label: "Grow", uiConfig: { groups: [] } }
      : type === "feather"
        ? { type: "feather", label: "Feather", uiConfig: { groups: [] } }
        : undefined,
}));
vi.mock("../components/Sam2MaskPanel", () => ({
  Sam2MaskPanel: (props: { maskLabel: string }) => (
    <div data-testid="sam2-mask-panel">{props.maskLabel}</div>
  ),
}));

function createMaskClip(
  parentClipId: string,
  localId: string,
  type: "circle" | "rectangle" | "triangle" | "sam2",
): TimelineClip {
  return {
    id: `${parentClipId}::mask::${localId}`,
    trackId: "track_1",
    type: "mask",
    name: `Mask ${localId}`,
    sourceDuration: 100,
    start: 0,
    timelineDuration: 100,
    offset: 0,
    transformedDuration: 100,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    transformations: [],
    parentClipId,
    maskType: type,
    maskMode: "apply",
    maskInverted: false,
    maskParameters: {
      baseWidth: 100,
      baseHeight: 80,
    },
  };
}

describe("MaskPanel", () => {
  const mockSetAddMenuAnchorEl = vi.fn();
  const mockRequestDraw = vi.fn();
  const mockSelectMask = vi.fn();
  const mockSetMaskMode = vi.fn();
  const mockSetMaskInverted = vi.fn();
  const mockClearSam2Points = vi.fn();
  const mockClearSam2CurrentFramePoints = vi.fn();
  const mockGenerateSam2FramePreview = vi.fn();
  const mockGenerateSam2Mask = vi.fn();
  const mockDeleteSelectedMask = vi.fn();
  let baseHookValue: ReturnType<typeof useMaskPanel>;

  beforeEach(() => {
    vi.clearAllMocks();
    baseHookValue = {
      selectedClipId: "clip_1",
      masks: [],
      selectedMaskId: null,
      selectedMask: null,
      addMenuAnchorEl: null,
      isAddDisabled: false,
      addDisabledReason: null,
      setAddMenuAnchorEl: mockSetAddMenuAnchorEl,
      requestDraw: mockRequestDraw,
      selectMask: mockSelectMask,
      setMaskMode: mockSetMaskMode,
      maskInverted: false,
      setMaskInverted: mockSetMaskInverted,
      sam2Points: [],
      sam2CurrentFramePointsCount: 0,
      isSam2EditorOpen: false,
      isSam2Available: true,
      isSam2Checking: false,
      sam2AvailabilityError: null,
      clearSam2Points: mockClearSam2Points,
      clearSam2CurrentFramePoints: mockClearSam2CurrentFramePoints,
      generateSam2FramePreview: mockGenerateSam2FramePreview,
      isSam2FrameGenerating: false,
      sam2FramePreviewError: null,
      generateSam2Mask: mockGenerateSam2Mask,
      isSam2Generating: false,
      sam2GenerateError: null,
      isSam2Dirty: false,
      hasSam2MaskAsset: false,
      deleteSelectedMask: mockDeleteSelectedMask,
    };
    vi.mocked(useMaskPanel).mockReturnValue(baseHookValue);
  });

  it("shows add mask button by default", () => {
    render(<MaskPanel />);
    expect(
      screen.getByRole("button", { name: "Add mask" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Add a mask to start editing."),
    ).toBeInTheDocument();
  });

  it("renders selectable mask buttons plus trailing add mask button", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [
        createMaskClip("clip_1", "mask_1", "circle"),
        createMaskClip("clip_1", "mask_2", "rectangle"),
      ],
      selectedMaskId: "mask_1",
      selectedMask: createMaskClip("clip_1", "mask_1", "circle"),
    });

    render(<MaskPanel />);

    expect(screen.getByRole("button", { name: "Mask 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mask 2" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add mask" }),
    ).toBeInTheDocument();
  }, 10000);

  it("shows helper text when add is disabled", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      isAddDisabled: true,
      addDisabledReason:
        "Move playhead inside the selected clip to draw a mask.",
    });

    render(<MaskPanel />);

    expect(
      screen.getByText(
        "Move playhead inside the selected clip to draw a mask.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add mask" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("opens shape menu and dispatches selected shape", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      addMenuAnchorEl: document.createElement("button"),
    });

    render(<MaskPanel />);

    fireEvent.click(screen.getByText("Circle"));
    expect(mockRequestDraw).toHaveBeenCalledWith("circle");
  });

  it("updates mask mode and deletes selected mask", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [createMaskClip("clip_1", "mask_1", "triangle")],
      selectedMaskId: "mask_1",
      selectedMask: createMaskClip("clip_1", "mask_1", "triangle"),
    });

    render(<MaskPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(mockSetMaskMode).toHaveBeenCalledWith("preview");

    fireEvent.click(screen.getByRole("button", { name: "Inverted" }));
    expect(mockSetMaskInverted).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Delete Mask" }));
    expect(mockDeleteSelectedMask).toHaveBeenCalled();
  });

  it("renders mask operations before feather in non-SAM2 mode", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [createMaskClip("clip_1", "mask_1", "triangle")],
      selectedMaskId: "mask_1",
      selectedMask: createMaskClip("clip_1", "mask_1", "triangle"),
    });

    render(<MaskPanel />);

    expect(screen.getByTestId("default-sections-order")).toHaveTextContent(
      "layout>mask_grow>feather",
    );
  });

  it("renders Sam2MaskPanel when a SAM2 mask is selected", () => {
    const sam2Mask = createMaskClip("clip_1", "mask_sam2", "sam2");
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [sam2Mask],
      selectedMaskId: "mask_sam2",
      selectedMask: sam2Mask,
    });

    render(<MaskPanel />);

    // Sam2MaskPanel should be rendered (via the mock) with the correct label
    const sam2Panel = screen.getByTestId("sam2-mask-panel");
    expect(sam2Panel).toBeInTheDocument();
    expect(sam2Panel).toHaveTextContent("Mask 1");

    // Standard mask controls should NOT be rendered inside the SAM2 panel body
    expect(
      screen.queryByRole("button", { name: "Apply" }),
    ).not.toBeInTheDocument();

    expect(screen.getByTestId("default-sections-order")).toHaveTextContent(
      "mask_grow>feather",
    );
    const defaultSections = screen.getByTestId("default-sections-order");
    const deleteButton = screen.getByRole("button", { name: "Delete Mask" });
    expect(
      defaultSections.compareDocumentPosition(deleteButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });
});
