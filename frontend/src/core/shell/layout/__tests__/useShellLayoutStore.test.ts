import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShellLayoutStore } from "../useShellLayoutStore";
import { createMemoryShellLayoutPersistence } from "../layoutPersistence";
import { resolveShellLayout } from "../layoutResolver";
import {
  DOCK_REGION_CONSTRAINTS,
  type ShellLayoutDocumentV2,
  type ShellPanelDescriptor,
} from "../layoutTypes";

function panel(
  id: string,
  overrides: Partial<ShellPanelDescriptor> = {},
): ShellPanelDescriptor {
  const defaultRegion = overrides.defaultRegion ?? "left-sidebar";
  return {
    id,
    defaultRegion,
    allowedRegions: [defaultRegion],
    defaultOrder: 0,
    available: true,
    source: "host",
    ...overrides,
  };
}

const PANELS = [
  panel("host.a", { defaultOrder: 10 }),
  panel("host.b", { defaultOrder: 20 }),
  panel("example.a/tool", {
    defaultOrder: 30,
    source: "extension",
    allowedRegions: ["left-sidebar", "right-sidebar"],
  }),
  panel("host.scopes", { defaultRegion: "bottom-dock", defaultOrder: 10 }),
];

function createStore(document?: ShellLayoutDocumentV2) {
  const persistence = createMemoryShellLayoutPersistence(document);
  const store = createShellLayoutStore({
    persistence,
    panels: PANELS,
    resizePersistDelayMs: 250,
  });
  return { store, persistence };
}

describe("lower-stage actions", () => {
  it("resizes, collapses, and resets the lower stage atomically", () => {
    const { store, persistence } = createStore();

    store.getState().resizeRegion("lower-stage", 420);
    store.getState().setRegionCollapsed("lower-stage", true);
    expect(store.getState().resolved.lowerStage).toMatchObject({
      collapsed: true,
      sizePx: 420,
      userSizePx: 420,
    });
    expect(persistence.current.lowerStage).toEqual({
      sizePx: 420,
      collapsed: true,
    });

    store.getState().resetRegion("lower-stage");
    expect(store.getState().document.lowerStage).toBeUndefined();
    expect(store.getState().resolved.lowerStage).toMatchObject({
      collapsed: false,
      sizePx: 280,
    });
  });
});

describe("initial state", () => {
  it("resolves the persisted document against the registered panels", () => {
    const { store } = createStore({
      version: 2,
      panels: { "host.a": { visible: false } },
      regions: { "left-sidebar": { sizePx: 300 } },
      workspaceLayouts: {},
    });
    const { resolved } = store.getState();

    expect(resolved.regions["left-sidebar"].orderedViewIds).toEqual([
      "host.b",
      "example.a/tool",
    ]);
    expect(resolved.regions["left-sidebar"].selectedViewId).toBe("host.b");
    expect(resolved.regions["left-sidebar"].userSizePx).toBe(300);
  });

  it("re-resolves when the panel table changes and no-ops when it does not", () => {
    const { store } = createStore();
    const before = store.getState().resolved;

    store.getState().setPanelDescriptors(PANELS.map((entry) => ({ ...entry })));
    expect(store.getState().resolved).toBe(before);

    store
      .getState()
      .setPanelDescriptors(PANELS.filter((entry) => entry.id !== "host.a"));
    expect(
      store.getState().resolved.regions["left-sidebar"].selectedViewId,
    ).toBe("host.b");
  });

  it("re-resolves when the viewport changes", () => {
    const { store } = createStore();
    store.getState().setViewport({ widthPx: 700, heightPx: 500 });

    const region = store.getState().resolved.regions["left-sidebar"];
    expect(region.sizePx).toBe(280);
    expect(region.userSizePx).toBe(
      DOCK_REGION_CONSTRAINTS["left-sidebar"].defaultSizePx,
    );
  });
});

