import { act, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostViewRegistry } from "../../../core/shell/viewRegistry";
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
});
