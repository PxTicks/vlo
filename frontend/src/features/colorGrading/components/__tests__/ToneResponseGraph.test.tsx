import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToneResponseGraph } from "../ToneResponseGraph";

const IDENTITY = {
  contrast: 1,
  pivot: 0.435,
  kneeThreshold: 1,
  kneeSoftness: 0,
  toeAmount: 0,
  toeSoftness: 0,
};

describe("ToneResponseGraph", () => {
  it("draws the super-white domain and exposes both handles", () => {
    render(
      <ToneResponseGraph
        parameters={IDENTITY}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("SUPER-WHITE")).toBeInTheDocument();
    expect(
      screen.getByRole("slider", { name: "Highlight rolloff handle" }),
    ).toHaveAttribute("aria-valuenow", "0");
    expect(
      screen.getByRole("slider", { name: "Shadow lift handle" }),
    ).toHaveAttribute("aria-valuenow", "0");
  });

  it("maps a downward highlight drag to the full linked rolloff", () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(
      <ToneResponseGraph
        parameters={IDENTITY}
        onPreview={onPreview}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const handle = mockedHighlightHandle();

    // The threshold spans 1.5 → 0.8 of a 1.5 domain over 180px: 84px.
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 292, clientY: 8 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 292, clientY: 92 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 292, clientY: 92 });

    const full = {
      kneeThreshold: expect.closeTo(0.8, 10),
      kneeSoftness: expect.closeTo(0.3, 10),
    };
    expect(onPreview).toHaveBeenLastCalledWith(full);
    expect(onCommit).toHaveBeenCalledWith(full);
  });

  it("centres an inactive highlight handle on the top-right corner", () => {
    render(
      <ToneResponseGraph
        parameters={IDENTITY}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const handle = screen.getByRole("slider", {
      name: "Highlight rolloff handle",
    });
    // Centred on the curve's true end, so the graph clips it to a quarter.
    expect(handle).toHaveAttribute("transform", "translate(300 0)");
  });

  it("continues a drag from exact values without snapping", () => {
    const onPreview = vi.fn();
    render(
      <ToneResponseGraph
        parameters={{ ...IDENTITY, kneeThreshold: 0.9, kneeSoftness: 0.1 }}
        onPreview={onPreview}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const handle = mockedHighlightHandle();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 200, clientY: 72 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 200, clientY: 73 });

    const [update] = onPreview.mock.lastCall ?? [];
    // One pixel moves both parameters by a pixel's worth, not onto the line.
    expect(update.kneeThreshold).toBeCloseTo(0.9, 1);
    expect(update.kneeSoftness).toBeCloseTo(0.1, 1);
  });

  it("cancels instead of committing a click without movement", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const start = { ...IDENTITY, kneeThreshold: 0.9, kneeSoftness: 0.1 };
    render(
      <ToneResponseGraph
        parameters={start}
        onPreview={vi.fn()}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const handle = mockedHighlightHandle();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 200, clientY: 72 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 200, clientY: 72 });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledWith(start);
  });

  it("cancels a drag released where it began", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(
      <ToneResponseGraph
        parameters={IDENTITY}
        onPreview={vi.fn()}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const handle = mockedHighlightHandle();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 292, clientY: 8 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 292, clientY: 40 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 292, clientY: 8 });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it.each([1.5, 1.499])(
    "keeps an active knee's transition when dragging from threshold %s",
    (kneeThreshold) => {
      const onPreview = vi.fn();
      const onCommit = vi.fn();
      const onCancel = vi.fn();
      render(
        <ToneResponseGraph
          parameters={{ ...IDENTITY, kneeThreshold, kneeSoftness: 0.2 }}
          onPreview={onPreview}
          onCommit={onCommit}
          onCancel={onCancel}
        />,
      );
      const handle = mockedHighlightHandle();

      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 292, clientY: 8 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 292, clientY: 8 });
      expect(onCommit).not.toHaveBeenCalled();

      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 292, clientY: 8 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 292, clientY: 9 });
      const [update] = onPreview.mock.lastCall ?? [];
      expect(update.kneeThreshold).toBeCloseTo(kneeThreshold, 1);
      expect(update.kneeSoftness).toBeCloseTo(0.2, 2);
    },
  );

  it("ignores keys that would not move an inactive handle", () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(
      <ToneResponseGraph
        parameters={IDENTITY}
        onPreview={onPreview}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const highlight = screen.getByRole("slider", {
      name: "Highlight rolloff handle",
    });
    fireEvent.keyDown(highlight, { key: "Home" });
    fireEvent.keyDown(highlight, { key: "ArrowUp" });

    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

function mockedHighlightHandle(): SVGGElement {
  const graph = screen.getByLabelText("Tone response graph");
  vi.spyOn(graph, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 300,
    bottom: 180,
    width: 300,
    height: 180,
    toJSON: () => ({}),
  });
  const handle = screen.getByRole("slider", {
    name: "Highlight rolloff handle",
  }) as unknown as SVGGElement;
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();
  return handle;
}