describe("placement actions", () => {
  it("refuses a region the panel does not allow", () => {
    const { store, persistence } = createStore();

    expect(store.getState().movePanel("host.a", "right-sidebar")).toBe(false);
    expect(store.getState().movePanel("missing.panel", "right-sidebar")).toBe(
      false,
    );
    expect(persistence.writeCount).toBe(0);
  });

  it("moves a portable panel, drops its stale ordering, and persists once", () => {
    const { store, persistence } = createStore();
    store.getState().reorderPanel("example.a/tool", -1);
    expect(store.getState().document.panels["example.a/tool"].order).toBe(1);

    expect(store.getState().movePanel("example.a/tool", "right-sidebar")).toBe(
      true,
    );

    expect(store.getState().document.panels["example.a/tool"]).toEqual({
      region: "right-sidebar",
    });
    expect(
      store.getState().resolved.regions["right-sidebar"].orderedViewIds,
    ).toEqual(["example.a/tool"]);
    expect(persistence.current.panels["example.a/tool"]).toEqual({
      region: "right-sidebar",
    });
  });

  it("reveals a moved panel and hands the source region back over", () => {
    const { store, persistence } = createStore();
    store.getState().selectView("left-sidebar", "example.a/tool");
    store.getState().setRegionCollapsed("right-sidebar", true);

    expect(store.getState().movePanel("example.a/tool", "right-sidebar")).toBe(
      true,
    );

    const { resolved, document } = store.getState();
    // A move the user cannot see is a move that looks broken.
    expect(resolved.regions["right-sidebar"].selectedViewId).toBe(
      "example.a/tool",
    );
    expect(resolved.regions["right-sidebar"].collapsed).toBe(false);
    // The source region falls back deterministically, and stops naming a panel
    // that is no longer there — otherwise moving the panel home would silently
    // resurrect the old selection.
    expect(resolved.regions["left-sidebar"].selectedViewId).toBe("host.a");
    expect(document.regions["left-sidebar"]?.selectedViewId).toBeNull();
    // Placement, both selections, and the expansion are one write.
    expect(persistence.writeCount).toBe(3);
  });

  it("closes a dock the moved panel was the only reason to open", () => {
    const { store } = createStore();
    const scopes = panel("host.scopes", {
      defaultRegion: "bottom-dock",
      defaultOrder: 10,
      allowedRegions: ["bottom-dock", "right-sidebar"],
    });
    store
      .getState()
      .setPanelDescriptors([...PANELS.slice(0, 3), scopes]);
    store.getState().selectView("bottom-dock", "host.scopes");

    store.getState().movePanel("host.scopes", "right-sidebar");

    const { resolved } = store.getState();
    expect(resolved.regions["bottom-dock"].selectedViewId).toBeNull();
    expect(resolved.regions["bottom-dock"].orderedViewIds).toEqual([]);
    expect(resolved.regions["right-sidebar"].selectedViewId).toBe(
      "host.scopes",
    );
  });

  it("reveals a hidden panel it moves", () => {
    const { store } = createStore();
    store.getState().setPanelVisible("example.a/tool", false);

    store.getState().movePanel("example.a/tool", "right-sidebar");

    // Choosing where to put a panel by name is a request to see it there.
    expect(store.getState().document.panels["example.a/tool"]).toEqual({
      region: "right-sidebar",
    });
    expect(
      store.getState().resolved.regions["right-sidebar"].orderedViewIds,
    ).toEqual(["example.a/tool"]);
    expect(
      store.getState().resolved.regions["right-sidebar"].selectedViewId,
    ).toBe("example.a/tool");
  });

  it("opens the destination overlay when a move lands in a narrow sidebar", () => {
    const { store } = createStore();
    store.getState().setViewport({ widthPx: 720, heightPx: 800 });

    store.getState().movePanel("example.a/tool", "right-sidebar");

    // Below the breakpoint the persisted collapse flag is not what hides a
    // sidebar, so clearing it alone would reveal nothing.
    expect(store.getState().responsiveExpandedRegion).toBe("right-sidebar");
    expect(
      store.getState().resolved.regions["right-sidebar"].collapsed,
    ).toBe(false);
    expect(store.getState().resolved.regions["left-sidebar"].collapsed).toBe(
      true,
    );
  });

  it("clears the stored placement when a panel returns to its registered region", () => {
    const { store } = createStore();
    store.getState().movePanel("example.a/tool", "right-sidebar");
    store.getState().movePanel("example.a/tool", "left-sidebar");

    expect(store.getState().document.panels["example.a/tool"]).toBeUndefined();
  });

  it("reorders within a region in one dense transaction", () => {
    const { store, persistence } = createStore();

    expect(store.getState().reorderPanel("example.a/tool", -1)).toBe(true);

    expect(store.getState().document.panels).toEqual({
      "host.a": { order: 0 },
      "example.a/tool": { order: 1 },
      "host.b": { order: 2 },
    });
    expect(
      store.getState().resolved.regions["left-sidebar"].placedViewIds,
    ).toEqual(["host.a", "example.a/tool", "host.b"]);
    expect(persistence.writeCount).toBe(1);
  });

  it("refuses to reorder past the ends or for an unplaced panel", () => {
    const { store } = createStore();

    expect(store.getState().reorderPanel("host.a", -1)).toBe(false);
    expect(store.getState().reorderPanel("example.a/tool", 1)).toBe(false);
    expect(store.getState().reorderPanel("missing.panel", 1)).toBe(false);
  });

  it("reorders around hidden siblings so the manage-panels list stays stable", () => {
    const { store } = createStore();
    store.getState().setPanelVisible("host.b", false);
    store.getState().reorderPanel("example.a/tool", -1);

    expect(
      store.getState().resolved.regions["left-sidebar"].placedViewIds,
    ).toEqual(["host.a", "example.a/tool", "host.b"]);
  });
});

