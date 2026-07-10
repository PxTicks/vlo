import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_COLOR_CURVES } from "../../../../core/color";
import { ValueCurveEditor, type CurveEditorTab } from "../ValueCurveEditor";

const tabs: readonly CurveEditorTab[] = [
  {
    name: "curveMaster",
    label: "Master",
    color: "#fff",
    periodic: false,
    yMin: 0,
    yMax: 1,
    background: "#000",
  },
];

describe("ValueCurveEditor", () => {
  it("adds and commits a point", () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    render(
      <ValueCurveEditor
        tabs={tabs}
        values={{ curveMaster: DEFAULT_COLOR_CURVES.curveMaster }}
        onPreview={onPreview}
        onCommit={onCommit}
      />,
    );
    const editor = screen.getByLabelText(
      "Master curve editor",
    ) as unknown as SVGSVGElement;
    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 180,
      right: 200,
      bottom: 180,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    editor.setPointerCapture = vi.fn();
    editor.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(editor, { pointerId: 2, clientX: 100, clientY: 60 });
    fireEvent.pointerMove(editor, { pointerId: 2, clientX: 100, clientY: 55 });
    fireEvent.pointerUp(editor, { pointerId: 2, clientX: 100, clientY: 55 });
    expect(onPreview).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledWith(
      "curveMaster",
      expect.arrayContaining([expect.objectContaining({ x: 0.5 })]),
    );
  });

  it("resets the active curve on double click", () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    render(
      <ValueCurveEditor
        tabs={tabs}
        values={{ curveMaster: [{ x: 0, y: 0.2 }, { x: 1, y: 0.8 }] }}
        onPreview={onPreview}
        onCommit={onCommit}
      />,
    );
    fireEvent.doubleClick(screen.getByLabelText("Master curve editor"));
    expect(onCommit).toHaveBeenCalledWith(
      "curveMaster",
      DEFAULT_COLOR_CURVES.curveMaster,
    );
  });
});
