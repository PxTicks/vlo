import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { App } from "../App";

// Mock matchMedia
beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    function () {
      return {
        matches: false,
        addListener: function () {},
        removeListener: function () {},
      };
    };

  // Mock ResizeObserver
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// Mock heavy dependencies to avoid timeouts/side-effects
vi.mock("../../features/player/Player", () => ({
  Player: () => <div data-testid="mock-player">Player</div>,
}));

vi.mock("../../features/timeline", () => ({
  Timeline: () => <div data-testid="mock-timeline">Timeline</div>,
}));

vi.mock(
  "../../features/transformations",
  () => ({
    TransformationPanel: () => <div>Transformations</div>,
  }),
);

vi.mock("../../features/generation", () => ({
  GenerationPanel: () => (
    <div data-testid="mock-generation">Generation Panel</div>
  ),
}));

vi.mock("../../app/layout/RightSidebarPanel", () => ({
  RightSidebarPanel: () => (
    <div data-testid="mock-right-sidebar">Right Sidebar</div>
  ),
}));

vi.mock("../layout/EditorLayout", () => ({
  EditorLayout: () => (
    <div>
      <div>Test Project</div>
      <div data-testid="mock-player">Player</div>
      <div data-testid="mock-timeline">Timeline</div>
    </div>
  ),
}));

// Mock only the asset store to avoid filesystem operations
vi.mock("../../features/userAssets", () => {
  const mockState = {
    fetchAssets: vi.fn().mockResolvedValue([]),
    scanForNewAssets: vi.fn().mockResolvedValue([]),
  };
  const useAssetStore = Object.assign(
    (selector?: (state: typeof mockState) => unknown) =>
      selector ? selector(mockState) : mockState,
    { getState: () => mockState },
  );

  return {
    AssetBrowser: () => <div data-testid="asset-browser">Asset Browser</div>,
    useAssetStore,
  };
});

describe("App Startup", () => {
  it("renders the Project Manager screen on startup (when no project loaded)", async () => {
    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /^vlo$/i }),
      ).toBeInTheDocument();
    });
  });

  it("renders the editor loading state when a project is loaded", async () => {
    // Seed the store with a dummy project
    const { useProjectStore } = await import("../../features/project");

    // We need to act to update the store outside of React render cycle
    const { act } = await import("@testing-library/react");

    act(() => {
      useProjectStore.setState({
        project: {
          id: "test-project",
          title: "Test Project",
          rootAssetsFolder: "test-folder",
          createdAt: Date.now(),
          lastModified: Date.now(),
        },
        rootHandle: {
          kind: "directory",
          name: "test-handle",
        } as unknown as FileSystemDirectoryHandle,
      });
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Loading Editor...")).toBeInTheDocument();
    });
  }, 15000);
});