describe("visibility and selection actions", () => {
  it("hides a panel and forgets the flag again when it is shown", () => {
    const { store } = createStore();

    store.getState().setPanelVisible("host.a", false);
    expect(
      store.getState().resolved.regions["left-sidebar"].orderedViewIds,
    ).toEqual(["host.b", "example.a/tool"]);

    store.getState().setPanelVisible("host.a", true);
    expect(store.getState().document.panels["host.a"]).toBeUndefined();
  });

  it("gives up the selection when the selected panel is hidden", () => {
    const { store } = createStore();
    store.getState().selectView("left-sidebar", "host.b");

    store.getState().setPanelVisible("host.b", false);
    expect(store.getState().document.regions["left-sidebar"]).toEqual({
      selectedViewId: null,
    });
    expect(
      store.getState().resolved.regions["left-sidebar"].selectedViewId,
    ).toBe("host.a");

    // Showing it again must not snap the region back: the fallback the user
    // has been looking at since is the current selection.
    store.getState().setPanelVisible("host.b", true);
    expect(
      store.getState().resolved.regions["left-sidebar"].selectedViewId,
    ).toBe("host.a");
  });

  it("refuses to select a panel that is not selectable in that region", () => {
    const { store } = createStore();
    store.getState().setPanelVisible("host.b", false);

    expect(store.getState().selectView("left-sidebar", "host.b")).toBe(false);
    expect(store.getState().selectView("left-sidebar", "host.scopes")).toBe(
      false,
    );
    expect(store.getState().selectView("left-sidebar", "example.a/tool")).toBe(
      true,
    );
    expect(
      store.getState().resolved.regions["left-sidebar"].selectedViewId,
    ).toBe("example.a/tool");
  });

  it("opens and closes the bottom dock through selection alone", () => {
    const { store } = createStore();
    expect(
      store.getState().resolved.regions["bottom-dock"].selectedViewId,
    ).toBeNull();

    expect(store.getState().selectView("bottom-dock", "host.scopes")).toBe(true);
    expect(store.getState().resolved.regions["bottom-dock"].selectedViewId).toBe(
      "host.scopes",
    );

    store.getState().closeRegion("bottom-dock");
    expect(
      store.getState().resolved.regions["bottom-dock"].selectedViewId,
    ).toBeNull();
  });

  it("lets an auto-selecting region fall straight back after it is closed", () => {
    const { store } = createStore();
    store.getState().selectView("left-sidebar", "host.b");
    store.getState().closeRegion("left-sidebar");

    expect(
      store.getState().resolved.regions["left-sidebar"].selectedViewId,
    ).toBe("host.a");
  });
});

