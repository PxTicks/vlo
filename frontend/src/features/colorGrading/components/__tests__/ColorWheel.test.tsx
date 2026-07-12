import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ColorWheel } from "../ColorWheel";

describe("ColorWheel", () => {
  afterEach(() => vi.restoreAllMocks());

  function renderWheel(
    value = { r: 0, g: 0, b: 0, master: 0 },
  ) {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: vi.fn(),
    } as unknown as GPUCanvasContext);
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    render(
      <ColorWheel
        label="Lift"
        value={value}
        maxChroma={0.3}
        maxMaster={0.5}
        onPreview={onPreview}
        onCommit={onCommit}
      />,
    );
    const canvas = screen.getByLabelText("Lift color wheel") as HTMLCanvasElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 96,
      height: 96,
      right: 96,
      bottom: 96,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    return { canvas, onPreview, onCommit };
  }

  it("previews during a disc drag and commits on release", () => {
    const { canvas, onPreview, onCommit } = renderWheel();
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 76, clientY: 48 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 82, clientY: 48 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 82, clientY: 48 });
    expect(onPreview).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].r).toBeGreaterThan(0);
  });

  it("resets the color channels without changing master on double click", () => {
    const { canvas, onCommit } = renderWheel({
      r: 0.1,
      g: -0.05,
      b: -0.05,
      master: 0.2,
    });
    fireEvent.doubleClick(canvas);
    expect(onCommit).toHaveBeenCalledWith({ r: 0, g: 0, b: 0, master: 0.2 });
  });

  it("exposes master as a separate vertical slider", () => {
    const { onPreview } = renderWheel();
    const slider = screen.getByRole("slider", { name: "Lift master" });
    expect(slider).toHaveAttribute("aria-orientation", "vertical");
    expect(slider).toHaveAttribute("aria-valuemin", "-0.5");
    expect(slider).toHaveAttribute("aria-valuemax", "0.5");

    fireEvent.change(slider, { target: { value: "0.25" } });
    expect(onPreview).toHaveBeenCalledWith({
      r: 0,
      g: 0,
      b: 0,
      master: 0.25,
    });
  });

  it("resets master from its slider", () => {
    const { onCommit } = renderWheel({
      r: 0.1,
      g: -0.05,
      b: -0.05,
      master: 0.2,
    });
    fireEvent.doubleClick(screen.getByRole("slider", { name: "Lift master" }));
    expect(onCommit).toHaveBeenCalledWith({
      r: 0.1,
      g: -0.05,
      b: -0.05,
      master: 0,
    });
  });

  it("rebases when Shift changes so fine drag does not jump", () => {
    const { canvas, onPreview } = renderWheel();
    fireEvent.pointerDown(canvas, { pointerId: 3, clientX: 68, clientY: 48 });
    fireEvent.pointerMove(canvas, { pointerId: 3, clientX: 78, clientY: 48 });
    const beforeShift = onPreview.mock.calls.at(-1)?.[0];
    const callsBeforeShift = onPreview.mock.calls.length;

    fireEvent.pointerMove(canvas, {
      pointerId: 3,
      clientX: 78,
      clientY: 48,
      shiftKey: true,
    });
    expect(onPreview).toHaveBeenCalledTimes(callsBeforeShift);
    fireEvent.pointerMove(canvas, {
      pointerId: 3,
      clientX: 83,
      clientY: 48,
      shiftKey: true,
    });
    const afterFineMove = onPreview.mock.calls.at(-1)?.[0];
    expect(afterFineMove.r).toBeGreaterThan(beforeShift.r);
    expect(afterFineMove.r - beforeShift.r).toBeLessThan(0.02);
  });
});
