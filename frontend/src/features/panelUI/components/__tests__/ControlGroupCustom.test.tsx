import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ControlGroup } from "../ControlGroup";
import type { ControlRenderProps } from "../../types";

describe("ControlGroup custom controls", () => {
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