describe("collapse and resize", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses and expands a region", () => {
    const { store } = createStore();

    store.getState().setRegionCollapsed("left-sidebar", true);
    expect(store.getState().resolved.regions["left-sidebar"].collapsed).toBe(
      true,
    );

    store.getState().setRegionCollapsed("left-sidebar", false);
    expect(store.getState().document.regions["left-sidebar"]).toBeUndefined();
  });

  it("keeps narrow sidebar expansion transient and mutually exclusive", () => {
    const { store, persistence } = createStore();
    store.getState().setViewport({ widthPx: 600, heightPx: 700 });

    expect(store.getState().resolved.regions["left-sidebar"]).toMatchObject({
      collapsed: true,
      userCollapsed: false,
    });
    expect(store.getState().resolved.regions["right-sidebar"]).toMatchObject({
      collapsed: true,
      userCollapsed: false,
    });

    store.getState().setRegionCollapsed("left-sidebar", false);
    expect(store.getState().responsiveExpandedRegion).toBe("left-sidebar");
    expect(store.getState().resolved.regions["left-sidebar"].collapsed).toBe(
      false,
    );
    expect(store.getState().resolved.regions["right-sidebar"].collapsed).toBe(
      true,
    );

    store.getState().setRegionCollapsed("right-sidebar", false);
    expect(store.getState().responsiveExpandedRegion).toBe("right-sidebar");
    expect(store.getState().resolved.regions["left-sidebar"].collapsed).toBe(
      true,
    );
    expect(store.getState().resolved.regions["right-sidebar"].collapsed).toBe(
      false,
    );
    expect(store.getState().document.regions).toEqual({});
    expect(persistence.writeCount).toBe(0);
  });

  it("restores desktop collapse intent after a responsive session", () => {
    const { store, persistence } = createStore();
    store.getState().setRegionCollapsed("left-sidebar", true);
    expect(persistence.writeCount).toBe(1);

    store.getState().setViewport({ widthPx: 600, heightPx: 700 });
    store.getState().setRegionCollapsed("left-sidebar", false);
    expect(store.getState().resolved.regions["left-sidebar"].collapsed).toBe(
      false,
    );
    expect(persistence.writeCount).toBe(1);

    store.getState().setViewport({ widthPx: 1200, heightPx: 700 });
    expect(store.getState().resolved.regions["left-sidebar"]).toMatchObject({
      collapsed: true,
      userCollapsed: true,
    });
    expect(store.getState().document.regions["left-sidebar"]?.collapsed).toBe(
      true,
    );
  });

  it("clamps a resize to the region bounds and reports it immediately", () => {
    const { store } = createStore();

    store.getState().resizeRegion("left-sidebar", 9000);
    expect(store.getState().resolved.regions["left-sidebar"].sizePx).toBe(
      DOCK_REGION_CONSTRAINTS["left-sidebar"].maximumSizePx,
    );

    store.getState().resizeRegion("left-sidebar", Number.NaN);
    store.getState().resizeRegion("left-sidebar", -5);
    expect(store.getState().resolved.regions["left-sidebar"].sizePx).toBe(
      DOCK_REGION_CONSTRAINTS["left-sidebar"].maximumSizePx,
    );
  });

  it("persists a drag once instead of once per intermediate size", () => {
    const { store, persistence } = createStore();

    for (const size of [300, 320, 340, 360]) {
      store.getState().resizeRegion("left-sidebar", size);
    }
    expect(persistence.writeCount).toBe(0);

    vi.advanceTimersByTime(250);
    expect(persistence.writeCount).toBe(1);
    expect(persistence.current.regions["left-sidebar"]?.sizePx).toBe(360);
  });

  it("flushes a pending resize on demand and when another action commits", () => {
    const flushed = createStore();
    flushed.store.getState().resizeRegion("left-sidebar", 300);
    flushed.store.getState().flushPersistence();
    expect(flushed.persistence.writeCount).toBe(1);
    vi.advanceTimersByTime(250);
    expect(flushed.persistence.writeCount).toBe(1);

    const folded = createStore();
    folded.store.getState().resizeRegion("left-sidebar", 300);
    folded.store.getState().setPanelVisible("host.a", false);
    expect(folded.persistence.writeCount).toBe(1);
    expect(folded.persistence.current.regions["left-sidebar"]?.sizePx).toBe(300);
    vi.advanceTimersByTime(250);
    expect(folded.persistence.writeCount).toBe(1);
  });
});

