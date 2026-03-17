import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { TransformationPanel } from "../TransformationPanel";
import { useTimelineStore, TICKS_PER_SECOND } from "../../../timeline";

vi.mock("../../../timeline/useTimelineStore");

describe("TransformationPanel toggles", () => {
  const mockAddClipTransform = vi.fn();
  const mockUpdateClipTransform = vi.fn();
  const mockRemoveClipTransform = vi.fn();
  const mockSetClipTransforms = vi.fn();
  const mockUpdateClipShape = vi.fn();

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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockTimeline(
    transformations: Array<{
      id: string;
      type: string;
      isEnabled: boolean;
      filterName?: string;
      parameters: Record<string, unknown>;
    }>,
  ) {
    (
      useTimelineStore as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((selector: (state: {
      selectedClipIds: string[];
      clips: Array<
        typeof baseClip & {
          transformations: typeof transformations;
        }
      >;
      addClipTransform: typeof mockAddClipTransform;
      updateClipTransform: typeof mockUpdateClipTransform;
      removeClipTransform: typeof mockRemoveClipTransform;
      setClipTransforms: typeof mockSetClipTransforms;
      updateClipShape: typeof mockUpdateClipShape;
    }) => unknown) =>
      selector({
        selectedClipIds: ["clip_1"],
        clips: [
          {
            ...baseClip,
            transformations,
          },
        ],
        addClipTransform: mockAddClipTransform,
        updateClipTransform: mockUpdateClipTransform,
        removeClipTransform: mockRemoveClipTransform,
        setClipTransforms: mockSetClipTransforms,
        updateClipShape: mockUpdateClipShape,
      }),
    );
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

    render(<TransformationPanel />);

    fireEvent.click(screen.getByLabelText("Color (HSL) enabled"));

    expect(mockSetClipTransforms).toHaveBeenCalledTimes(1);
    const [, nextTransforms] = mockSetClipTransforms.mock.calls[0];
    const toggled = (
      nextTransforms as Array<{ id: string; isEnabled: boolean }>
    ).find((transform) => transform.id === "color_1");
    expect(toggled?.isEnabled).toBe(false);
  }, 15000);

  it("materializes and disables missing default layout transforms", () => {
    mockTimeline([]);

    render(<TransformationPanel />);

    fireEvent.click(screen.getByLabelText("Layout enabled"));

    expect(mockSetClipTransforms).toHaveBeenCalledTimes(1);
    const [, nextTransforms] = mockSetClipTransforms.mock.calls[0];
    const typed = nextTransforms as Array<{ type: string; isEnabled: boolean }>;

    expect(typed.map((transform) => transform.type)).toEqual([
      "position",
      "scale",
      "rotation",
    ]);
    expect(typed.every((transform) => transform.isEnabled === false)).toBe(true);
  });

  it("inserts disabled default layout transforms before dynamic transforms", () => {
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

    fireEvent.click(screen.getByLabelText("Layout enabled"));

    expect(mockSetClipTransforms).toHaveBeenCalledTimes(1);
    const [, nextTransforms] = mockSetClipTransforms.mock.calls[0];
    const typed = nextTransforms as Array<{ type: string; isEnabled: boolean }>;

    expect(typed.map((transform) => transform.type)).toEqual([
      "position",
      "scale",
      "rotation",
      "filter",
    ]);
    expect(
      typed
        .slice(0, 3)
        .every((transform) => transform.isEnabled === false),
    ).toBe(true);
  });
});
