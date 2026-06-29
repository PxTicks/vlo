import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ControlRenderer } from "../ControlRenderer";

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
});
