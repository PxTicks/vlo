import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectTitle } from "../ProjectTitle";

const mockState = vi.hoisted(() => ({
  project: null as { title: string } | null,
  updateTitle: vi.fn(async () => undefined),
}));

vi.mock("../../useProjectStore", () => ({
  useProjectStore: () => mockState,
}));

describe("ProjectTitle", () => {
  beforeEach(() => {
    mockState.project = { title: "Original title" };
    mockState.updateTitle.mockClear();
  });

  it("shows a loading state without a project", () => {
    mockState.project = null;
    render(<ProjectTitle />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("edits and saves a changed title on Enter", async () => {
    render(<ProjectTitle />);
    fireEvent.click(screen.getByTestId("project-title-display"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "  New title  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockState.updateTitle).toHaveBeenCalledWith("New title");
    });
    expect(mockState.updateTitle).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("project-title-display")).toBeInTheDocument();
  });

  it("restores the original title for empty or unchanged edits", async () => {
    render(<ProjectTitle />);
    fireEvent.click(screen.getByTestId("project-title-display"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(screen.getByTestId("project-title-display")).toHaveTextContent(
        "Original title",
      );
    });
    expect(mockState.updateTitle).not.toHaveBeenCalled();
  });

  it("cancels editing on Escape", () => {
    render(<ProjectTitle />);
    fireEvent.click(screen.getByTestId("project-title-display"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Discard me" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.getByTestId("project-title-display")).toHaveTextContent(
      "Original title",
    );
    expect(mockState.updateTitle).not.toHaveBeenCalled();
  });
});
