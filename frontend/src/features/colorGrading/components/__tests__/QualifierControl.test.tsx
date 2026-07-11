import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_COLOR_QUALIFIER } from "../../../../core/color";
import { livePreviewParamStore } from "../../../../core/liveParams/livePreviewParamStore";
import type { CustomControlRenderProps } from "../../../panelUI";
import { QualifierControl } from "../QualifierControl";

const control: CustomControlRenderProps["control"] = {
  type: "custom",
  label: "Qualifier",
  name: "_qualifier",
};

describe("QualifierControl", () => {
  afterEach(() => livePreviewParamStore.clearAll());

  it("enables the qualifier and commits accessible range handles", () => {
    const onCommitMany = vi.fn();
    render(
      <QualifierControl
        control={control}
        value={undefined}
        values={DEFAULT_COLOR_QUALIFIER}
        onCommit={vi.fn()}
        onCommitMany={onCommitMany}
        groupId="color_grade_qualifier"
        transformId="grade-1"
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Enable" }));
    expect(onCommitMany).toHaveBeenCalledWith({
      qualifierEnabled: true,
      mattePreview: false,
    });

    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Hue inner low" }),
      { key: "ArrowRight" },
    );
    expect(onCommitMany).toHaveBeenLastCalledWith({
      hueCenter: expect.closeTo(0.005),
      hueWidth: expect.closeTo(0.99),
      hueSoftLo: expect.closeTo(0.01),
    });
  });

  it("moves compact boundaries and the complete selected range", () => {
    const onCommitMany = vi.fn();
    render(
      <QualifierControl
        control={control}
        value={undefined}
        values={{
          ...DEFAULT_COLOR_QUALIFIER,
          qualifierEnabled: true,
          hueCenter: 0,
          hueWidth: 0.2,
          hueSoftLo: 0.05,
          hueSoftHi: 0.05,
        }}
        onCommit={vi.fn()}
        onCommitMany={onCommitMany}
        groupId="color_grade_qualifier"
        transformId="grade-2"
      />,
    );

    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Hue outer low" }),
      { key: "ArrowLeft" },
    );
    expect(onCommitMany).toHaveBeenLastCalledWith({
      hueSoftLo: expect.closeTo(0.06),
    });

    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Hue selected range" }),
      { key: "ArrowRight" },
    );
    expect(onCommitMany).toHaveBeenLastCalledWith({
      hueCenter: expect.closeTo(0.01),
    });
  });

  it("pushes paired inner handles when outer handles cross them", () => {
    const onCommitMany = vi.fn();
    render(
      <QualifierControl
        control={control}
        value={undefined}
        values={{
          ...DEFAULT_COLOR_QUALIFIER,
          qualifierEnabled: true,
          hueCenter: 0,
          hueWidth: 0.2,
          satLo: 0.3,
          satHi: 0.8,
        }}
        onCommit={vi.fn()}
        onCommitMany={onCommitMany}
        groupId="color_grade_qualifier"
        transformId="grade-3"
      />,
    );

    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Hue outer low" }),
      { key: "ArrowRight" },
    );
    expect(onCommitMany).toHaveBeenLastCalledWith({
      hueCenter: expect.closeTo(0.005),
      hueWidth: expect.closeTo(0.19),
      hueSoftLo: 0,
    });

    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Saturation outer low" }),
      { key: "ArrowRight" },
    );
    expect(onCommitMany).toHaveBeenLastCalledWith({
      satLo: expect.closeTo(0.31),
      satSoftLo: 0,
    });
  });

  it("commits the exact pushed preview snapshot on pointer release", () => {
    const onCommitMany = vi.fn();
    render(
      <QualifierControl
        control={control}
        value={undefined}
        values={{
          ...DEFAULT_COLOR_QUALIFIER,
          qualifierEnabled: true,
          hueCenter: 0,
          hueWidth: 0.2,
        }}
        onCommit={vi.fn()}
        onCommitMany={onCommitMany}
        groupId="color_grade_qualifier"
        transformId="grade-4"
      />,
    );
    const handle = screen.getByRole("slider", {
      name: "Hue outer low",
    });
    const svg = handle.ownerSVGElement;
    expect(svg).not.toBeNull();
    if (!svg) return;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 24,
      width: 100,
      height: 24,
      toJSON: () => ({}),
    });
    Object.defineProperty(svg, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(svg, "releasePointerCapture", { value: vi.fn() });

    fireEvent.pointerDown(handle, { clientX: 40, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 41, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 41, pointerId: 1 });

    expect(onCommitMany).toHaveBeenCalledOnce();
    expect(onCommitMany).toHaveBeenCalledWith({
      hueCenter: expect.closeTo(0.005),
      hueWidth: expect.closeTo(0.19),
      hueSoftLo: 0,
    });
  });
});
