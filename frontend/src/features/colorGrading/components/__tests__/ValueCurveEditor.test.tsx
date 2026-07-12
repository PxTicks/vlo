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
    histogram: "luma",
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
    expect(onPreview).toHaveBeenCalledTimes(1);
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

  it("draws a histogram behind the active curve", () => {
    render(
      <ValueCurveEditor
        tabs={tabs}
        values={{ curveMaster: DEFAULT_COLOR_CURVES.curveMaster }}
        beforeHistograms={{
          luma: new Float32Array([0, 0.5, 1]),
          red: new Float32Array(),
          green: new Float32Array(),
          blue: new Float32Array(),
          hue: new Float32Array(),
        }}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Master histogram")).toHaveAttribute(
      "d",
      expect.stringContaining("L 100 0"),
    );
  });

  it("lets an endpoint move on both axes", () => {
    const onCommit = vi.fn();
    render(
      <ValueCurveEditor
        tabs={tabs}
        values={{ curveMaster: DEFAULT_COLOR_CURVES.curveMaster }}
        onPreview={vi.fn()}
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

    fireEvent.pointerDown(editor, { pointerId: 4, clientX: 0, clientY: 180 });
    fireEvent.pointerMove(editor, { pointerId: 4, clientX: 40, clientY: 140 });
    fireEvent.pointerUp(editor, { pointerId: 4, clientX: 40, clientY: 140 });
    expect(onCommit).toHaveBeenCalledWith(
      "curveMaster",
      expect.arrayContaining([
        expect.objectContaining({ x: 0.2, y: expect.closeTo(2 / 9, 4) }),
      ]),
    );
  });

  it("labels the neutral row on a resultant-hue field", () => {
    render(
      <ValueCurveEditor
        tabs={[
          {
            name: "curveHueHue",
            label: "H→H",
            color: "#fff",
            periodic: true,
            yMin: -0.5,
            yMax: 0.5,
            background: "#000",
            backgroundKind: "hue-result",
            histogram: "hue",
          },
        ]}
        values={{ curveHueHue: DEFAULT_COLOR_CURVES.curveHueHue }}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Zero curve adjustment")).toBeInTheDocument();
    expect(screen.getByText(/Field: resulting hue/)).toBeInTheDocument();
  });

  it("describes the hue and luma saturation response fields", () => {
    const modifierTabs: readonly CurveEditorTab[] = [
      {
        name: "curveHueSat",
        label: "H→S",
        color: "#fff",
        periodic: true,
        yMin: -0.5,
        yMax: 0.5,
        background: "#000",
        backgroundKind: "hue-saturation-result",
        histogram: "hue",
      },
      {
        name: "curveLumaSat",
        label: "L→S",
        color: "#fff",
        periodic: false,
        yMin: -0.5,
        yMax: 0.5,
        background: "#000",
        backgroundKind: "luma-saturation-result",
        histogram: "luma",
      },
    ];
    render(
      <ValueCurveEditor
        tabs={modifierTabs}
        values={{}}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByText(/relative resulting saturation by input hue/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "L→S" }));
    expect(screen.getByText(/reference blue by input luma/)).toBeInTheDocument();
  });
});
