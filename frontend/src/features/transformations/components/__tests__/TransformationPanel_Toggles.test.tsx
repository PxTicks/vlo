import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EffectsPanel } from "../EffectsPanel";
import { TransformationPanel } from "../TransformationPanel";
import { TICKS_PER_SECOND } from "../../../timeline";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { useMaskViewStore } from "../../../masks/store/useMaskViewStore";
import { useTransformationViewStore } from "../../store/useTransformationViewStore";
import type { MaskTimelineClip } from "../../../../types/TimelineTypes";

vi.mock("../../../timeline/useTimelineStore");

describe("TransformationPanel toggles", () => {
  const mockAddClipTransform = vi.fn();
  const mockUpdateClipTransform = vi.fn();
  const mockRemoveClipTransform = vi.fn();
  const mockSetClipTransforms = vi.fn();
  const mockSetClipTransformsAndShape = vi.fn();
  const mockUpdateClipShape = vi.fn();
  const mockSetClipMaskCompositeTransforms = vi.fn();
  const mockUpdateClipMask = vi.fn();

  const baseClip = {
    id: "clip_1",
    trackId: "track_1",
    start: 0,
    type: "video",
    name: "Clip 1",
    sourceDuration: 10 * TICKS_PER_SECOND,
    timelineDuration: 10 * TICKS_PER_SECOND,
    croppedSourceDuration: 10 * TICKS_PER_SECOND,
    offset: 0,
    transformedDuration: 10 * TICKS_PER_SECOND,
    transformedOffset: 0,
  };
  const tracks = [
    {
      id: "track_1",
      label: "Track 1",
      isVisible: true,
      isLocked: false,
      isMuted: false,
      type: "visual",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    useTransformationViewStore.setState({
      pathPanelView: "home",
      armedPathRecording: null,
      activePathEditor: null,
    });
    useMaskViewStore.setState({
      selectedMaskByClipId: {},
    });
  });

  function createMaskClip(localId: string, name: string): MaskTimelineClip {
    return {
      id: `clip_1::mask::${localId}`,
      parentClipId: "clip_1",
      trackId: "track_1",
      type: "mask",
      name,
      start: 0,
      sourceDuration: 10 * TICKS_PER_SECOND,
      timelineDuration: 10 * TICKS_PER_SECOND,
      croppedSourceDuration: 10 * TICKS_PER_SECOND,
      offset: 0,
      transformedDuration: 10 * TICKS_PER_SECOND,
      transformedOffset: 0,
      transformations: [],
      maskType: "rectangle",
      maskMode: "apply",
      maskInverted: false,
      maskParameters: { baseWidth: 20, baseHeight: 10 },
    };
  }

  function mockTimeline(
    transformations: Array<{
      id: string;
      type: string;
      isEnabled: boolean;
      filterName?: string;
      parameters: Record<string, unknown>;
    }>,
    maskClips: readonly MaskTimelineClip[] = [],
  ) {
    const parentClip = {
      ...baseClip,
      transformations,
      ...(maskClips.length > 0
        ? {
            components: maskClips.map((maskClip) => ({
              id: `${maskClip.id}_ref`,
              type: "mask_ref" as const,
              parameters: { maskClipId: maskClip.id },
            })),
          }
        : {}),
    };
    const state: {
      tracks: typeof tracks;
      selectedClipIds: string[];
      clips: Array<typeof parentClip | MaskTimelineClip>;
      addClipTransform: typeof mockAddClipTransform;
      updateClipTransform: typeof mockUpdateClipTransform;
      removeClipTransform: typeof mockRemoveClipTransform;
      setClipTransforms: typeof mockSetClipTransforms;
      setClipTransformsAndShape: typeof mockSetClipTransformsAndShape;
      updateClipShape: typeof mockUpdateClipShape;
      setClipMaskCompositeTransforms: typeof mockSetClipMaskCompositeTransforms;
      updateClipMask: typeof mockUpdateClipMask;
    } = {
      tracks,
      selectedClipIds: ["clip_1"],
      clips: [parentClip, ...maskClips],
      addClipTransform: mockAddClipTransform,
      updateClipTransform: mockUpdateClipTransform,
      removeClipTransform: mockRemoveClipTransform,
      setClipTransforms: mockSetClipTransforms,
      setClipTransformsAndShape: mockSetClipTransformsAndShape,
      updateClipShape: mockUpdateClipShape,
      setClipMaskCompositeTransforms: mockSetClipMaskCompositeTransforms,
      updateClipMask: mockUpdateClipMask,
    };
    const mockedStore = useTimelineStore as unknown as ReturnType<
      typeof vi.fn
    > & {
      getState: ReturnType<typeof vi.fn>;
    };
    mockedStore.mockImplementation(
      (selector: (store: typeof state) => unknown) => selector(state),
    );
    mockedStore.getState = vi.fn(() => state);
  }

  it("disables a dynamic section from its header checkbox", () => {
    mockTimeline([
      {
        id: "color_1",
        type: "filter",
        filterName: "HslAdjustmentFilter",
        isEnabled: true,
        parameters: { hue: 0, saturation: 0 },
      },
    ]);

    render(<EffectsPanel />);

    fireEvent.click(screen.getByLabelText("Color (HSL) enabled"));

    expect(mockSetClipTransforms).toHaveBeenCalledTimes(1);
    const [, nextTransforms] = mockSetClipTransforms.mock.calls[0];
    const toggled = (
      nextTransforms as Array<{ id: string; isEnabled: boolean }>
    ).find((transform) => transform.id === "color_1");
    expect(toggled?.isEnabled).toBe(false);
  }, 15000);

  it("materializes and disables missing default display transforms", () => {
    mockTimeline([]);

    render(<TransformationPanel />);

    fireEvent.click(screen.getByLabelText("Display enabled"));

    expect(mockSetClipTransforms).toHaveBeenCalledTimes(1);
    const [, nextTransforms] = mockSetClipTransforms.mock.calls[0];
    const typed = nextTransforms as Array<{ type: string; isEnabled: boolean }>;

    // Layout, Fit Mode and Blend Mode are unified into the single "Display"
    // section, so its toggle materialises all of them at once.
    expect(typed.map((transform) => transform.type)).toEqual([
      "position",
      "scale",
      "rotation",
      "fitMode",
      "blendMode",
    ]);
    expect(typed.every((transform) => transform.isEnabled === false)).toBe(true);
  });

  it("inserts disabled default display transforms before dynamic transforms", () => {
    mockTimeline([
      {
        id: "color_1",
        type: "filter",
        filterName: "HslAdjustmentFilter",
        isEnabled: true,
        parameters: { hue: 0, saturation: 0 },
      },
    ]);

    render(<TransformationPanel />);

    fireEvent.click(screen.getByLabelText("Display enabled"));

    expect(mockSetClipTransforms).toHaveBeenCalledTimes(1);
    const [, nextTransforms] = mockSetClipTransforms.mock.calls[0];
    const typed = nextTransforms as Array<{ type: string; isEnabled: boolean }>;

    // The unified Display toggle materialises position/scale/rotation/fitMode/
    // blendMode, inserted before the pre-existing dynamic filter.
    expect(typed.map((transform) => transform.type)).toEqual([
      "position",
      "scale",
      "rotation",
      "fitMode",
      "blendMode",
      "filter",
    ]);
    // Only the materialised default-transforms should be disabled; the
    // pre-existing dynamic filter remains enabled.
    expect(
      typed
        .slice(0, 5)
        .every((transform) => transform.isEnabled === false),
    ).toBe(true);
    expect(typed[5].isEnabled).toBe(true);
  });

  it("shows add path choices when no position path exists and can arm recording", () => {
    mockTimeline([
      {
        id: "position_1",
        type: "position",
        isEnabled: true,
        parameters: { x: 10, y: 20 },
      },
    ]);

    render(<TransformationPanel />);

    fireEvent.click(screen.getByText("Add Path"));
    fireEvent.click(screen.getByText("From Drag"));

    expect(screen.getByText("Cancel Recording")).toBeInTheDocument();
    expect(useTransformationViewStore.getState().armedPathRecording).toEqual({
      clipId: "clip_1",
      transformId: "position_1",
    });
  });

  it("lists each trackable mask as a selectable path source", () => {
    const faceMask = createMaskClip("face", "Face");
    const handMask = createMaskClip("hand", "Hand");
    useMaskViewStore.getState().setSelectedMask("clip_1", "hand");
    mockTimeline(
      [
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: { x: 10, y: 20 },
        },
      ],
      [faceMask, handMask],
    );

    render(<TransformationPanel />);

    fireEvent.click(screen.getByText("Add Path"));

    expect(screen.getByText("From Mask: Face")).toBeInTheDocument();
    const selectedMaskItem = screen.getByText("From Mask: Hand");
    expect(selectedMaskItem).toBeInTheDocument();
    expect(selectedMaskItem.closest("[role='menuitem']")).toHaveClass(
      "Mui-selected",
    );
  });

  it("shows path actions, disables position inputs, and opens the path detail view", () => {
    mockTimeline([
      {
        id: "position_1",
        type: "position",
        isEnabled: true,
        parameters: {
          x: 10,
          y: 20,
          path: {
            type: "path2d",
            curve: "centripetal_catmull_rom",
            controlPoints: [
              { x: 0, y: 0 },
              { x: 100, y: 40 },
            ],
            timing: {
              type: "spline",
              points: [
                { time: 0, value: 0 },
                { time: 1, value: 1 },
              ],
            },
          },
        },
      },
    ]);

    render(<TransformationPanel />);

    expect(screen.getByText("Edit Path")).toBeInTheDocument();
    expect(screen.getByText("Re-record")).toBeInTheDocument();
    expect(screen.getByText("Remove Path")).toBeInTheDocument();
    expect(screen.getAllByLabelText("X")[0]).toBeDisabled();
    expect(screen.getAllByLabelText("Y")[0]).toBeDisabled();

    fireEvent.click(screen.getByText("Edit Path"));

    expect(screen.getByText("Position Path")).toBeInTheDocument();
    expect(screen.getByText("Back To Transform")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Back To Transform"));

    expect(screen.getByRole("tab", { name: "Display" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(useTransformationViewStore.getState().pathPanelView).toBe("home");
  });
});
