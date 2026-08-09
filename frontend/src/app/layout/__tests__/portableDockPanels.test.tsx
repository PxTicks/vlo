/**
 * The first-party portable panel, exercised the way a user moves it
 * (plan §7 Phase C acceptance, §8.2, §8.4 scenarios 3 and 4).
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostContextKeys } from "../../../core/shell/contextKeys";
import { useShellLayoutStore } from "../../../core/shell/layout/useShellLayoutStore";
import { ShellPortableViewHost } from "../../../core/shell/ShellPortableViewHost";
import { hostViewRegistry } from "../../../core/shell/viewRegistry";
import {
  useSelectedTimelineClipIds,
  useSelectedTimelineTransitionId,
  useTimelineClip,
} from "../../../features/timeline/api";
import { EditorBottomDock } from "../EditorBottomDock";
import { RightSidebarPanel } from "../RightSidebarPanel";

let scopesMountCount = 0;

vi.mock("../../../features/scopes", () => ({
  registerHostScopes: () => {},
  // Stands in for the real view's sampling loop and canvas: one mount, and
  // local state that a needless remount would throw away.
  ScopesView: function MockScopesView({ active }: { readonly active: boolean }) {
    const [note, setNote] = useState("");
    useEffect(() => {
      scopesMountCount += 1;
    }, []);
    return (
      <div data-testid="scopes-view" data-active={active}>
        <input
          aria-label="Scope note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
    );
  },
}));

vi.mock("../../../features/timeline/api", () => ({
  useSelectedTimelineClipIds: vi.fn(() => []),
  useSelectedTimelineTransitionId: vi.fn(() => null),
  useTimelineClip: vi.fn(() => undefined),
}));

vi.mock("../../../features/transformations", () => ({
  TransformationPanel: () => <div data-testid="mock-transform-panel" />,
  EffectsPanel: () => <div data-testid="mock-effects-panel" />,
}));

vi.mock("../../../features/transitions", () => ({
  TransitionPanel: () => <div data-testid="mock-transition-panel" />,
}));

vi.mock("../../../features/masks", () => ({
  MaskPanel: () => <div data-testid="mock-mask-panel" />,
  useMaskViewStore: Object.assign(vi.fn(), {
    getState: () => ({ setMaskTabActive: vi.fn() }),
  }),
}));

vi.mock("../../../features/generation", () => ({
  GenerationPanel: () => <div data-testid="mock-generation-panel" />,
}));

const SCOPES_VIEW_ID = "host.scopes";

function renderShell() {
  return render(
    <>
      {/* Exactly the arrangement EditorLayout uses: the host above the
          regions, so a move reparents the panel instead of rebuilding it. */}
      <ShellPortableViewHost />
      <div data-testid="dock-host">
        <EditorBottomDock />
      </div>
      <div data-testid="sidebar-host">
        <RightSidebarPanel />
      </div>
    </>,
  );
}

function openScopesInDock() {
  act(() => {
    hostViewRegistry.select("bottom-dock", SCOPES_VIEW_ID);
  });
}

function movePanelThroughMenu(regionTestId: string, viewTitle: string, target: string) {
  fireEvent.click(screen.getByTestId(`view-layout-button-${regionTestId}`));
  fireEvent.click(
    screen.getByRole("button", { name: `Move ${viewTitle} to another region` }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: target }));
}

