import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { editorSurfaceRegistry } from "../../../core/shell/editorSurfaces";
import { useShellLayoutStore } from "../../../core/shell/layout/useShellLayoutStore";
import { useEditorFocusStore } from "../../../features/editorFocus";
import { EditorLayout } from "../EditorLayout";

// The stages mount registered surfaces rather than JSX handed to the layout,
// so the layout's own test supplies stand-ins for the editor's real ones.
const surfaceDisposers: Array<() => void> = [];

function registerStageSurfaces() {
  surfaceDisposers.push(
    editorSurfaceRegistry.register({
      id: "test.player",
      title: "Player",
      defaultStage: "main-stage",
      focusRegion: "canvas",
      component: () => <div data-testid="player">Player</div>,
    }).dispose,
    editorSurfaceRegistry.register({
      id: "test.timeline",
      title: "Timeline",
      defaultStage: "lower-stage",
      focusRegion: "timeline",
      component: () => <div data-testid="timeline">Timeline</div>,
    }).dispose,
  );
}

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
      rightSidebar={
        <button type="button" onClick={handleRightSidebarClick}>
          Sidebar action
        </button>
      }
    />,
  );

  return { handleRightSidebarClick };
}

describe("EditorLayout", () => {
  beforeEach(() => {
    useEditorFocusStore.getState().setRegion(null);
    useShellLayoutStore.getState().resetLayout();
    useShellLayoutStore.getState().clearStageSurfaces();
    useShellLayoutStore.getState().setViewport(null);
    registerStageSurfaces();
  });

  afterEach(() => {
    for (const dispose of surfaceDisposers.splice(0)) dispose();
  });

  it("renders each editor region", () => {
    renderEditorLayout();

    expect(screen.getByTestId("left-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("top-bar")).toBeInTheDocument();
    expect(screen.getByTestId("player")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sidebar action" }))
      .toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toBeInTheDocument();
    expect(
      globalThis.getComputedStyle(
        screen.getByTestId("shell-region-left-sidebar-content"),
      ),
    ).toMatchObject({
      minHeight: "0",
      height: "100%",
      overflow: "hidden",
    });
    expect(
      screen.queryByRole("button", { name: /collapse (left|right) sidebar/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Collapse timeline" }),
    ).not.toBeInTheDocument();
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

  it("does not let locked regions claim keyboard ownership", () => {
    renderEditorLayout({ locked: true });
    const region = () => useEditorFocusStore.getState().region;

    useEditorFocusStore.getState().setRegion("timeline");
    fireEvent.pointerDown(screen.getByTestId("editor-lock-right"));
    expect(region()).toBeNull();

    useEditorFocusStore.getState().setRegion("timeline");
    fireEvent.pointerDown(screen.getByTestId("editor-lock-player"));
    expect(region()).toBeNull();
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

  it("exposes constrained keyboard separators for shell geometry", () => {
    renderEditorLayout();

    const leftSeparator = screen.getByRole("separator", {
      name: "Resize left sidebar",
    });
    expect(leftSeparator).toHaveAttribute("aria-orientation", "vertical");
    expect(leftSeparator).toHaveAttribute("aria-valuemin", "220");
    expect(leftSeparator).toHaveAttribute("aria-valuemax", "640");
    expect(globalThis.getComputedStyle(leftSeparator)).toMatchObject({
      right: "0px",
      width: "7px",
    });
    const leftIndicatorStyle = globalThis.getComputedStyle(
      screen.getByTestId("region-separator-indicator-left-sidebar"),
    );
    expect(leftIndicatorStyle.right).toBe("0px");
    expect(leftIndicatorStyle.width).toBe("2px");
    leftSeparator.focus();
    expect(leftSeparator).toHaveFocus();

    const initialLeftSize =
      useShellLayoutStore.getState().resolved.regions["left-sidebar"].sizePx;
    fireEvent.keyDown(leftSeparator, { key: "ArrowRight" });
    expect(
      useShellLayoutStore.getState().document.regions["left-sidebar"]?.sizePx,
    ).toBe(initialLeftSize + 16);

    const rightSeparator = screen.getByRole("separator", {
      name: "Resize right sidebar",
    });
    expect(rightSeparator).toHaveAttribute("aria-valuemin", "300");
    expect(rightSeparator).toHaveAttribute("aria-valuemax", "640");
    expect(globalThis.getComputedStyle(rightSeparator)).toMatchObject({
      left: "0px",
    });
    const rightIndicatorStyle = globalThis.getComputedStyle(
      screen.getByTestId("region-separator-indicator-right-sidebar"),
    );
    expect(rightIndicatorStyle.left).toBe("0px");
    expect(rightIndicatorStyle.width).toBe("2px");

    const timelineSeparator = screen.getByRole("separator", {
      name: "Resize timeline",
    });
    expect(timelineSeparator).toHaveAttribute("aria-orientation", "horizontal");
    expect(globalThis.getComputedStyle(timelineSeparator)).toMatchObject({
      top: "0px",
      height: "7px",
    });
    const timelineIndicatorStyle = globalThis.getComputedStyle(
      screen.getByTestId("region-separator-indicator-lower-stage"),
    );
    expect(timelineIndicatorStyle.top).toBe("0px");
    expect(timelineIndicatorStyle.height).toBe("2px");
    fireEvent.keyDown(timelineSeparator, { key: "ArrowUp" });
    expect(useShellLayoutStore.getState().document.lowerStage?.sizePx).toBe(296);
  });

  it("keeps a collapsed edge inert on hover and restores it by dragging", () => {
    renderEditorLayout();
    const separator = screen.getByRole("separator", {
      name: "Resize left sidebar",
    });
    const retainedSize =
      useShellLayoutStore.getState().resolved.regions["left-sidebar"].sizePx;

    fireEvent.keyDown(separator, { key: "Enter" });

    expect(
      useShellLayoutStore.getState().resolved.regions["left-sidebar"].collapsed,
    ).toBe(true);
    expect(separator).toHaveAttribute(
      "aria-valuetext",
      `Collapsed, ${retainedSize} pixels retained`,
    );

    fireEvent.pointerEnter(separator);
    expect(
      useShellLayoutStore.getState().resolved.regions["left-sidebar"].collapsed,
    ).toBe(true);
    expect(separator).toHaveStyle({ cursor: "col-resize" });

    Object.defineProperties(separator, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: () => false },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    fireEvent.pointerDown(separator, {
      button: 0,
      clientX: 56,
      pointerId: 6,
    });
    fireEvent.pointerMove(globalThis.window, { clientX: 76 });
    fireEvent.pointerUp(globalThis.window);

    const restored =
      useShellLayoutStore.getState().resolved.regions["left-sidebar"];
    expect(restored.collapsed).toBe(false);
    expect(restored.sizePx).toBe(retainedSize + 20);
  });

  it("collapses after dragging past the minimum-size threshold", () => {
    renderEditorLayout();
    const separator = screen.getByRole("separator", {
      name: "Resize right sidebar",
    });
    Object.defineProperties(separator, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: () => false },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });

    fireEvent.pointerDown(separator, {
      button: 0,
      clientX: 700,
      pointerId: 8,
    });
    // The right edge moves 80px inward: 340px -> 260px, which is 40px
    // beyond this region's 300px minimum.
    fireEvent.pointerMove(globalThis.window, { clientX: 780 });
    fireEvent.pointerUp(globalThis.window);

    const collapsed =
      useShellLayoutStore.getState().resolved.regions["right-sidebar"];
    expect(collapsed.collapsed).toBe(true);
    expect(collapsed.userSizePx).toBe(collapsed.minimumSizePx);
    expect(screen.getByTestId("editor-layout")).toHaveStyle({
      gridTemplateColumns: "356px minmax(0, 1fr) 8px",
    });

    fireEvent.pointerEnter(separator);
    expect(
      useShellLayoutStore.getState().resolved.regions["right-sidebar"],
    ).toMatchObject({ collapsed: true, sizePx: 300 });

    fireEvent.pointerDown(separator, {
      button: 0,
      clientX: 780,
      pointerId: 9,
    });
    fireEvent.pointerMove(globalThis.window, { clientX: 760 });
    fireEvent.pointerUp(globalThis.window);
    expect(
      useShellLayoutStore.getState().resolved.regions["right-sidebar"],
    ).toMatchObject({ collapsed: false, sizePx: 320 });
  });

  it("keeps an empty bottom rail and restores the timeline by dragging", () => {
    renderEditorLayout();
    const separator = screen.getByRole("separator", {
      name: "Resize timeline",
    });

    fireEvent.keyDown(separator, { key: "Enter" });

    expect(useShellLayoutStore.getState().resolved.lowerStage.collapsed).toBe(
      true,
    );
    expect(separator).toHaveStyle({ cursor: "row-resize" });
    expect(screen.getByTestId("editor-layout")).toHaveStyle({
      gridTemplateRows: "48px minmax(0, 1fr) 8px",
    });
    expect(screen.getByTestId("timeline")).not.toBeVisible();

    fireEvent.pointerEnter(separator);
    expect(useShellLayoutStore.getState().resolved.lowerStage.collapsed).toBe(
      true,
    );

    Object.defineProperties(separator, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: () => false },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    fireEvent.pointerDown(separator, {
      button: 0,
      clientY: 700,
      pointerId: 10,
    });
    fireEvent.pointerMove(globalThis.window, { clientY: 680 });
    fireEvent.pointerUp(globalThis.window);

    expect(useShellLayoutStore.getState().resolved.lowerStage).toMatchObject({
      collapsed: false,
      sizePx: 300,
    });
    expect(screen.getByTestId("timeline")).toBeVisible();
  });

  it("double-click resets only the separator size", () => {
    useShellLayoutStore.getState().resizeRegion("left-sidebar", 420);
    useShellLayoutStore.getState().flushPersistence();
    useShellLayoutStore.getState().setRegionCollapsed("left-sidebar", true);
    renderEditorLayout();

    fireEvent.doubleClick(
      screen.getByRole("separator", { name: "Resize left sidebar" }),
    );

    expect(
      useShellLayoutStore.getState().document.regions["left-sidebar"],
    ).toEqual({ collapsed: true });
    expect(
      useShellLayoutStore.getState().resolved.regions["left-sidebar"].userSizePx,
    ).toBe(356);
  });

  it("captures pointer resizing and restores document selection", () => {
    renderEditorLayout();
    const separator = screen.getByRole("separator", {
      name: "Resize right sidebar",
    });
    const initial =
      useShellLayoutStore.getState().resolved.regions["right-sidebar"].sizePx;
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperties(separator, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: () => true },
      releasePointerCapture: {
        configurable: true,
        value: releasePointerCapture,
      },
    });

    fireEvent.pointerDown(separator, {
      button: 0,
      clientX: 700,
      pointerId: 7,
    });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(globalThis.document.documentElement.style.userSelect).toBe("none");
    fireEvent.pointerMove(globalThis.window, { clientX: 660 });
    fireEvent.pointerUp(globalThis.window);

    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(globalThis.document.documentElement.style.userSelect).toBe("");
    expect(
      useShellLayoutStore.getState().document.regions["right-sidebar"]?.sizePx,
    ).toBe(initial + 40);
  });

  it("uses dismissible responsive overlays without changing desktop intent", async () => {
    const originalWidth = globalThis.innerWidth;
    useShellLayoutStore.getState().resizeRegion("left-sidebar", 500);
    useShellLayoutStore.getState().flushPersistence();
    renderEditorLayout();

    Object.defineProperty(globalThis, "innerWidth", {
      configurable: true,
      value: 600,
    });
    fireEvent.resize(globalThis.window);

    await waitFor(() => {
      expect(
        useShellLayoutStore.getState().resolved.regions["left-sidebar"].sizePx,
      ).toBe(240);
    });
    expect(
      useShellLayoutStore.getState().resolved.regions["left-sidebar"],
    ).toMatchObject({ collapsed: true, userCollapsed: false });
    expect(
      useShellLayoutStore.getState().resolved.regions["right-sidebar"],
    ).toMatchObject({ collapsed: true, userCollapsed: false });
    expect(screen.queryByTestId("responsive-layout-scrim"))
      .not.toBeInTheDocument();
    expect(
      useShellLayoutStore.getState().resolved.regions["left-sidebar"].userSizePx,
    ).toBe(500);
    expect(
      useShellLayoutStore.getState().document.regions["left-sidebar"]?.sizePx,
    ).toBe(500);
    expect(
      useShellLayoutStore.getState().document.regions["left-sidebar"]?.collapsed,
    ).toBeUndefined();

    fireEvent.keyDown(
      screen.getByRole("separator", { name: "Resize left sidebar" }),
      { key: "Enter" },
    );
    expect(
      useShellLayoutStore.getState().resolved.regions["left-sidebar"].collapsed,
    ).toBe(false);
    expect(
      useShellLayoutStore.getState().resolved.regions["right-sidebar"].collapsed,
    ).toBe(true);
    expect(screen.getByTestId("responsive-layout-scrim")).toBeInTheDocument();
    expect(
      globalThis.getComputedStyle(
        globalThis.document.getElementById("shell-region-left-sidebar")!,
      ).gridArea,
    ).toBe("auto");

    fireEvent.click(screen.getByTestId("responsive-layout-scrim"));
    expect(
      useShellLayoutStore.getState().resolved.regions["left-sidebar"].collapsed,
    ).toBe(true);
    expect(
      useShellLayoutStore.getState().document.regions["left-sidebar"]?.collapsed,
    ).toBeUndefined();

    Object.defineProperty(globalThis, "innerWidth", {
      configurable: true,
      value: originalWidth,
    });
    fireEvent.resize(globalThis.window);
    await waitFor(() => {
      expect(
        useShellLayoutStore.getState().resolved.regions["left-sidebar"].collapsed,
      ).toBe(false);
    });
  });
});
