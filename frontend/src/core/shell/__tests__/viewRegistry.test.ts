import { describe, expect, it, vi } from "vitest";
import { HostContextKeyService } from "../contextKeys";
import { HostViewRegistry } from "../viewRegistry";

function view(id: string, order: number) {
  return {
    id,
    title: id,
    defaultRegion: "left-sidebar" as const,
    order,
    component: () => null,
  };
}

describe("HostViewRegistry", () => {
  it("orders host and contributed views and filters declarative conditions", () => {
    const keys = new HostContextKeyService();
    const registry = new HostViewRegistry(keys, null);
    registry.registerHostView(view("host.assets", 20));
    registry.registerHostView({
      ...view("host.text", 10),
      when: { key: "project.open" },
    });
    registry.registerEntry({
      ...view("example.views/tool", 15),
      source: "extension",
    });

    expect(registry.list("left-sidebar").map((entry) => entry.id)).toEqual([
      "example.views/tool",
      "host.assets",
    ]);
    keys.set("project.open", true);
    expect(registry.list("left-sidebar").map((entry) => entry.id)).toEqual([
      "host.text",
      "example.views/tool",
      "host.assets",
    ]);
  });

  it("persists user-owned visibility and order and never lets selection bypass hiding", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const registry = new HostViewRegistry(new HostContextKeyService(), storage);
    registry.registerHostView(view("host.assets", 10));
    registry.registerHostView(view("host.text", 20));

    registry.move("host.text", -1);
    registry.setUserVisible("host.assets", false);
    expect(registry.list("left-sidebar").map((entry) => entry.id)).toEqual([
      "host.text",
    ]);
    expect(registry.select("left-sidebar", "host.assets")).toBe(false);

    const restored = new HostViewRegistry(new HostContextKeyService(), storage);
    restored.registerHostView(view("host.assets", 10));
    restored.registerHostView(view("host.text", 20));
    expect(
      restored
        .list("left-sidebar", { includeHidden: true })
        .map((entry) => entry.id),
    ).toEqual(["host.text", "host.assets"]);
    expect(restored.isUserVisible("host.assets")).toBe(false);
  });

  it("clears a selected view when its registration is disposed", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    const registration = registry.registerEntry({
      ...view("example.views/tool", 10),
      source: "extension",
    });
    expect(registry.select("left-sidebar", "example.views/tool")).toBe(true);

    registration.dispose();
    expect(registry.getSelected("left-sidebar")).toBeNull();
  });
});

describe("player-aside and bottom-dock regions", () => {
  it("accepts host and contributed views in the new regions", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    registry.registerHostView({
      ...view("host.scopes", 10),
      defaultRegion: "bottom-dock",
    });
    registry.registerEntry({
      ...view("example.a/report", 20),
      defaultRegion: "bottom-dock",
      source: "extension",
    });
    registry.registerEntry({
      ...view("example.a/meters", 10),
      defaultRegion: "player-aside",
      source: "extension",
    });

    expect(registry.list("bottom-dock").map((entry) => entry.id)).toEqual([
      "host.scopes",
      "example.a/report",
    ]);
    expect(registry.list("player-aside").map((entry) => entry.id)).toEqual([
      "example.a/meters",
    ]);
    // Regions stay disjoint: a dock view is not a sidebar view.
    expect(registry.list("left-sidebar")).toEqual([]);
  });

  it("rejects a region the host does not declare", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    expect(() =>
      registry.registerEntry({
        ...view("example.a/tool", 10),
        defaultRegion: "player-bottom" as never,
        source: "extension",
      }),
    ).toThrow(/unsupported region/);
  });

  it("opens and closes the dock through selection alone", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    registry.registerHostView({
      ...view("host.scopes", 10),
      defaultRegion: "bottom-dock",
    });

    // The dock's closed state *is* an empty selection, which is why the dock
    // reads its selection without the sidebars' fall-back-to-first behaviour.
    expect(registry.getSelected("bottom-dock")).toBeNull();
    expect(registry.select("bottom-dock", "host.scopes")).toBe(true);
    expect(registry.getSelected("bottom-dock")).toBe("host.scopes");
    registry.clearSelection("bottom-dock");
    expect(registry.getSelected("bottom-dock")).toBeNull();
  });
});
