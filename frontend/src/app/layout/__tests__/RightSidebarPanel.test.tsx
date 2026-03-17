import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { TextField } from "@mui/material";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { RightSidebarPanel } from "../RightSidebarPanel";
import { useTimelineStore } from "../../../features/timeline";
import { useMaskViewStore } from "../../../features/masks";

vi.mock("../../../features/timeline");

vi.mock("../../../features/transformations", () => ({
  TransformationPanel: () => (
    <div data-testid="mock-transform-panel">Transform Panel</div>
  ),
}));

vi.mock("../../../features/masks", () => ({
  MaskPanel: () => <div data-testid="mock-mask-panel">Mask Panel</div>,
  useMaskViewStore: Object.assign(vi.fn(), {
    getState: vi.fn(),
  }),
}));

vi.mock("../../../features/generation", () => ({
  GenerationPanel: function MockGenerationPanel() {
    const [value, setValue] = useState("");

    return (
      <div data-testid="mock-generation-panel">
        <TextField
          fullWidth
          multiline
          minRows={2}
          maxRows={6}
          label="Generation input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
    );
  },
}));

describe("RightSidebarPanel", () => {
  let selectedClipIds: string[] = [];
  const setMaskTabActive = vi.fn();

  beforeEach(() => {
    selectedClipIds = [];
    vi.clearAllMocks();

    (
      useTimelineStore as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(
      (selector: (state: { selectedClipIds: string[] }) => unknown) =>
        selector({ selectedClipIds }),
    );
    (
      useMaskViewStore as unknown as {
        getState: ReturnType<typeof vi.fn>;
      }
    ).getState.mockReturnValue({
      setMaskTabActive,
    });
  });

  it("shows only the Generate tab and generation panel when nothing is selected", () => {
    render(<RightSidebarPanel />);

    expect(screen.getByRole("tab", { name: "Generate" })).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Transform" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("mock-generation-panel")).toBeInTheDocument();
  });

  it("keeps Generate as the default tab when a clip is selected", () => {
    selectedClipIds = ["clip-1"];

    render(<RightSidebarPanel />);

    expect(screen.getByRole("tab", { name: "Transform" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Mask" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Generate" })).toBeInTheDocument();
    expect(screen.getByTestId("mock-generation-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-transform-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mock-mask-panel")).not.toBeInTheDocument();
  });

  it("renders Generate first so the tab order stays stable", () => {
    selectedClipIds = ["clip-1"];

    render(<RightSidebarPanel />);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Generate",
      "Transform",
      "Mask",
    ]);
  });

  it("shows mask panel when the Mask tab is selected", () => {
    selectedClipIds = ["clip-1"];

    render(<RightSidebarPanel />);

    fireEvent.click(screen.getByRole("tab", { name: "Mask" }));

    expect(screen.getByTestId("mock-mask-panel")).toBeInTheDocument();
  });

  it("preserves generation input state when switching tabs", async () => {
    selectedClipIds = ["clip-1"];

    render(<RightSidebarPanel />);

    const input = screen.getByLabelText("Generation input");
    fireEvent.change(input, { target: { value: "persistent prompt" } });

    fireEvent.click(screen.getByRole("tab", { name: "Transform" }));
    expect(screen.getByTestId("mock-transform-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Generate" }));
    expect(screen.getByLabelText("Generation input")).toHaveValue(
      "persistent prompt",
    );
  });

  it("tracks whether the Mask tab is active", () => {
    selectedClipIds = ["clip-1"];

    render(<RightSidebarPanel />);

    fireEvent.click(screen.getByRole("tab", { name: "Mask" }));
    expect(setMaskTabActive).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("tab", { name: "Transform" }));
    expect(setMaskTabActive).toHaveBeenCalledWith(false);
  });
});
