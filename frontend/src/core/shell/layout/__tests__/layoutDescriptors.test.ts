import { describe, expect, it } from "vitest";
import { HostContextKeyService } from "../../contextKeys";
import { HostViewRegistry } from "../../viewRegistry";
import {
  arePanelDescriptorsEqual,
  describeShellPanels,
} from "../layoutDescriptors";
import { resolveShellLayout } from "../layoutResolver";
import { EMPTY_SHELL_LAYOUT_DOCUMENT } from "../layoutTypes";

function view(id: string, order: number) {
  return {
    id,
    title: id,
    defaultRegion: "left-sidebar" as const,
    order,
    component: () => null,
  };
}

describe("describeShellPanels", () => {
  it("describes host and contributed views in every dock region", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    registry.registerHostView(view("host.assets", 20));
    registry.registerEntry({
      ...view("example.a/tool", 15),
      source: "extension",
    });
    registry.registerHostView({
      ...view("host.scopes", 10),
      defaultRegion: "bottom-dock",
    });

    expect(describeShellPanels(registry)).toEqual([
      {
        id: "example.a/tool",
        defaultRegion: "left-sidebar",
        allowedRegions: ["left-sidebar"],
        defaultOrder: 15,
        available: true,
        defaultVisible: true,
        source: "extension",
      },
      {
        id: "host.assets",
        defaultRegion: "left-sidebar",
        allowedRegions: ["left-sidebar"],
        defaultOrder: 20,
        available: true,
        defaultVisible: true,
        source: "host",
      },
      {
        id: "host.scopes",
        defaultRegion: "bottom-dock",
        allowedRegions: ["bottom-dock"],
        defaultOrder: 10,
        available: true,
        defaultVisible: true,
        source: "host",
      },
    ]);
  });

  it("carries a panel's declared portability through to the resolver", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    registry.registerHostView({
      ...view("host.scopes", 10),
      defaultRegion: "bottom-dock",
      allowedRegions: ["bottom-dock", "right-sidebar"],
    });

    expect(describeShellPanels(registry)[0].allowedRegions).toEqual([
      "right-sidebar",
      "bottom-dock",
    ]);
    expect(
      resolveShellLayout({
        panels: describeShellPanels(registry),
        document: {
          ...EMPTY_SHELL_LAYOUT_DOCUMENT,
          panels: { "host.scopes": { region: "right-sidebar" } },
        },
      }).panelRegions["host.scopes"],
    ).toBe("right-sidebar");
  });

  it("collapses a declarative condition into live availability", () => {
    const keys = new HostContextKeyService();
    const registry = new HostViewRegistry(keys, null);
    registry.registerHostView({
      ...view("host.text", 10),
      when: { key: "project.open" },
    });

    expect(describeShellPanels(registry)[0].available).toBe(false);
    keys.set("project.open", true);
    expect(describeShellPanels(registry)[0].available).toBe(true);
  });

  it("leaves ordering to the resolver instead of double-applying it", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    registry.registerHostView(view("host.assets", 10));
    registry.registerHostView(view("host.text", 20));
    // The legacy registry layout reverses the pair; the descriptors must still
    // report the registration order, or the kernel would apply it twice.
    registry.move("host.text", -1);

    expect(
      describeShellPanels(registry).map((descriptor) => [
        descriptor.id,
        descriptor.defaultOrder,
      ]),
    ).toEqual([
      ["host.assets", 10],
      ["host.text", 20],
    ]);
    expect(
      resolveShellLayout({
        panels: describeShellPanels(registry),
        document: EMPTY_SHELL_LAYOUT_DOCUMENT,
      }).regions["left-sidebar"].placedViewIds,
    ).toEqual(["host.assets", "host.text"]);
  });

  it("drops a disposed view from the panel table", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    const registration = registry.registerEntry({
      ...view("example.a/tool", 10),
      source: "extension",
    });

    expect(describeShellPanels(registry)).toHaveLength(1);
    registration.dispose();
    expect(describeShellPanels(registry)).toEqual([]);
  });
});

describe("arePanelDescriptorsEqual", () => {
  const base = {
    id: "host.a",
    defaultRegion: "left-sidebar",
    allowedRegions: ["left-sidebar"],
    defaultOrder: 10,
    available: true,
    source: "host",
  } as const;

  it("treats structurally identical tables as equal", () => {
    expect(
      arePanelDescriptorsEqual([base], [{ ...base, allowedRegions: ["left-sidebar"] }]),
    ).toBe(true);
  });

  it("detects every field the resolver depends on", () => {
    expect(arePanelDescriptorsEqual([base], [])).toBe(false);
    expect(
      arePanelDescriptorsEqual([base], [{ ...base, available: false }]),
    ).toBe(false);
    expect(
      arePanelDescriptorsEqual([base], [{ ...base, defaultOrder: 11 }]),
    ).toBe(false);
    expect(
      arePanelDescriptorsEqual([base], [{ ...base, source: "extension" }]),
    ).toBe(false);
    expect(
      arePanelDescriptorsEqual([base], [{ ...base, minimumSizePx: 10 }]),
    ).toBe(false);
    expect(
      arePanelDescriptorsEqual(
        [base],
        [{ ...base, allowedRegions: ["left-sidebar", "right-sidebar"] }],
      ),
    ).toBe(false);
  });
});
