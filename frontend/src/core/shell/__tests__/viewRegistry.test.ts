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

  it("normalizes the regions a portable panel declares", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    registry.registerHostView({
      ...view("host.scopes", 10),
      defaultRegion: "bottom-dock",
      // Declared out of order and with a duplicate, to prove the entry is the
      // canonical list a move menu and the resolver can both rely on.
      allowedRegions: ["right-sidebar", "bottom-dock", "right-sidebar"],
    });

    expect(registry.get("host.scopes")?.allowedRegions).toEqual([
      "right-sidebar",
      "bottom-dock",
    ]);
  });

  it("fixes a panel to its own region unless it opts out", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    registry.registerHostView(view("host.assets", 10));
    registry.registerHostView({
      ...view("host.recent", 10),
      defaultRegion: "projects-page.main",
    });

    expect(registry.get("host.assets")?.allowedRegions).toEqual([
      "left-sidebar",
    ]);
    // Outside the docking model there is nowhere to move to at all.
    expect(registry.get("host.recent")?.allowedRegions).toEqual([]);
  });

  it("rejects portability a panel could not honour", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);

    expect(() =>
      registry.registerHostView({
        ...view("host.a", 10),
        allowedRegions: ["right-sidebar"],
      }),
    ).toThrow(/must include its default region/);
    expect(() =>
      registry.registerHostView({
        ...view("host.b", 10),
        allowedRegions: ["projects-page.main" as never],
      }),
    ).toThrow(/cannot be moved to region/);
    expect(() =>
      registry.registerHostView({
        ...view("host.c", 10),
        defaultRegion: "projects-page.main",
        allowedRegions: ["left-sidebar"],
      }),
    ).toThrow(/outside the dock regions/);
    expect(() =>
      registry.registerHostView({ ...view("host.d", 10), allowedRegions: [] }),
    ).toThrow(/non-empty array/);
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
