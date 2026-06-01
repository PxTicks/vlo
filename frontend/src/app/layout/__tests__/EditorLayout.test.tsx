import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditorLayout } from "../EditorLayout";
import { useEditorFocusStore } from "../../focus/useEditorFocusStore";

function renderEditorLayout({
  locked = false,
  layoutMode = "compact" as const,
} = {}) {
  const handleRightSidebarClick = vi.fn();

  render(
    <EditorLayout
      layoutMode={layoutMode}
      nonTimelineRegionsLocked={locked}
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

  return { handleRightSidebarClick };
}

describe("EditorLayout", () => {
  beforeEach(() => {
    useEditorFocusStore.getState().setRegion(null);
  });

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

  it("claims keyboard ownership for the region the user interacts with", () => {
    renderEditorLayout();
    const region = () => useEditorFocusStore.getState().region;

    fireEvent.pointerDown(screen.getByTestId("timeline"));
    expect(region()).toBe("timeline");

    fireEvent.pointerDown(screen.getByTestId("player"));
    expect(region()).toBe("canvas");

    // Neutral chrome (the top bar) releases ownership via the container's
    // capture-phase reset, since no inner region re-claims it.
    fireEvent.pointerDown(screen.getByTestId("top-bar"));
    expect(region()).toBeNull();
  });
});
