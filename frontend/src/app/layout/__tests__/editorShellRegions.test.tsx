import { act, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostViewRegistry } from "../../../core/shell/viewRegistry";
import { useShellLayoutStore } from "../../../core/shell/layout/useShellLayoutStore";
import { EditorBottomDock } from "../EditorBottomDock";
import { PlayerAsidePanel } from "../PlayerAsidePanel";
import { EditorTopBar } from "../EditorTopBar";

const SCOPES_VIEW_ID = "host.scopes";

function registerAsideView() {
  return hostViewRegistry.registerEntry({
    id: "example.a/meters",
    title: "Meters",
    defaultRegion: "player-aside",
    order: 10,
    source: "extension",
    component: () => <div data-testid="aside-view">Meters</div>,
  });
}

describe("editor shell regions", () => {
  beforeEach(() => {
    hostViewRegistry.clearSelection("bottom-dock");
    hostViewRegistry.clearSelection("player-aside");
    useShellLayoutStore.getState().resetRegion("bottom-dock");
    useShellLayoutStore.getState().resetRegion("player-aside");
  });

  afterEach(() => {
    hostViewRegistry.clearSelection("bottom-dock");
    hostViewRegistry.clearSelection("player-aside");
  });

  it("declares the scopes view in the bottom dock", () => {
    // Importing the dock declares it, exactly as the editor does.
    expect(hostViewRegistry.get(SCOPES_VIEW_ID)).toMatchObject({
      defaultRegion: "bottom-dock",
      source: "host",
      component: expect.any(Function),
    });
  });

  it("renders no dock until a view is selected", () => {
    const { container } = render(<EditorBottomDock />);
    // The layout must be untouched for an editor nobody has opened it in.
    expect(container).toBeEmptyDOMElement();

    // Selection is external state, so the mounted dock reacts to it rather
    // than needing to be re-rendered.
    act(() => {
      hostViewRegistry.select("bottom-dock", SCOPES_VIEW_ID);
    });
    expect(screen.getByTestId("editor-bottom-dock")).toBeInTheDocument();
  });

  it("toggles the dock from the top bar and closes it again", () => {
    render(<EditorTopBar />);
    const toggle = screen.getByRole("button", { name: "Toggle video scopes" });

    fireEvent.click(toggle);
    expect(hostViewRegistry.getSelected("bottom-dock")).toBe(SCOPES_VIEW_ID);

    fireEvent.click(toggle);
    expect(hostViewRegistry.getSelected("bottom-dock")).toBeNull();
  });

  it("closes the dock from its own close control", () => {
    hostViewRegistry.select("bottom-dock", SCOPES_VIEW_ID);
    render(<EditorBottomDock />);

    fireEvent.click(screen.getByRole("button", { name: "Close dock" }));
    expect(hostViewRegistry.getSelected("bottom-dock")).toBeNull();
  });

  it("resizes and restores a collapsed bottom dock", () => {
    hostViewRegistry.select("bottom-dock", SCOPES_VIEW_ID);
    render(<EditorBottomDock />);

    expect(
      screen.getByRole("separator", { name: "Resize bottom dock" }),
    ).toHaveAttribute("aria-valuenow", "240");
    expect(globalThis.getComputedStyle(screen.getByTestId("editor-bottom-dock")).maxHeight)
      .toBe("60%");
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse bottom dock" }),
    );
    expect(
      useShellLayoutStore.getState().resolved.regions["bottom-dock"].collapsed,
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Expand bottom dock" }),
    );
    expect(
      useShellLayoutStore.getState().resolved.regions["bottom-dock"].collapsed,
    ).toBe(false);
  });

  it("expands the dock when a view is opened through the registry", () => {
    useShellLayoutStore
      .getState()
      .setRegionCollapsed("bottom-dock", true);
    render(<EditorBottomDock />);

    act(() => {
      hostViewRegistry.select("bottom-dock", SCOPES_VIEW_ID);
    });

    expect(
      useShellLayoutStore.getState().resolved.regions["bottom-dock"].collapsed,
    ).toBe(false);
    expect(screen.getByTestId("editor-bottom-dock")).toBeInTheDocument();
  });

  it("gives the player aside no space until something registers there", () => {
    const { container, unmount } = render(<PlayerAsidePanel />);
    expect(container).toBeEmptyDOMElement();
    unmount();

    let registration: { dispose(): void } | undefined;
    act(() => {
      registration = registerAsideView();
    });
    try {
      render(<PlayerAsidePanel />);
      expect(screen.getByTestId("player-aside")).toBeInTheDocument();
      // Unlike the dock, the aside auto-selects: a registered view is the
      // point of the region, and there is no toggle for it.
      expect(screen.getByTestId("aside-view")).toBeInTheDocument();
    } finally {
      registration?.dispose();
    }
  });

  it("keeps a collapsed player aside mounted and recoverable", () => {
    const registration = registerAsideView();
    try {
      render(<PlayerAsidePanel />);
      fireEvent.click(
        screen.getByRole("button", { name: "Collapse player aside" }),
      );

      expect(screen.getByTestId("aside-view")).toBeInTheDocument();
      expect(
        useShellLayoutStore.getState().resolved.regions["player-aside"].collapsed,
      ).toBe(true);
      fireEvent.click(
        screen.getByRole("button", { name: "Expand player aside" }),
      );
      expect(
        useShellLayoutStore.getState().resolved.regions["player-aside"].collapsed,
      ).toBe(false);
    } finally {
      registration.dispose();
    }
  });
});
