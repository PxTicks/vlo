import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EffectMaskDialog } from "../EffectMaskDialog";
import type {
  EffectMask,
  MaskBooleanExpression,
  MaskTimelineClip,
} from "../../../../types/TimelineTypes";

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

describe("EffectMaskDialog", () => {
  it("shows the empty-state hint when the clip has no masks", () => {
    render(
      <EffectMaskDialog
        open
        onClose={() => {}}
        title="Color"
        masks={[]}
        effectMask={undefined}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("effect-mask-no-masks")).toBeInTheDocument();
  });

  it("shows the equation drop hint when masks exist but no equation is set", () => {
    render(
      <EffectMaskDialog
        open
        onClose={() => {}}
        title="Color"
        masks={[maskClip("m1")]}
        effectMask={undefined}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText("Drag mask here")).toBeInTheDocument();
  });

  it("keeps a disabled equation visible and greyed out", () => {
    const expression: MaskBooleanExpression = { kind: "mask_ref", maskId: "m1" };
    render(
      <EffectMaskDialog
        open
        onClose={() => {}}
        title="Color"
        masks={[maskClip("m1")]}
        effectMask={{ mode: "composite", enabled: false, expression }}
        onChange={() => {}}
      />,
    );

    expect(screen.getByTestId("mask-equation-mask-root")).toBeInTheDocument();
    expect(screen.getByTestId("mask-equation-content")).toHaveStyle({
      filter: "grayscale(1)",
      opacity: "0.55",
    });
  });

  it("toggling on emits a composite effect mask without dropping the expression", () => {
    const onChange = vi.fn();
    const expression: MaskBooleanExpression = { kind: "mask_ref", maskId: "m1" };
    render(
      <EffectMaskDialog
        open
        onClose={() => {}}
        title="Color"
        masks={[maskClip("m1")]}
        effectMask={{ mode: "composite", enabled: false, expression }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByTestId("mask-equation-enabled"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      mode: "composite",
      enabled: true,
      expression,
    } satisfies EffectMask);
  });

  it("does not expose the clip's mask-management actions menu", () => {
    render(
      <EffectMaskDialog
        open
        onClose={() => {}}
        title="Color"
        masks={[maskClip("m1")]}
        effectMask={undefined}
        onChange={() => {}}
      />,
    );
    // The variable chip renders, but with no edit/duplicate/delete affordance.
    expect(screen.getByTestId("mask-variable-chip-m1")).toBeInTheDocument();
    expect(screen.queryByTestId("mask-actions-button-m1")).toBeNull();
  });
});
