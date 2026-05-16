import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BufferedColorInput } from "../BufferedColorInput";

describe("BufferedColorInput", () => {
  it("buffers color changes until blur", () => {
    const handleCommit = vi.fn();

    render(
      <BufferedColorInput value="#ffffff" onCommit={handleCommit} label="Color" />,
    );

    const input = screen.getByLabelText("Color");

    fireEvent.change(input, { target: { value: "#ff5500" } });

    expect(handleCommit).not.toHaveBeenCalled();

    fireEvent.blur(input);

    expect(handleCommit).toHaveBeenCalledTimes(1);
    expect(handleCommit).toHaveBeenCalledWith("#ff5500");
  });

  it("does not re-commit unchanged values", () => {
    const handleCommit = vi.fn();

    render(
      <BufferedColorInput value="#ffffff" onCommit={handleCommit} label="Color" />,
    );

    const input = screen.getByLabelText("Color");

    fireEvent.blur(input);

    expect(handleCommit).not.toHaveBeenCalled();
  });
});
