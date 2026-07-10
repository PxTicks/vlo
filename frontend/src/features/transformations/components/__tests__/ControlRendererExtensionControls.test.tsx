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
});