describe("portable dock panels", () => {
  beforeEach(() => {
    scopesMountCount = 0;
    act(() => {
      useShellLayoutStore.getState().resetLayout();
    });
    hostContextKeys.set("selection.clipCount", 0);
    hostContextKeys.set("selection.transitionSelected", false);
    hostContextKeys.set("selection.clipType", null);
    vi.mocked(useSelectedTimelineClipIds).mockReturnValue([]);
    vi.mocked(useSelectedTimelineTransitionId).mockReturnValue(null);
    vi.mocked(useTimelineClip).mockReturnValue(undefined);
  });

  it("moves scopes to the right sidebar without disturbing the panel", () => {
    openScopesInDock();
    renderShell();

    const dock = screen.getByTestId("dock-host");
    expect(within(dock).getByTestId("scopes-view")).toBeInTheDocument();
    // Local state the user would be annoyed to lose, plus the DOM identity
    // that proves the subtree was reparented rather than rebuilt.
    fireEvent.change(screen.getByRole("textbox", { name: "Scope note" }), {
      target: { value: "waveform" },
    });
    const panelBeforeMove = screen.getByTestId("scopes-view");

    movePanelThroughMenu("bottom-dock", "Scopes", "Right sidebar");

    const sidebar = screen.getByTestId("sidebar-host");
    expect(within(sidebar).getByTestId("scopes-view")).toBe(panelBeforeMove);
    expect(screen.getByRole("textbox", { name: "Scope note" })).toHaveValue(
      "waveform",
    );
    expect(scopesMountCount).toBe(1);
    // The dock existed only to show scopes, so it closes behind them.
    expect(screen.queryByTestId("editor-bottom-dock")).not.toBeInTheDocument();
    expect(
      within(sidebar).getByRole("tab", { name: "Scopes" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("records the placement so a reload resolves it the same way", () => {
    openScopesInDock();
    renderShell();

    movePanelThroughMenu("bottom-dock", "Scopes", "Right sidebar");

    expect(useShellLayoutStore.getState().document.panels[SCOPES_VIEW_ID]).toEqual(
      { region: "right-sidebar" },
    );
    expect(
      useShellLayoutStore.getState().resolved.panelRegions[SCOPES_VIEW_ID],
    ).toBe("right-sidebar");
  });

  it("keeps a moved-in panel selected when the clip selection changes", () => {
    openScopesInDock();
    const { rerender } = renderShell();
    movePanelThroughMenu("bottom-dock", "Scopes", "Right sidebar");

    // Selecting a clip normally snaps the sidebar to its Adjust tab. A panel
    // the user parked here is not part of that rotation.
    vi.mocked(useSelectedTimelineClipIds).mockReturnValue(["clip-1"]);
    act(() => {
      hostContextKeys.set("selection.clipCount", 1);
    });
    rerender(
      <>
        <ShellPortableViewHost />
        <div data-testid="dock-host">
          <EditorBottomDock />
        </div>
        <div data-testid="sidebar-host">
          <RightSidebarPanel />
        </div>
      </>,
    );

    expect(
      useShellLayoutStore.getState().resolved.regions["right-sidebar"]
        .selectedViewId,
    ).toBe(SCOPES_VIEW_ID);
    expect(scopesMountCount).toBe(1);
  });

  it("offers only the regions a panel is allowed in, and moves it back", () => {
    openScopesInDock();
    renderShell();
    movePanelThroughMenu("bottom-dock", "Scopes", "Right sidebar");

    fireEvent.click(screen.getByTestId("view-layout-button-right-sidebar"));
    // Fixed panels have no move control at all…
    expect(
      screen.queryByRole("button", {
        name: "Move Generate to another region",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Move Scopes to another region" }),
    );
    // …and a portable one is never offered a region it cannot honour.
    const options = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(options).toEqual(["Bottom dock"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Bottom dock" }));
    expect(
      within(screen.getByTestId("dock-host")).getByTestId("scopes-view"),
    ).toBeInTheDocument();
    expect(scopesMountCount).toBe(1);
  });

  it("hands focus to the panel where it landed", async () => {
    openScopesInDock();
    renderShell();

    // Moving the dock's only panel closes the dock, taking the control that
    // opened the menu with it, so focus has to follow the panel instead.
    movePanelThroughMenu("bottom-dock", "Scopes", "Right sidebar");
    // The hand-off waits for the region that receives the panel to render it.
    await act(async () => {});

    expect(document.activeElement).toBe(
      within(screen.getByTestId("sidebar-host")).getByRole("tab", {
        name: "Scopes",
      }),
    );
  });
});
