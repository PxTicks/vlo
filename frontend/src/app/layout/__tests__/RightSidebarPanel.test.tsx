import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { TextField } from "@mui/material";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { RightSidebarPanel } from "../RightSidebarPanel";
import {
  useSelectedTimelineClipIds,
  useTimelineClip,
} from "../../../features/timeline/api";
import { useMaskViewStore } from "../../../features/masks";
import type { TimelineClip } from "../../../types/TimelineTypes";

vi.mock("../../../features/timeline/api", () => ({
  useSelectedTimelineClipIds: vi.fn(),
  useTimelineClip: vi.fn(),
}));

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
  let clips: Array<Pick<TimelineClip, "id" | "type">> = [];
  const setMaskTabActive = vi.fn();

  beforeEach(() => {
    selectedClipIds = [];
    clips = [];
    vi.clearAllMocks();

    vi.mocked(useSelectedTimelineClipIds).mockImplementation(
      () => selectedClipIds,
    );
    vi.mocked(useTimelineClip).mockImplementation((clipId) =>
      clips.find((clip) => clip.id === clipId) as TimelineClip | undefined,
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

  it("defaults to the Transform tab when a clip is selected", () => {
    selectedClipIds = ["clip-1"];

    render(<RightSidebarPanel />);

    expect(screen.getByRole("tab", { name: "Transform" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Mask" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Generate" })).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Audio Split" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("mock-transform-panel")).toBeInTheDocument();
    expect(screen.getByTestId("mock-mask-panel")).toBeInTheDocument();
    expect(screen.getByTestId("mock-mask-panel").closest('[role="tabpanel"]'))
      .toHaveAttribute("aria-hidden", "true");
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

  it("hides the Mask tab and panel for adjustment clips", () => {
    // Adjustment clips bypass applyClipTransforms entirely, so neither
    // ClipMask attachments nor range-mask components have any render-time
    // effect. We hide the tab AND assert the panel doesn't mount —
    // visibleTab is derived synchronously so the Tabs `value` never points
    // at a tab whose child isn't rendered (no MUI invalid-value warning).
    selectedClipIds = ["adj-1"];
    clips = [{ id: "adj-1", type: "adjustment" }];

    render(<RightSidebarPanel />);

    expect(screen.getByRole("tab", { name: "Transform" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Mask" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("mock-mask-panel")).not.toBeInTheDocument();
  });

});
