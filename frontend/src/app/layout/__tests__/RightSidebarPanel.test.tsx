import { act, render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { TextField } from "@mui/material";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { RightSidebarPanel } from "../RightSidebarPanel";
import {
  useSelectedTimelineClipIds,
  useSelectedTimelineTransitionId,
  useTimelineClip,
} from "../../../features/timeline/api";
import { useMaskViewStore } from "../../../features/masks";
import type { TimelineClip } from "../../../types/TimelineTypes";
import type {
  ExtensionApiScope,
  ExtensionResource,
  ExtensionUiWorkspaceComponentProps,
} from "../../../features/extensions";
import { extensionUiSlotRegistry } from "../../../features/extensions/ui/publicApi";

vi.mock("../../../features/timeline/api", () => ({
  useSelectedTimelineClipIds: vi.fn(),
  useSelectedTimelineTransitionId: vi.fn(),
  useTimelineClip: vi.fn(),
}));

vi.mock("../../../features/transformations", () => ({
  TransformationPanel: () => (
    <div data-testid="mock-transform-panel">Transform Panel</div>
  ),
  EffectsPanel: () => <div data-testid="mock-effects-panel">Effects Panel</div>,
}));

vi.mock("../../../features/transitions", () => ({
  TransitionPanel: () => (
    <div data-testid="mock-transition-panel">Transition Panel</div>
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
    vi.mocked(useSelectedTimelineTransitionId).mockReturnValue(null);
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
      screen.queryByRole("tab", { name: "Adjust" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("mock-generation-panel")).toBeInTheDocument();
  });

  it("defaults to the Adjust tab when a clip is selected", () => {
    selectedClipIds = ["clip-1"];

    render(<RightSidebarPanel />);

    expect(
      screen.getByRole("tab", { name: "Adjust" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Transform" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Mask" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Generate" })).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Audio Split" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("mock-transform-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-effects-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mock-mask-panel")).not.toBeInTheDocument();
  });

  it("renders Generate first so the tab order stays stable", () => {
    selectedClipIds = ["clip-1"];

    render(<RightSidebarPanel />);

    const tabs = screen.getAllByRole("tab");

    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Generate",
      "Adjust",
      "Transform",
      "Mask",
    ]);
    tabs.forEach((tab) => expect(tab).toHaveClass("MuiTab-fullWidth"));
  });

  it("shows mask panel when the Mask tab is selected", () => {
    selectedClipIds = ["clip-1"];

    render(<RightSidebarPanel />);

    fireEvent.click(screen.getByRole("tab", { name: "Mask" }));

    expect(screen.getByTestId("mock-mask-panel")).toBeInTheDocument();
  });

  it("shows the added-effects inspector in its own panel", () => {
    selectedClipIds = ["clip-1"];

    render(<RightSidebarPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Transform" }));

    expect(screen.getByTestId("mock-effects-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-transform-panel")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("mock-effects-panel").closest('[role="tabpanel"]'),
    ).toHaveAttribute("aria-hidden", "false");
  });

  it("preserves generation input state when switching tabs", async () => {
    selectedClipIds = ["clip-1"];

    render(<RightSidebarPanel />);

    const input = screen.getByLabelText("Generation input");
    fireEvent.change(input, { target: { value: "persistent prompt" } });

    fireEvent.click(screen.getByRole("tab", { name: "Adjust" }));
    expect(screen.getByTestId("mock-transform-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Generate" }));
    expect(screen.getByLabelText("Generation input")).toHaveValue(
      "persistent prompt",
    );
  });

  it("hosts stateful extension workspaces in the sidebar overflow menu", () => {
    const scope: ExtensionApiScope = {
      extension: { id: "example.canvas", version: "1.0.0" },
      signal: new AbortController().signal,
      own: <TResource extends ExtensionResource>(resource: TResource) => resource,
      report: vi.fn(),
    };
    const ui = extensionUiSlotRegistry.bind(scope);

    function StatefulWorkspace({ active }: ExtensionUiWorkspaceComponentProps) {
      const [value, setValue] = useState("");
      return (
        <label>
          Workspace value
          <canvas aria-label="Workspace canvas" />
          <input
            aria-label="Workspace value"
            data-active={String(active)}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
      );
    }
    const registration = ui.registerWorkspace({
      id: "drawing",
      apiVersion: 1,
      kind: "trusted-workspace",
      title: "AI Canvas",
      location: "right-sidebar",
      component: StatefulWorkspace,
    });

    try {
      render(<RightSidebarPanel />);

      expect(
        screen.queryByRole("tab", { name: "AI Canvas" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Generate" })).toHaveClass(
        "MuiTab-fullWidth",
      );
      const workspaceMenuButton = screen.getByRole("button", {
        name: "More panels",
      });
      expect(workspaceMenuButton).toHaveAttribute("aria-pressed", "false");
      expect(
        screen.queryByRole("menuitem", { name: "AI Canvas" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Workspace value")).not.toBeInTheDocument();

      act(() => expect(ui.openWorkspace("drawing")).toBe(true));
      expect(workspaceMenuButton).toHaveAttribute("aria-pressed", "true");
      expect(
        screen.getByRole("tabpanel", { name: "AI Canvas" }),
      ).toHaveAttribute(
        "id",
        "extension-workspace-panel-example.canvas/drawing",
      );
      expect(screen.getByLabelText("Workspace canvas")).toBeInstanceOf(
        globalThis.HTMLCanvasElement,
      );
      const input = screen.getByLabelText("Workspace value");
      expect(input).toHaveAttribute("data-active", "true");
      fireEvent.change(input, { target: { value: "unfinished sketch" } });

      fireEvent.click(screen.getByRole("tab", { name: "Generate" }));
      expect(input).toHaveValue("unfinished sketch");
      expect(input).toHaveAttribute("data-active", "false");

      fireEvent.click(workspaceMenuButton);
      const workspaceMenuItem = screen.getByRole("menuitem", {
        name: "AI Canvas",
      });
      expect(workspaceMenuItem).not.toHaveClass("Mui-selected");
      fireEvent.click(workspaceMenuItem);
      expect(input).toHaveValue("unfinished sketch");
      expect(input).toHaveAttribute("data-active", "true");

      act(() => registration.dispose());
      expect(
        screen.queryByRole("button", { name: "More panels" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Generate" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    } finally {
      registration.dispose();
    }
  });

  it("tracks whether the Mask tab is active", () => {
    selectedClipIds = ["clip-1"];

    render(<RightSidebarPanel />);

    fireEvent.click(screen.getByRole("tab", { name: "Mask" }));
    expect(setMaskTabActive).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("tab", { name: "Adjust" }));
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

    expect(
      screen.getByRole("tab", { name: "Adjust" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Mask" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("mock-mask-panel")).not.toBeInTheDocument();
  });

  it("shows the transition panel for a selected transition", () => {
    vi.mocked(useSelectedTimelineTransitionId).mockReturnValue("transition-1");

    render(<RightSidebarPanel />);

    expect(screen.getByRole("tab", { name: "Transition" })).toBeInTheDocument();
    expect(screen.getByTestId("mock-transition-panel")).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Adjust" }),
    ).not.toBeInTheDocument();
  });

});
