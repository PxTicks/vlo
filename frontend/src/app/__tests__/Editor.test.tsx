import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor } from "../Editor";

const mockFetchAssets = vi.fn(() => Promise.resolve());
const mockScanForNewAssets = vi.fn();
const mockSidebarClick = vi.fn();

let selectionMode = false;
let frameSelectionMode = false;
let playerShouldThrow = false;

function isBoundaryLogFor(call: unknown[], boundaryName: string): boolean {
  const [message, payload] = call;
  return (
    message === "[ErrorBoundary] Caught render error" &&
    typeof payload === "object" &&
    payload !== null &&
    "boundaryName" in payload &&
    payload.boundaryName === boundaryName
  );
}

vi.mock("../../features/project", () => ({
  ProjectTitle: () => <div data-testid="project-title">Project</div>,
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({
      project: {
        id: "project-1",
        rootAssetsFolder: "/tmp/assets",
      },
      config: {
        layoutMode: "compact",
        fps: 24,
      },
    }),
}));

vi.mock("../../features/userAssets", () => ({
  AssetBrowser: () => <div data-testid="asset-browser">Assets</div>,
  useTimelineAssetRevealClipOverlay: () => ({
    id: "asset-reveal-overlay",
    useItems: () => [],
  }),
  useAssetStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        fetchAssets: mockFetchAssets,
      }),
    {
      getState: () => ({
        scanForNewAssets: mockScanForNewAssets,
      }),
    },
  ),
}));

vi.mock("../../features/text", () => ({
  TextPanel: () => <div data-testid="text-panel">Text</div>,
}));

vi.mock("../../features/composite", () => ({
  CompositePanel: () => <div data-testid="composite-panel">Composite</div>,
  useTimelineCompositeRenderStatusOverlay: () => ({
    id: "composite-render-status-overlay",
    useItems: () => [],
  }),
}));

vi.mock("../../features/timeline", () => ({
  Timeline: () => <div data-testid="timeline-container">Timeline</div>,
  useAssetDrag: () => ({
    handleAssetDragStart: vi.fn(),
    handleAssetDragMove: vi.fn(),
    handleAssetDragEnd: vi.fn(),
    insertGapIndex: null,
    scrollContainerRef: { current: null },
  }),
  AssetDragOverlay: () => <div data-testid="asset-drag-overlay" />,
  useTimelineStore: Object.assign(() => undefined, {
    getState: () => ({
      setFocused: vi.fn(),
    }),
  }),
  useTimelineClipMuteOverlay: () => ({
    id: "mute-overlay",
    useItems: () => [],
  }),
  useTimelineMarkersClipOverlay: () => ({
    id: "markers-overlay",
    useItems: () => [],
  }),
  useTimelineReverseStatusOverlay: () => ({
    id: "reverse-status-overlay",
    useItems: () => [],
  }),
}));

vi.mock("../../features/transformations", () => ({
  useTimelineKeyframeClipOverlay: () => ({
    id: "keyframe-overlay",
    useItems: () => [],
  }),
}));

vi.mock("../../features/player/Player", () => ({
  Player: () => {
    if (playerShouldThrow) {
      throw new Error("Player render failed");
    }

    return <div data-testid="player">Player</div>;
  },
}));

vi.mock("../layout/RightSidebarPanel", () => ({
  RightSidebarPanel: () => (
    <button type="button" onClick={mockSidebarClick}>
      Sidebar action
    </button>
  ),
}));

vi.mock("../layout/ProjectSettingsMenu", () => ({
  ProjectSettingsMenu: () => <div data-testid="project-settings">Settings</div>,
}));

vi.mock("../../features/player/useExtractStore", () => ({
  useExtractStore: (selector: (state: unknown) => unknown) =>
    selector({
      frameSelectionMode,
    }),
}));

vi.mock("../../features/timelineSelection", () => ({
  useTimelineSelectionStore: (selector: (state: unknown) => unknown) =>
    selector({
      selectionMode,
    }),
}));

describe("Editor", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    selectionMode = false;
    frameSelectionMode = false;
    playerShouldThrow = false;
    mockFetchAssets.mockClear();
    mockScanForNewAssets.mockClear();
    mockSidebarClick.mockClear();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("renders editor regions without lock overlays when timeline selection is inactive", () => {
    render(<Editor />);

    expect(screen.getByTestId("left-sidebar-tab-assets")).toBeInTheDocument();
    expect(screen.getByTestId("asset-browser")).toBeInTheDocument();
    expect(screen.queryByTestId("editor-lock-left")).not.toBeInTheDocument();
    expect(screen.queryByTestId("editor-lock-top")).not.toBeInTheDocument();
    expect(screen.queryByTestId("editor-lock-player")).not.toBeInTheDocument();
    expect(screen.queryByTestId("editor-lock-right")).not.toBeInTheDocument();
  });

  it("locks non-timeline regions when range selection mode is active", () => {
    selectionMode = true;

    render(<Editor />);

    expect(screen.getByTestId("editor-lock-left")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-top")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-player")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-right")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-container")).toBeInTheDocument();
  });

  it("locks non-timeline regions when frame selection mode is active", () => {
    frameSelectionMode = true;

    render(<Editor />);

    expect(screen.getByTestId("editor-lock-left")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-top")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-player")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-right")).toBeInTheDocument();
  });

  it("absorbs pointer interaction on the lock overlay", () => {
    selectionMode = true;

    render(<Editor />);

    fireEvent.click(screen.getByTestId("editor-lock-right"));

    expect(mockSidebarClick).not.toHaveBeenCalled();
  });

  it("switches the left panel content when the text tab is selected", () => {
    render(<Editor />);

    fireEvent.click(screen.getByRole("tab", { name: "Text" }));

    expect(screen.getByTestId("text-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("asset-browser")).not.toBeInTheDocument();
  });

  it("switches the left panel content when the composite tab is selected", () => {
    render(<Editor />);

    fireEvent.click(screen.getByRole("tab", { name: "Composite" }));

    expect(screen.getByTestId("composite-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("asset-browser")).not.toBeInTheDocument();
  });

  it("contains player crashes to the player region", () => {
    playerShouldThrow = true;

    render(<Editor />);

    expect(screen.getByRole("alert")).toHaveTextContent("This area crashed");
    expect(screen.getByText("Player render failed")).toBeInTheDocument();
    expect(screen.getByTestId("asset-browser")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-container")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sidebar action" }))
      .toBeInTheDocument();
    expect(
      consoleErrorSpy.mock.calls.some((call: unknown[]) =>
        isBoundaryLogFor(call, "Player"),
      ),
    ).toBe(true);
  });
});
