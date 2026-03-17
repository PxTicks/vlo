import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EditorLayout } from "../EditorLayout";

const mockFetchAssets = vi.fn(() => Promise.resolve());
const mockScanForNewAssets = vi.fn();
const mockSidebarClick = vi.fn();

let selectionMode = false;
let frameSelectionMode = false;

vi.mock("../../../features/project", () => ({
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

vi.mock("../../../features/userAssets", () => ({
  AssetBrowser: () => <div data-testid="asset-browser">Assets</div>,
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

vi.mock("../../../features/timeline", () => ({
  Timeline: () => <div data-testid="timeline-container">Timeline</div>,
  useAssetDrag: () => ({
    handleAssetDragStart: vi.fn(),
    handleAssetDragMove: vi.fn(),
    handleAssetDragEnd: vi.fn(),
    insertGapIndex: null,
    scrollContainerRef: { current: null },
  }),
  AssetDragOverlay: () => <div data-testid="asset-drag-overlay" />,
}));

vi.mock("../../../features/player/Player", () => ({
  Player: () => <div data-testid="player">Player</div>,
}));

vi.mock("../RightSidebarPanel", () => ({
  RightSidebarPanel: () => (
    <button type="button" onClick={mockSidebarClick}>
      Sidebar action
    </button>
  ),
}));

vi.mock("../ProjectSettingsMenu", () => ({
  ProjectSettingsMenu: () => <div data-testid="project-settings">Settings</div>,
}));

vi.mock("../../../features/player/useExtractStore", () => ({
  useExtractStore: (selector: (state: unknown) => unknown) =>
    selector({
      frameSelectionMode,
    }),
}));

vi.mock("../../../features/timelineSelection", () => ({
  useTimelineSelectionStore: (selector: (state: unknown) => unknown) =>
    selector({
      selectionMode,
    }),
}));

describe("EditorLayout", () => {
  beforeEach(() => {
    selectionMode = false;
    frameSelectionMode = false;
    mockFetchAssets.mockClear();
    mockScanForNewAssets.mockClear();
    mockSidebarClick.mockClear();
  });

  it("renders editor regions without lock overlays when timeline selection is inactive", () => {
    render(<EditorLayout />);

    expect(screen.queryByTestId("editor-lock-left")).not.toBeInTheDocument();
    expect(screen.queryByTestId("editor-lock-top")).not.toBeInTheDocument();
    expect(screen.queryByTestId("editor-lock-player")).not.toBeInTheDocument();
    expect(screen.queryByTestId("editor-lock-right")).not.toBeInTheDocument();
  });

  it("locks non-timeline regions when range selection mode is active", () => {
    selectionMode = true;

    render(<EditorLayout />);

    expect(screen.getByTestId("editor-lock-left")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-top")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-player")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-right")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-container")).toBeInTheDocument();
  });

  it("locks non-timeline regions when frame selection mode is active", () => {
    frameSelectionMode = true;

    render(<EditorLayout />);

    expect(screen.getByTestId("editor-lock-left")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-top")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-player")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-right")).toBeInTheDocument();
  });

  it("absorbs pointer interaction on the lock overlay", () => {
    selectionMode = true;

    render(<EditorLayout />);

    fireEvent.click(screen.getByTestId("editor-lock-right"));

    expect(mockSidebarClick).not.toHaveBeenCalled();
  });
});
