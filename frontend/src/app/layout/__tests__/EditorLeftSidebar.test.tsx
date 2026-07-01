import { act, render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { EditorLeftSidebar } from "../EditorLeftSidebar";
import type {
  ExtensionApiScope,
  ExtensionResource,
  ExtensionUiWorkspaceComponentProps,
} from "../../../features/extensions";
import { extensionUiSlotRegistry } from "../../../features/extensions/ui/publicApi";

vi.mock("../../../features/userAssets", () => ({
  AssetBrowser: () => <div data-testid="mock-asset-browser">Assets</div>,
}));

vi.mock("../../../features/text", () => ({
  TextPanel: () => <div data-testid="mock-text-panel">Text</div>,
}));

vi.mock("../../../features/composite", () => ({
  CompositePanel: () => <div data-testid="mock-composite-panel">Composite</div>,
}));

vi.mock("../../../features/transformations", () => ({
  TransformationLibraryPanel: () => (
    <div data-testid="mock-effects-panel">Effects</div>
  ),
}));

vi.mock("../../../features/transitions", () => ({
  TransitionLibraryPanel: () => (
    <div data-testid="mock-transitions-panel">Transitions</div>
  ),
}));

function makeScope(id: string): ExtensionApiScope {
  return {
    extension: { id, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: vi.fn(),
  };
}

describe("EditorLeftSidebar", () => {
  it("shows the core tabs and the assets panel by default", () => {
    render(<EditorLeftSidebar />);

    expect(screen.getByRole("tab", { name: "Assets" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Transitions" })).toBeInTheDocument();
    expect(screen.getByTestId("mock-asset-browser")).toBeInTheDocument();
  });

  it("switches between core tabs", () => {
    render(<EditorLeftSidebar />);

    fireEvent.click(screen.getByRole("tab", { name: "Composite" }));
    expect(screen.getByTestId("mock-composite-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-asset-browser")).not.toBeInTheDocument();
  });

  it("hosts a stateful left-sidebar extension workspace as a persistent tab", () => {
    const ui = extensionUiSlotRegistry.bind(makeScope("example.tool"));

    function StatefulWorkspace({ active }: ExtensionUiWorkspaceComponentProps) {
      const [value, setValue] = useState("");
      return (
        <label>
          Tool value
          <input
            aria-label="Tool value"
            data-active={String(active)}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
      );
    }
    const registration = ui.registerWorkspace({
      id: "panel",
      apiVersion: 1,
      kind: "trusted-workspace",
      title: "My Tool",
      location: "left-sidebar",
      component: StatefulWorkspace,
    });

    try {
      render(<EditorLeftSidebar />);

      const toolTab = screen.getByRole("tab", { name: "My Tool" });
      expect(toolTab).toBeInTheDocument();
      // Lazily mounted: not present until first selected.
      expect(screen.queryByLabelText("Tool value")).not.toBeInTheDocument();

      act(() => expect(ui.openWorkspace("panel")).toBe(true));
      expect(toolTab).toHaveAttribute("aria-selected", "true");
      // Extension workspace replaces the core panel.
      expect(screen.queryByTestId("mock-asset-browser")).not.toBeInTheDocument();

      const input = screen.getByLabelText("Tool value");
      expect(input).toHaveAttribute("data-active", "true");
      fireEvent.change(input, { target: { value: "in progress" } });

      // Returning to a core tab keeps the workspace mounted (state survives).
      fireEvent.click(screen.getByRole("tab", { name: "Assets" }));
      expect(screen.getByTestId("mock-asset-browser")).toBeInTheDocument();
      expect(input).toHaveValue("in progress");
      expect(input).toHaveAttribute("data-active", "false");

      fireEvent.click(screen.getByRole("tab", { name: "My Tool" }));
      expect(screen.getByLabelText("Tool value")).toHaveValue("in progress");

      // Disposal removes the tab and falls back to the core panel.
      act(() => registration.dispose());
      expect(
        screen.queryByRole("tab", { name: "My Tool" }),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("mock-asset-browser")).toBeInTheDocument();
    } finally {
      registration.dispose();
    }
  });
});