describe("reset actions", () => {
  it("resets size without touching panel or region intent", () => {
    const document: ShellLayoutDocumentV2 = {
      version: 2,
      panels: {
        "host.a": { visible: false, order: 2 },
        "example.a/tool": { region: "right-sidebar" },
      },
      regions: {
        "left-sidebar": {
          selectedViewId: "host.b",
          collapsed: true,
          sizePx: 300,
        },
      },
      workspaceLayouts: {},
    };
    const { store, persistence } = createStore(document);

    store.getState().resetRegionSize("left-sidebar");

    expect(store.getState().document.panels).toEqual(document.panels);
    expect(store.getState().document.regions["left-sidebar"]).toEqual({
      selectedViewId: "host.b",
      collapsed: true,
    });
    expect(persistence.current.panels).toEqual(document.panels);
  });

  it("resets one region without disturbing the others", () => {
    const { store } = createStore();
    store.getState().setPanelVisible("host.a", false);
    store.getState().reorderPanel("example.a/tool", -1);
    store.getState().resizeRegion("left-sidebar", 300);
    store.getState().selectView("bottom-dock", "host.scopes");

    store.getState().resetRegion("left-sidebar");

    expect(store.getState().document.panels).toEqual({});
    expect(store.getState().document.regions["left-sidebar"]).toBeUndefined();
    expect(store.getState().resolved.regions["bottom-dock"].selectedViewId).toBe(
      "host.scopes",
    );
    expect(
      store.getState().resolved.regions["left-sidebar"].placedViewIds,
    ).toEqual(["host.a", "host.b", "example.a/tool"]);
  });

  it("resets a region a panel was moved into, not just its registered one", () => {
    const { store } = createStore();
    store.getState().movePanel("example.a/tool", "right-sidebar");

    store.getState().resetRegion("right-sidebar");

    expect(store.getState().document.panels).toEqual({});
    expect(store.getState().resolved.panelRegions["example.a/tool"]).toBe(
      "left-sidebar",
    );
  });

  it("resets everything but keeps saved workspace overrides", () => {
    const { store } = createStore({
      version: 2,
      panels: { "host.a": { visible: false } },
      regions: { "left-sidebar": { sizePx: 300 } },
      workspaceLayouts: {
        "host.color": { panels: { "host.a": { order: 4 } }, regions: {} },
      },
    });

    store.getState().resetLayout();

    expect(store.getState().document).toEqual({
      version: 2,
      panels: {},
      regions: {},
      workspaceLayouts: {
        "host.color": { panels: { "host.a": { order: 4 } }, regions: {} },
      },
      // A reset must not let the version 1 preferences back in on reload.
      legacyPanelsMerged: true,
    });
  });
});

describe("transactions", () => {
  it("never publishes a document without its matching resolution", () => {
    const { store } = createStore();
    let notifications = 0;
    const unsubscribe = store.subscribe((state) => {
      notifications += 1;
      // Every published state must already agree with its own document: no
      // subscriber can observe a move applied to a stale resolution.
      expect(state.resolved).toEqual(
        resolveShellLayout({
          panels: state.panels,
          document: state.document,
          viewport: state.viewport,
          responsiveExpandedRegion: state.responsiveExpandedRegion,
        }),
      );
    });

    store.getState().setPanelVisible("host.a", false);
    store.getState().reorderPanel("example.a/tool", -1);
    store.getState().movePanel("example.a/tool", "right-sidebar");
    store.getState().setRegionCollapsed("left-sidebar", true);
    store.getState().resetLayout();
    unsubscribe();

    expect(notifications).toBe(5);
  });
});
