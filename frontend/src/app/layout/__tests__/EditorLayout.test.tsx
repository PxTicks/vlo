import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { EditorLayout } from "../EditorLayout";

function renderEditorLayout({
  locked = false,
  layoutMode = "compact" as const,
} = {}) {
  const handleEditorMouseDownCapture = vi.fn();
  const handleTimelineMouseDownCapture = vi.fn();
  const handleRightSidebarClick = vi.fn();

  render(
    <EditorLayout
      layoutMode={layoutMode}
      nonTimelineRegionsLocked={locked}
      onEditorMouseDownCapture={handleEditorMouseDownCapture}
      onTimelineMouseDownCapture={handleTimelineMouseDownCapture}
      leftSidebar={<div data-testid="left-sidebar">Left</div>}
      topBar={<div data-testid="top-bar">Top</div>}
      player={<div data-testid="player">Player</div>}
      rightSidebar={
        <button type="button" onClick={handleRightSidebarClick}>
          Sidebar action
        </button>
      }
      timeline={<div data-testid="timeline">Timeline</div>}
    />,
  );

  return {
    handleEditorMouseDownCapture,
    handleTimelineMouseDownCapture,
    handleRightSidebarClick,
  };
}

describe("EditorLayout", () => {
  it("renders each editor region", () => {
    renderEditorLayout();

    expect(screen.getByTestId("left-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("top-bar")).toBeInTheDocument();
    expect(screen.getByTestId("player")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sidebar action" }))
      .toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toBeInTheDocument();
  });

  it("renders lock overlays for non-timeline regions only", () => {
    renderEditorLayout({ locked: true });

    expect(screen.getByTestId("editor-lock-left")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-top")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-player")).toBeInTheDocument();
    expect(screen.getByTestId("editor-lock-right")).toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toBeInTheDocument();
  });

  it("absorbs pointer interaction on lock overlays", () => {
    const { handleRightSidebarClick } = renderEditorLayout({ locked: true });

    fireEvent.click(screen.getByTestId("editor-lock-right"));

    expect(handleRightSidebarClick).not.toHaveBeenCalled();
  });

  it("delegates editor and timeline mouse capture", () => {
    const { handleEditorMouseDownCapture, handleTimelineMouseDownCapture } =
      renderEditorLayout();

    fireEvent.mouseDown(screen.getByTestId("left-sidebar"));
    fireEvent.mouseDown(screen.getByTestId("timeline"));

    expect(handleEditorMouseDownCapture).toHaveBeenCalledTimes(2);
    expect(handleTimelineMouseDownCapture).toHaveBeenCalledTimes(1);
  });
});
