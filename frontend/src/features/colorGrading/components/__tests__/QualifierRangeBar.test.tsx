import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { QualifierRangeBar } from "../QualifierRangeBar";

describe("QualifierRangeBar", () => {
  it("mirrors low and high handles and layers thinner inner handles last", () => {
    const { container } = render(
      <QualifierRangeBar
        label="Hue"
        background="#000"
        boundaries={[
          { id: "outerLow", position: 0.5, value: 0.5 },
          { id: "innerLow", position: 0.5, value: 0.5 },
          { id: "innerHigh", position: 0.5, value: 0.5 },
          { id: "outerHigh", position: 0.5, value: 0.5 },
        ]}
        weightAt={() => 1}
        formatValue={(value) => String(value)}
        onInteractionStart={vi.fn()}
        onInteractionCommit={vi.fn()}
        onBoundaryChange={vi.fn()}
        onRangeShift={vi.fn()}
      />,
    );

    const handles = [
      ...container.querySelectorAll<SVGGElement>("[data-boundary]"),
    ];
    expect(handles.map((handle) => handle.dataset.boundary)).toEqual([
      "outerLow",
      "outerHigh",
      "innerLow",
      "innerHigh",
    ]);
    expect(handles[0].querySelector("path")).toHaveAttribute(
      "d",
      "M 50 7 L 50 22 L 46.4 22 L 46.4 11 Z",
    );
    expect(handles[1].querySelector("path")).toHaveAttribute(
      "d",
      "M 50 7 L 53.6 11 L 53.6 22 L 50 22 Z",
    );
    expect(handles[2].querySelector("path")).toHaveAttribute(
      "d",
      "M 50 7 L 50 22 L 48 22 L 48 11 Z",
    );
    expect(handles[3].querySelector("path")).toHaveAttribute(
      "d",
      "M 50 7 L 52 11 L 52 22 L 50 22 Z",
    );
  });

  it("commits the pending preview without recalculating on pointer release", () => {
    const onBoundaryChange = vi.fn();
    const onInteractionStart = vi.fn();
    const onInteractionCommit = vi.fn();
    const { container } = render(
      <QualifierRangeBar
        label="Saturation"
        background="#000"
        boundaries={[
          { id: "outerLow", position: 0.5, value: 0.5 },
          { id: "innerLow", position: 0.5, value: 0.5 },
          { id: "innerHigh", position: 0.8, value: 0.8 },
          { id: "outerHigh", position: 0.9, value: 0.9 },
        ]}
        weightAt={() => 1}
        formatValue={(value) => String(value)}
        onBoundaryChange={onBoundaryChange}
        onRangeShift={vi.fn()}
        onInteractionStart={onInteractionStart}
        onInteractionCommit={onInteractionCommit}
      />,
    );
    const svg = container.querySelector("svg");
    const handle = container.querySelector<SVGGElement>(
      '[data-boundary="outerLow"]',
    );
    expect(svg).not.toBeNull();
    expect(handle).not.toBeNull();
    if (!svg || !handle) return;
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

    fireEvent.pointerDown(handle, { clientX: 50, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 60, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 60, pointerId: 1 });

    expect(onInteractionStart).toHaveBeenCalledOnce();
    expect(onBoundaryChange).toHaveBeenCalledOnce();
    expect(onBoundaryChange).toHaveBeenCalledWith("outerLow", 0.6, false);
    expect(onInteractionCommit).toHaveBeenCalledOnce();
  });
});
