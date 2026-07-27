import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ViewLayoutButton } from "../ViewLayoutButton";
import { hostViewRegistry } from "../viewRegistry";
import type { ShellDisposable } from "../hostMenuCatalog";

const REGION = "projects-page.main";

describe("ViewLayoutButton", () => {
  const registrations: ShellDisposable[] = [];

  function registerView(id: string) {
    registrations.push(
      hostViewRegistry.registerHostView({
        id,
        defaultRegion: REGION,
        title: id,
        component: () => <div>{id}</div>,
      }),
    );
  }

  afterEach(() => {
    while (registrations.length) registrations.pop()?.dispose();
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
});
