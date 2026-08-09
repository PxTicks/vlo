/**
 * Portable dock panels end to end through the kernel: the live registry, the
 * descriptor adapter, and the store, without React
 * (plan §7 Phase C acceptance, §8.1, §8.3).
 */
import { describe, expect, it } from "vitest";
import { HostContextKeyService } from "../../contextKeys";
import { HostViewRegistry } from "../../viewRegistry";
import { describeShellPanels } from "../layoutDescriptors";
import { createMemoryShellLayoutPersistence } from "../layoutPersistence";
import { createShellLayoutStore } from "../useShellLayoutStore";
import type { ShellLayoutDocumentV2 } from "../layoutTypes";

function createShell(document?: ShellLayoutDocumentV2) {
  const contextKeys = new HostContextKeyService();
  const registry = new HostViewRegistry(contextKeys, null);
  const persistence = createMemoryShellLayoutPersistence(document);
  const store = createShellLayoutStore({ persistence });
  // Stands in for the application store's live subscription.
  const sync = (): void => {
    store.getState().setPanelDescriptors(describeShellPanels(registry));
  };
  contextKeys.subscribe(sync);
  registry.subscribe(sync);
  sync();
  return { contextKeys, registry, store, persistence, sync };
}

function registerScopes(registry: HostViewRegistry) {
  return registry.registerHostView({
    id: "host.scopes",
    title: "Scopes",
    defaultRegion: "bottom-dock",
    allowedRegions: ["bottom-dock", "right-sidebar"],
    order: 10,
    component: () => null,
  });
}

function registerSidebarPanel(registry: HostViewRegistry) {
  return registry.registerHostView({
    id: "host.generate",
    title: "Generate",
    defaultRegion: "right-sidebar",
    order: 10,
    component: () => null,
  });
}

describe("portable dock panels", () => {
  it("moves a panel between its allowed regions and back", () => {
    const { registry, store } = createShell();
    registerScopes(registry);
    registerSidebarPanel(registry);

    expect(store.getState().movePanel("host.scopes", "right-sidebar")).toBe(
      true,
    );
    expect(
      store.getState().resolved.regions["right-sidebar"].orderedViewIds,
    ).toEqual(["host.generate", "host.scopes"]);
    expect(
      store.getState().resolved.regions["bottom-dock"].orderedViewIds,
    ).toEqual([]);

    expect(store.getState().movePanel("host.scopes", "bottom-dock")).toBe(true);
    expect(
      store.getState().resolved.regions["bottom-dock"].selectedViewId,
    ).toBe("host.scopes");
  });

  it("refuses a region the panel never declared", () => {
    const { registry, store } = createShell();
    registerScopes(registry);

    expect(store.getState().movePanel("host.scopes", "player-aside")).toBe(
      false,
    );
    expect(store.getState().resolved.panelRegions["host.scopes"]).toBe(
      "bottom-dock",
    );
  });

  it("persists placement and restores it on the next read", () => {
    const first = createShell();
    registerScopes(first.registry);
    first.store.getState().movePanel("host.scopes", "right-sidebar");

    // A reload: same storage, a fresh store, and the views registering again.
    const second = createShell(first.persistence.current);
    registerScopes(second.registry);

    expect(second.store.getState().resolved.panelRegions["host.scopes"]).toBe(
      "right-sidebar",
    );
    expect(
      second.store.getState().resolved.regions["right-sidebar"].selectedViewId,
    ).toBe("host.scopes");
  });

  it("keeps a contributed panel's placement across a disable and enable cycle", () => {
    const { registry, store, persistence } = createShell();
    registerScopes(registry);
    const contributed = () =>
      registry.registerEntry({
        id: "example.a/report",
        title: "Report",
        defaultRegion: "bottom-dock",
        order: 20,
        source: "extension",
        component: () => null,
      });
    let registration = contributed();
    store.getState().setPanelVisible("example.a/report", false);
    store.getState().selectView("bottom-dock", "host.scopes");

    // Disabling the extension takes its view away without touching intent.
    registration.dispose();
    expect(
      store.getState().resolved.regions["bottom-dock"].placedViewIds,
    ).toEqual(["host.scopes"]);
    expect(persistence.current.panels["example.a/report"]).toEqual({
      visible: false,
    });

    registration = contributed();
    expect(
      store.getState().resolved.regions["bottom-dock"].placedViewIds,
    ).toEqual(["host.scopes", "example.a/report"]);
    expect(
      store.getState().resolved.regions["bottom-dock"].orderedViewIds,
    ).toEqual(["host.scopes"]);
    registration.dispose();
  });

  it("falls back deterministically when the selected panel leaves the region", () => {
    const { registry, store } = createShell();
    registerScopes(registry);
    registerSidebarPanel(registry);
    store.getState().movePanel("host.scopes", "right-sidebar");
    expect(
      store.getState().resolved.regions["right-sidebar"].selectedViewId,
    ).toBe("host.scopes");

    store.getState().movePanel("host.scopes", "bottom-dock");

    // The sidebar always shows something, so it takes the nearest sibling…
    expect(
      store.getState().resolved.regions["right-sidebar"].selectedViewId,
    ).toBe("host.generate");
    // …while the dock, which is user-toggled, opens on the arriving panel.
    expect(
      store.getState().resolved.regions["bottom-dock"].selectedViewId,
    ).toBe("host.scopes");
  });

  it("returns a panel home when its registration stops allowing the move", () => {
    const { persistence } = (() => {
      const shell = createShell();
      registerScopes(shell.registry);
      shell.store.getState().movePanel("host.scopes", "right-sidebar");
      return shell;
    })();

    // The next release drops the second region; the stored placement is stale
    // rather than corrupt, so it degrades to the registered default.
    const next = createShell(persistence.current);
    next.registry.registerHostView({
      id: "host.scopes",
      title: "Scopes",
      defaultRegion: "bottom-dock",
      order: 10,
      component: () => null,
    });

    expect(next.store.getState().resolved.panelRegions["host.scopes"]).toBe(
      "bottom-dock",
    );
  });

  it("still answers placement before anything renders", () => {
    const { registry, store } = createShell();
    registerScopes(registry);

    // The registry's own selection API is the shape feature code already uses;
    // for a dock region it has to reach the same state the shell renders.
    registry.attachDockSelectionAuthority({
      select: (region, viewId) => store.getState().selectView(region, viewId),
      getSelected: (region) =>
        store.getState().resolved.regions[region].selectedViewId,
      clearSelection: (region) => store.getState().closeRegion(region),
    });

    expect(registry.getSelected("bottom-dock")).toBeNull();
    expect(registry.select("bottom-dock", "host.scopes")).toBe(true);
    expect(registry.getSelected("bottom-dock")).toBe("host.scopes");

    store.getState().movePanel("host.scopes", "right-sidebar");
    expect(registry.getSelected("bottom-dock")).toBeNull();
    expect(registry.getSelected("right-sidebar")).toBe("host.scopes");
  });
});
