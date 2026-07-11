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
    render(
      <ToneResponseGraph
        parameters={IDENTITY}
        onPreview={onPreview}
        onCommit={onCommit}
      />,
    );
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
    }) as unknown as SVGCircleElement;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 200, clientY: 60 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 200, clientY: 84 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 200, clientY: 84 });

    expect(onPreview).toHaveBeenLastCalledWith("highlight", 1);
    expect(onCommit).toHaveBeenCalledWith("highlight", 1);
  });
});
