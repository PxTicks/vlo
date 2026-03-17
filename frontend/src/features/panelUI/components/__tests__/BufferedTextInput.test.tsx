import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CommittedTextInput } from "../BufferedTextInput";

describe("CommittedTextInput", () => {
  it("does not re-commit the same draft before the parent updates", () => {
    const handleCommit = vi.fn();

    render(
      <CommittedTextInput
        initialValue=""
        onCommit={handleCommit}
        placeholder="Enter prompt..."
      />,
    );

    const input = screen.getByPlaceholderText("Enter prompt...");

    fireEvent.change(input, { target: { value: "draft prompt" } });
    fireEvent.blur(input);
    fireEvent.blur(input);

    expect(handleCommit).toHaveBeenCalledTimes(1);
    expect(handleCommit).toHaveBeenCalledWith("draft prompt");
  });
});
