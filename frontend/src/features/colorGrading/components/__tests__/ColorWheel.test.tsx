import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ColorWheel } from "../ColorWheel";

describe("ColorWheel", () => {
  afterEach(() => vi.restoreAllMocks());

  function renderWheel() {
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
        value={{ r: 0, g: 0, b: 0, master: 0 }}
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
      width: 112,
      height: 112,
      right: 112,
      bottom: 112,
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
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 86, clientY: 56 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 90, clientY: 56 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 90, clientY: 56 });
    expect(onPreview).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].r).toBeGreaterThan(0);
  });

  it("resets all channels on double click", () => {
    const { canvas, onCommit } = renderWheel();
    fireEvent.doubleClick(canvas);
    expect(onCommit).toHaveBeenCalledWith({ r: 0, g: 0, b: 0, master: 0 });
  });

  it("rebases when Shift changes so fine drag does not jump", () => {
    const { canvas, onPreview } = renderWheel();
    fireEvent.pointerDown(canvas, { pointerId: 3, clientX: 76, clientY: 56 });
    fireEvent.pointerMove(canvas, { pointerId: 3, clientX: 86, clientY: 56 });
    const beforeShift = onPreview.mock.calls.at(-1)?.[0];
    const callsBeforeShift = onPreview.mock.calls.length;

    fireEvent.pointerMove(canvas, {
      pointerId: 3,
      clientX: 86,
      clientY: 56,
      shiftKey: true,
    });
    expect(onPreview).toHaveBeenCalledTimes(callsBeforeShift);
    fireEvent.pointerMove(canvas, {
      pointerId: 3,
      clientX: 91,
      clientY: 56,
      shiftKey: true,
    });
    const afterFineMove = onPreview.mock.calls.at(-1)?.[0];
    expect(afterFineMove.r).toBeGreaterThan(beforeShift.r);
    expect(afterFineMove.r - beforeShift.r).toBeLessThan(0.02);
  });
});
