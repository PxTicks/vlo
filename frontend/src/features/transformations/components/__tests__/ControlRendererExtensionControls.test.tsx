import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ControlRenderer } from "../ControlRenderer";
import { registerCustomControl } from "../../../panelUI";

describe("ControlRenderer extension controls", () => {
  it("commits text controls", () => {
    const onCommit = vi.fn();
    render(
      <ControlRenderer
        control={{
          type: "text",
          name: "label",
          label: "Shader label",
          defaultValue: "Default",
        }}
        value="Before"
        onCommit={onCommit}
        groupId="extension"
      />,
    );

    const input = screen.getByLabelText("Shader label");
    fireEvent.change(input, { target: { value: "After" } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith("After");
  });

  it("commits color controls", () => {
    const onCommit = vi.fn();
    render(
      <ControlRenderer
        control={{
          type: "color",
          name: "tint",
          label: "Shader tint",
          defaultValue: "#ffffff",
        }}
        value="#ffffff"
        onCommit={onCommit}
        groupId="extension"
      />,
    );

    const input = screen.getByLabelText("Shader tint");
    fireEvent.change(input, { target: { value: "#336699" } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith("#336699");
  });

  it("renders registered custom controls with atomic commit access", () => {
    const onCommitMany = vi.fn();
    const unregister = registerCustomControl("test.rich-control", (props) => (
      <button onClick={() => props.onCommitMany({ red: 0.2, blue: -0.1 })}>
        Rich {String(props.values.red)}
      </button>
    ));

    render(
      <ControlRenderer
        control={{
          type: "custom",
          name: "_rich",
          label: "Rich",
          componentId: "test.rich-control",
        }}
        value={undefined}
        values={{ red: 0.1 }}
        onCommit={vi.fn()}
        onCommitMany={onCommitMany}
        groupId="custom"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rich 0.1" }));
    expect(onCommitMany).toHaveBeenCalledWith({ red: 0.2, blue: -0.1 });
    unregister();
  });

  it("lets custom controls expose hidden parameters with spline controls", () => {
    const onCommitMany = vi.fn();
    const unregister = registerCustomControl("test.parameter-host", (props) => (
      <>{props.renderParameterControl?.({
        type: "number",
        name: "liftR",
        label: "Lift R",
        defaultValue: 0,
        supportsSpline: true,
      })}</>
    ));

    render(
      <ControlRenderer
        control={{
          type: "custom",
          name: "_wheels",
          label: "Wheels",
          componentId: "test.parameter-host",
        }}
        value={undefined}
        values={{ liftR: 0.1 }}
        onCommit={vi.fn()}
        onCommitMany={onCommitMany}
        groupId="wheels"
      />,
    );

    expect(screen.getByTitle("Edit Animation Curve")).toBeInTheDocument();
    const input = screen.getByLabelText("Lift R");
    fireEvent.change(input, { target: { value: "0.25" } });
    fireEvent.blur(input);
    expect(onCommitMany).toHaveBeenCalledWith({ liftR: 0.25 });
    unregister();
  });
});
