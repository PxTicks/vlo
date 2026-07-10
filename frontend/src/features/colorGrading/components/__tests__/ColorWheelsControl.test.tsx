import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ControlDefinition } from "../../../panelUI";
import { ColorWheelsControl } from "../ColorWheelsControl";

vi.mock("../ColorWheel", () => ({
  ColorWheel: ({ label }: { label: string }) => <div>{label}</div>,
}));

describe("ColorWheelsControl", () => {
  it("exposes every wheel channel through the host parameter renderer", () => {
    const renderParameterControl = vi.fn((control: ControlDefinition) => (
      <span>{control.name}</span>
    ));
    render(
      <ColorWheelsControl
        control={{ type: "custom", name: "_wheels", label: "Wheels" }}
        value={undefined}
        values={{}}
        onCommit={vi.fn()}
        onCommitMany={vi.fn()}
        groupId="wheels"
        renderParameterControl={renderParameterControl}
      />,
    );

    expect(renderParameterControl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Channel animation" }));
    const renderedNames = new Set(
      renderParameterControl.mock.calls.map(([control]) => control.name),
    );
    expect(renderedNames.size).toBe(16);
    expect(screen.getByText("liftR")).toBeInTheDocument();
    expect(screen.getByText("offsetMaster")).toBeInTheDocument();
  });
});
