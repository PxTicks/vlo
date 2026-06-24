import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EffectMaskControl } from "../EffectMaskControl";
import { useTimelineStore } from "../../../timeline";
import type {
  ClipTransform,
  MaskTimelineClip,
} from "../../../../types/TimelineTypes";

vi.mock("../../../timeline", () => ({
  useTimelineStore: vi.fn(),
  selectMaskClipsForParent: vi.fn(() => []),
}));

const mockedUseTimelineStore = useTimelineStore as unknown as Mock;

function maskClip(localId: string): MaskTimelineClip {
  return {
    id: `clip_1::mask::${localId}`,
    type: "mask",
    name: "",
    trackId: "t1",
    start: 0,
    timelineDuration: 100,
    offset: 0,
  } as unknown as MaskTimelineClip;
}

function filterTransform(effectMask?: ClipTransform["effectMask"]): ClipTransform {
  return {
    id: "color_1",
    type: "filter",
    isEnabled: true,
    parameters: {},
    ...(effectMask ? { effectMask } : {}),
  };
}

function setStoreMasks(masks: MaskTimelineClip[]) {
  // Components call useTimelineStore(useShallow(selector)); echo the masks
  // regardless of the selector for these UI-focused tests.
  mockedUseTimelineStore.mockImplementation(() => masks);
}

describe("EffectMaskControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStoreMasks([]);
  });

  it("shows 'Add mask' and no remove action when no effect mask is set", () => {
    render(
      <EffectMaskControl
        transform={filterTransform()}
        clipId="clip_1"
        transformTitle="Color"
      />,
    );
    expect(screen.getByTestId("effect-mask-button-color_1")).toHaveTextContent(
      "Add mask",
    );
    expect(screen.queryByTestId("effect-mask-remove-color_1")).toBeNull();
  });

  it("shows 'Edit mask' + 'Remove mask' when an effect mask is active", () => {
    render(
      <EffectMaskControl
        transform={filterTransform({
          mode: "composite",
          enabled: true,
          expression: { kind: "mask_ref", maskId: "m1" },
        })}
        clipId="clip_1"
        transformTitle="Color"
      />,
    );
    expect(screen.getByTestId("effect-mask-button-color_1")).toHaveTextContent(
      "Edit mask",
    );
    expect(
      screen.getByTestId("effect-mask-remove-color_1"),
    ).toBeInTheDocument();
  });

  it("Remove disables the effect mask via onUpdateTransform (back to legacy)", () => {
    const onUpdateTransform = vi.fn();
    render(
      <EffectMaskControl
        transform={filterTransform({
          mode: "composite",
          enabled: true,
          expression: { kind: "mask_ref", maskId: "m1" },
        })}
        clipId="clip_1"
        transformTitle="Color"
        onUpdateTransform={onUpdateTransform}
      />,
    );

    fireEvent.click(screen.getByTestId("effect-mask-remove-color_1"));

    expect(onUpdateTransform).toHaveBeenCalledWith("color_1", {
      effectMask: { mode: "composite", enabled: false, expression: null },
    });
  });

  it("opens the dialog (lazily) only on click, surfacing the clip's masks", () => {
    setStoreMasks([maskClip("m1")]);
    render(
      <EffectMaskControl
        transform={filterTransform()}
        clipId="clip_1"
        transformTitle="Color"
      />,
    );
    expect(screen.queryByTestId("effect-mask-dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("effect-mask-button-color_1"));

    expect(screen.getByTestId("effect-mask-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("mask-variable-chip-m1")).toBeInTheDocument();
  });
});
