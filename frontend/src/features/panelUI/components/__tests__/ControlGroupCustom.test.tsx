import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ControlGroup } from "../ControlGroup";
import type { ControlRenderProps } from "../../types";

describe("ControlGroup custom controls", () => {
  it("keeps multi-column controls inside a resizable panel", () => {
    const { container } = render(
      <ControlGroup
        group={{
          id: "audio",
          title: "Audio",
          columns: 2,
          controls: [
            { type: "slider", name: "gain", label: "Gain" },
            { type: "slider", name: "mix", label: "Mix" },
          ],
        }}
        values={{ gain: 0, mix: 0.5 }}
        onCommit={vi.fn()}
        renderControl={({ control }) => <span>{control.label}</span>}
      />,
    );

    const group = container.firstElementChild;
    const grid = group?.lastElementChild;

    expect(group).toHaveStyle({ containerType: "inline-size", minWidth: 0 });
    expect(grid).toHaveStyle({
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      minWidth: 0,
    });
  });

  it("passes the transform's non-control parameters to rich controls", () => {
    const renderControl = vi.fn((props: ControlRenderProps) => (
      <span>{JSON.stringify(props.values.curveMaster)}</span>
    ));
    render(
      <ControlGroup
        group={{
          id: "curves",
          title: "Curves",
          controls: [
            {
              type: "custom",
              name: "_editor",
              label: "Editor",
              componentId: "test.curves",
            },
          ],
        }}
        values={{ curveMaster: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }}
        onCommit={vi.fn()}
        renderControl={renderControl}
      />,
    );

    expect(screen.getByText(/"x":1,"y":1/)).toBeInTheDocument();
    expect(renderControl).toHaveBeenCalledTimes(1);
  });
});
