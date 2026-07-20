import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { HostContextKeyService } from "../../../../core/shell/contextKeys";
import { HostViewRegistry } from "../../../../core/shell/viewRegistry";
import { ViewRegionMount } from "../../../../core/shell/ViewRegionMount";
import { createExtensionViewApi } from "../createExtensionViewApi";

function createScope(id: string): ExtensionApiScope {
  return {
    extension: { id, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: vi.fn(),
  };
}

describe("createExtensionViewApi", () => {
  it("registers, opens, isolates, and disposes an owner-qualified view", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    const api = createExtensionViewApi(createScope("example.views"), registry);
    const registration = api.registerView({
      id: "dashboard",
      apiVersion: 1,
      kind: "trusted-view",
      title: "Dashboard",
      defaultRegion: "projects-page.main",
      component: ({ viewId, region, active }) => (
        <div>{`${viewId}:${region}:${active}`}</div>
      ),
    });

    expect(registration.id).toBe("example.views/dashboard");
    expect(api.openView("dashboard")).toBe(true);
    const views = registry.list("projects-page.main");
    render(
      <ViewRegionMount
        region="projects-page.main"
        views={views}
        activeViewId="example.views/dashboard"
      />,
    );
    expect(
      screen.getByText(
        "example.views/dashboard:projects-page.main:true",
      ),
    ).toBeInTheDocument();

    registration.dispose();
    expect(registry.get("example.views/dashboard")).toBeUndefined();
  });

  it("does not let an extension reopen a user-hidden view", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    const api = createExtensionViewApi(createScope("example.views"), registry);
    api.registerView({
      id: "hidden",
      apiVersion: 1,
      kind: "trusted-view",
      title: "Hidden",
      defaultRegion: "left-sidebar",
      component: () => null,
    });
    registry.setUserVisible("example.views/hidden", false);

    expect(api.openView("hidden")).toBe(false);
  });
});
