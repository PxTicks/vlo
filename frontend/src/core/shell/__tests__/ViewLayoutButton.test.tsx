import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useShellLayoutStore } from "../layout/useShellLayoutStore";
import { ViewLayoutButton } from "../ViewLayoutButton";
import { hostViewRegistry, type HostViewRegion } from "../viewRegistry";
import type { ShellDisposable } from "../hostMenuCatalog";

const REGION = "projects-page.main";

describe("ViewLayoutButton", () => {
  const registrations: ShellDisposable[] = [];

  function registerView(id: string, region: HostViewRegion = REGION) {
    registrations.push(
      hostViewRegistry.registerHostView({
        id,
        defaultRegion: region,
        title: id,
        component: () => <div>{id}</div>,
      }),
    );
  }

  afterEach(() => {
    while (registrations.length) registrations.pop()?.dispose();
    useShellLayoutStore.getState().resetLayout();
  });

  // Hiding the only view would empty the region and take the control that
  // restores it down with the tab, so the button must not be reachable there.
  it("stays hidden while a region holds a single view", () => {
    registerView("host.only");

    render(<ViewLayoutButton region={REGION} />);

    expect(
      screen.queryByRole("button", { name: "Manage panels" }),
    ).not.toBeInTheDocument();
  });

  it("appears once a second view joins the region", () => {
    registerView("host.first");
    registerView("host.second");

    render(<ViewLayoutButton region={REGION} />);

    expect(
      screen.getByRole("button", { name: "Manage panels" }),
    ).toBeInTheDocument();
  });

  it("keeps geometry controls reachable for a single-view dock", () => {
    registerView("host.aside-only", "player-aside");
    render(<ViewLayoutButton region="player-aside" allowSingleView />);

    fireEvent.click(screen.getByRole("button", { name: "Manage panels" }));
    expect(
      screen.getByRole("checkbox", { name: "Show host.aside-only" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Collapse region" }));
    expect(
      useShellLayoutStore.getState().resolved.regions["player-aside"].collapsed,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Reset region" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reset all regions" }),
    ).toBeInTheDocument();
  });
});
