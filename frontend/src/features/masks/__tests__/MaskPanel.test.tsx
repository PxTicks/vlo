import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MaskPanel } from "../MaskPanel";
import { useMaskPanel } from "../hooks/useMaskPanel";
import type { ClipTransform, TimelineClip } from "../../../types/TimelineTypes";

vi.mock("../hooks/useMaskPanel");
const mockSetSharedMaskTransforms = vi.fn();
let mockSharedMaskTransforms: ClipTransform[] = [];
vi.mock("../../transformations", () => ({
  useTransformationController: (
    options?: { target?: "clip" | "mask" | "maskComposite" | "auto" },
  ) => ({
    activeContextId:
      options?.target === "maskComposite"
        ? "mask-composite-context"
        : "mask-context",
    activeTransforms:
      options?.target === "maskComposite" ? mockSharedMaskTransforms : [],
    activeTimelineClip: null,
    setActiveTransforms:
      options?.target === "maskComposite"
        ? mockSetSharedMaskTransforms
        : vi.fn(),
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
    activeContextId?: string;
  }) => (
    <div data-testid={`default-sections-order-${props.activeContextId ?? "unknown"}`}>
      {props.definitions.map((definition) => definition.type).join(">")}
    </div>
  ),
  getDefaultSectionId: (definitionType: string) => `default:${definitionType}`,
  getDefaultTransforms: () => [
    { type: "layout", label: "Layout", uiConfig: { groups: [] } },
  ],
  createAddTransform: (type: string) => ({
    id: `${type}_created`,
    type,
    isEnabled: true,
    parameters:
      type === "feather"
        ? { mode: "hard_outer", amount: 0, invert: false }
        : { amount: 0, invert: false },
  }),
  insertTransformRespectingDefaultOrder: (
    transforms: ClipTransform[],
    transform: ClipTransform,
  ) => [...transforms, transform],
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
vi.mock("../components/Sam2ModelDownloadOverlay", () => ({
  Sam2ModelDownloadOverlay: () => (
    <div data-testid="sam2-download-overlay">SAM2 download overlay</div>
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
  const mockSetMaskBooleanExpression = vi.fn();
  const mockSetMaskInverted = vi.fn();
  const mockSetSam2PointMode = vi.fn();
  const mockClearSam2Points = vi.fn();
  const mockClearSam2CurrentFramePoints = vi.fn();
  const mockGenerateSam2FramePreview = vi.fn();
  const mockGenerateSam2Mask = vi.fn();
  const mockDeleteSelectedMask = vi.fn();
  const mockEnsureSam2Available = vi.fn(async () => true);
  let baseHookValue: ReturnType<typeof useMaskPanel>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSharedMaskTransforms = [];
    baseHookValue = {
      selectedClipId: "clip_1",
      masks: [],
      maskBooleanExpression: null,
      selectedMaskId: null,
      selectedMask: null,
      addMenuAnchorEl: null,
      isAddDisabled: false,
      addDisabledReason: null,
      setAddMenuAnchorEl: mockSetAddMenuAnchorEl,
      requestDraw: mockRequestDraw,
      selectMask: mockSelectMask,
      setMaskMode: mockSetMaskMode,
      setMaskBooleanExpression: mockSetMaskBooleanExpression,
      maskInverted: false,
      setMaskInverted: mockSetMaskInverted,
      sam2PointMode: "add",
      setSam2PointMode: mockSetSam2PointMode,
      sam2Points: [],
      sam2CurrentFramePointsCount: 0,
      isSam2EditorOpen: false,
      isSam2Available: true,
      isSam2Checking: false,
      sam2AvailabilityError: null,
      ensureSam2Available: mockEnsureSam2Available,
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
    expect(
      screen.queryByTestId("default-sections-order-mask-composite-context"),
    ).not.toBeInTheDocument();
  }, 15000);

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

  it("does not highlight any mask chip on the home view", () => {
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

    expect(screen.getByRole("button", { name: "Mask 1" })).not.toHaveClass(
      "MuiChip-colorPrimary",
    );
    expect(screen.getByRole("button", { name: "Mask 2" })).not.toHaveClass(
      "MuiChip-colorPrimary",
    );
  });

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

  it("keeps SAM2 selectable from the add menu even when unavailable", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      addMenuAnchorEl: document.createElement("button"),
      isSam2Available: false,
    });

    render(<MaskPanel />);

    const sam2MenuItem = screen.getByText("Sam2");
    expect(sam2MenuItem).not.toHaveAttribute("aria-disabled", "true");

    fireEvent.click(sam2MenuItem);
    expect(mockRequestDraw).toHaveBeenCalledWith("sam2");
  });

  it("shows SAM2 download on home and opens the SAM2 detail view separately", () => {
    const sam2Mask = createMaskClip("clip_1", "mask_sam2", "sam2");
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [sam2Mask],
      selectedMaskId: "mask_sam2",
      selectedMask: sam2Mask,
      isSam2Available: false,
    });

    render(<MaskPanel />);

    expect(screen.getByTestId("sam2-download-overlay")).toBeInTheDocument();
    expect(screen.queryByTestId("sam2-mask-panel")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mask 1" }));
    expect(mockSetMaskBooleanExpression).toHaveBeenCalledWith({
      kind: "mask_ref",
      maskId: "mask_sam2",
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit Mask 1" }));
    expect(mockSelectMask).toHaveBeenCalledWith("mask_sam2");
    expect(screen.getByTestId("sam2-mask-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("sam2-download-overlay")).not.toBeInTheDocument();
  });

  it("does not show the SAM2 download overlay for non-SAM2 masks", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [createMaskClip("clip_1", "mask_1", "triangle")],
      selectedMaskId: "mask_1",
      selectedMask: createMaskClip("clip_1", "mask_1", "triangle"),
      isSam2Available: false,
    });

    render(<MaskPanel />);

    expect(
      screen.queryByTestId("sam2-download-overlay"),
    ).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Edit Mask 1" }));
    expect(mockSelectMask).toHaveBeenCalledWith("mask_1");

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(mockSetMaskMode).toHaveBeenCalledWith("preview");

    fireEvent.click(screen.getByRole("button", { name: "Inverted" }));
    expect(mockSetMaskInverted).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Delete Mask" }));
    expect(mockDeleteSelectedMask).toHaveBeenCalled();
  });

  it("keeps shared mask edges on home and opens individual controls in detail view", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [createMaskClip("clip_1", "mask_1", "triangle")],
      selectedMaskId: "mask_1",
      selectedMask: createMaskClip("clip_1", "mask_1", "triangle"),
    });

    render(<MaskPanel />);

    expect(
      screen.getByTestId("default-sections-order-mask-composite-context"),
    ).toHaveTextContent("mask_grow>feather");
    expect(
      screen.queryByTestId("default-sections-order-mask-context"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit Mask 1" }));

    expect(screen.getByTestId("default-sections-order-mask-context")).toHaveTextContent(
      "layout",
    );
    expect(
      screen.queryByTestId("default-sections-order-mask-composite-context"),
    ).not.toBeInTheDocument();
  });

  it("shares one inverse toggle across grow and feather", () => {
    mockSharedMaskTransforms = [
      {
        id: "grow_1",
        type: "mask_grow",
        isEnabled: true,
        parameters: {
          amount: 18,
          invert: false,
        },
      },
      {
        id: "feather_1",
        type: "feather",
        isEnabled: true,
        parameters: {
          mode: "hard_outer",
          amount: 24,
          invert: false,
        },
      },
    ];
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [createMaskClip("clip_1", "mask_1", "triangle")],
      selectedMaskId: "mask_1",
      selectedMask: createMaskClip("clip_1", "mask_1", "triangle"),
    });

    render(<MaskPanel />);

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Inverse Masking" }),
    );

    expect(mockSetSharedMaskTransforms).toHaveBeenCalledWith([
      expect.objectContaining({
        type: "mask_grow",
        parameters: expect.objectContaining({
          invert: true,
        }),
      }),
      expect.objectContaining({
        type: "feather",
        parameters: expect.objectContaining({
          invert: true,
        }),
      }),
    ]);
  });

  it("materializes both shared edge transforms when toggling inverse with none present", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [createMaskClip("clip_1", "mask_1", "triangle")],
      selectedMaskId: "mask_1",
      selectedMask: createMaskClip("clip_1", "mask_1", "triangle"),
    });

    render(<MaskPanel />);

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Inverse Masking" }),
    );

    expect(mockSetSharedMaskTransforms).toHaveBeenCalledWith([
      expect.objectContaining({
        type: "mask_grow",
        parameters: expect.objectContaining({
          invert: true,
        }),
      }),
      expect.objectContaining({
        type: "feather",
        parameters: expect.objectContaining({
          invert: true,
        }),
      }),
    ]);
  });

  it("returns from a mask detail view back to the shared home view", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [createMaskClip("clip_1", "mask_1", "triangle")],
      selectedMaskId: "mask_1",
      selectedMask: createMaskClip("clip_1", "mask_1", "triangle"),
    });

    render(<MaskPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Edit Mask 1" }));
    expect(screen.getByRole("button", { name: "Back To Masks" })).toBeInTheDocument();
    expect(screen.getByTestId("default-sections-order-mask-context")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back To Masks" }));

    expect(
      screen.getByTestId("default-sections-order-mask-composite-context"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("default-sections-order-mask-context"),
    ).not.toBeInTheDocument();
  });

  it("renders Sam2MaskPanel in the dedicated mask detail view", () => {
    const sam2Mask = createMaskClip("clip_1", "mask_sam2", "sam2");
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [sam2Mask],
      selectedMaskId: "mask_sam2",
      selectedMask: sam2Mask,
    });

    render(<MaskPanel />);

    expect(
      screen.getByTestId("default-sections-order-mask-composite-context"),
    ).toHaveTextContent("mask_grow>feather");
    expect(
      screen.queryByTestId("default-sections-order-mask-context"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit Mask 1" }));

    const sam2Panel = screen.getByTestId("sam2-mask-panel");
    expect(sam2Panel).toBeInTheDocument();
    expect(sam2Panel).toHaveTextContent("Mask 1");
    expect(
      screen.queryByTestId("default-sections-order-mask-context"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("default-sections-order-mask-composite-context"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back To Masks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Mask" })).toBeInTheDocument();
  });

  it("inserts masks into the boolean equation from the available mask row", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [createMaskClip("clip_1", "mask_1", "circle")],
    });

    render(<MaskPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Mask 1" }));

    expect(mockSetMaskBooleanExpression).toHaveBeenCalledWith({
      kind: "mask_ref",
      maskId: "mask_1",
    });
  });

  it("wraps the selected equation node with an operator when adding another mask", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [
        createMaskClip("clip_1", "mask_1", "circle"),
        createMaskClip("clip_1", "mask_2", "rectangle"),
      ],
      maskBooleanExpression: {
        kind: "mask_ref",
        maskId: "mask_1",
      },
    });

    render(<MaskPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Mask 2" }));

    expect(mockSetMaskBooleanExpression).toHaveBeenCalledWith({
      kind: "operation",
      operator: "union",
      left: {
        kind: "mask_ref",
        maskId: "mask_1",
      },
      right: {
        kind: "mask_ref",
        maskId: "mask_2",
      },
    });
  });

  it("can nest another union into a selected subexpression", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [
        createMaskClip("clip_1", "mask_1", "circle"),
        createMaskClip("clip_1", "mask_2", "rectangle"),
        createMaskClip("clip_1", "mask_3", "triangle"),
      ],
      maskBooleanExpression: {
        kind: "operation",
        operator: "union",
        left: {
          kind: "mask_ref",
          maskId: "mask_1",
        },
        right: {
          kind: "mask_ref",
          maskId: "mask_2",
        },
      },
    });

    render(<MaskPanel />);

    fireEvent.click(screen.getByTestId("mask-equation-mask-left"));
    fireEvent.click(screen.getByRole("button", { name: "Mask 3" }));

    expect(mockSetMaskBooleanExpression).toHaveBeenCalledWith({
      kind: "operation",
      operator: "union",
      left: {
        kind: "operation",
        operator: "union",
        left: {
          kind: "mask_ref",
          maskId: "mask_1",
        },
        right: {
          kind: "mask_ref",
          maskId: "mask_3",
        },
      },
      right: {
        kind: "mask_ref",
        maskId: "mask_2",
      },
    });
  });

  it("cycles an inline operator chip through the boolean operations", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [
        createMaskClip("clip_1", "mask_1", "circle"),
        createMaskClip("clip_1", "mask_2", "rectangle"),
      ],
      maskBooleanExpression: {
        kind: "operation",
        operator: "union",
        left: {
          kind: "mask_ref",
          maskId: "mask_1",
        },
        right: {
          kind: "mask_ref",
          maskId: "mask_2",
        },
      },
    });

    render(<MaskPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Union" }));

    expect(mockSetMaskBooleanExpression).toHaveBeenCalledWith({
      kind: "operation",
      operator: "intersect",
      left: {
        kind: "mask_ref",
        maskId: "mask_1",
      },
      right: {
        kind: "mask_ref",
        maskId: "mask_2",
      },
    });
  });

  it("does not render dedicated swap, delete, or clear equation buttons", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [
        createMaskClip("clip_1", "mask_1", "circle"),
        createMaskClip("clip_1", "mask_2", "rectangle"),
      ],
      maskBooleanExpression: {
        kind: "operation",
        operator: "union",
        left: {
          kind: "mask_ref",
          maskId: "mask_1",
        },
        right: {
          kind: "mask_ref",
          maskId: "mask_2",
        },
      },
    });

    render(<MaskPanel />);

    expect(screen.queryByTestId("mask-equation-swap")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mask-equation-delete")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mask-equation-clear")).not.toBeInTheDocument();
  });

  it("swaps two equation mask chips when dragging one onto the other", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [
        createMaskClip("clip_1", "mask_1", "circle"),
        createMaskClip("clip_1", "mask_2", "rectangle"),
      ],
      maskBooleanExpression: {
        kind: "operation",
        operator: "union",
        left: {
          kind: "mask_ref",
          maskId: "mask_1",
        },
        right: {
          kind: "mask_ref",
          maskId: "mask_2",
        },
      },
    });

    render(<MaskPanel />);

    const leftChip = screen.getByTestId("mask-equation-mask-left");
    const rightChip = screen.getByTestId("mask-equation-mask-right");

    fireEvent.dragStart(leftChip, {
      dataTransfer: {
        effectAllowed: "",
        setData: vi.fn(),
      },
    });
    fireEvent.dragOver(rightChip, {
      dataTransfer: {
        dropEffect: "",
      },
    });
    fireEvent.drop(rightChip);

    expect(mockSetMaskBooleanExpression).toHaveBeenCalledWith({
      kind: "operation",
      operator: "union",
      left: {
        kind: "mask_ref",
        maskId: "mask_2",
      },
      right: {
        kind: "mask_ref",
        maskId: "mask_1",
      },
    });
  });

  it("removes the selected mask chip when Delete is pressed", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [
        createMaskClip("clip_1", "mask_1", "circle"),
        createMaskClip("clip_1", "mask_2", "rectangle"),
      ],
      maskBooleanExpression: {
        kind: "operation",
        operator: "union",
        left: {
          kind: "mask_ref",
          maskId: "mask_1",
        },
        right: {
          kind: "mask_ref",
          maskId: "mask_2",
        },
      },
    });

    render(<MaskPanel />);

    const leftChip = screen.getByTestId("mask-equation-mask-left");
    fireEvent.click(leftChip);
    fireEvent.keyDown(leftChip, { key: "Delete" });

    expect(mockSetMaskBooleanExpression).toHaveBeenCalledWith({
      kind: "mask_ref",
      maskId: "mask_2",
    });
  });

  it("clears the equation when Delete removes the final selected mask", () => {
    vi.mocked(useMaskPanel).mockReturnValue({
      ...baseHookValue,
      masks: [createMaskClip("clip_1", "mask_1", "circle")],
      maskBooleanExpression: {
        kind: "mask_ref",
        maskId: "mask_1",
      },
    });

    render(<MaskPanel />);

    const rootChip = screen.getByTestId("mask-equation-mask-root");
    fireEvent.click(rootChip);
    fireEvent.keyDown(rootChip, { key: "Delete" });

    expect(mockSetMaskBooleanExpression).toHaveBeenCalledWith(null);
  });
});
