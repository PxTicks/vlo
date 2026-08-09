import { describe, expect, it } from "vitest";
import {
  migrateLegacyViewLayout,
  parseShellLayoutDocument,
  selectShellLayoutDocument,
} from "../layoutMigrations";
import { EMPTY_SHELL_LAYOUT_DOCUMENT } from "../layoutTypes";

describe("version 1 migration", () => {
  it("carries hidden views and dock ordering across without changing intent", () => {
    const migrated = migrateLegacyViewLayout({
      version: 1,
      hidden: ["host.assets"],
      order: {
        "left-sidebar": ["host.text", "host.assets"],
        "bottom-dock": ["example.a/report", "host.scopes"],
      },
    });

    expect(migrated).toEqual({
      version: 2,
      panels: {
        "host.assets": { visible: false, order: 1 },
        "host.text": { order: 0 },
        "example.a/report": { order: 0 },
        "host.scopes": { order: 1 },
      },
      regions: {},
      workspaceLayouts: {},
      legacyPanelsMerged: true,
    });
  });

  it("keeps hidden state for non-dock views but leaves their ordering to the legacy key", () => {
    const migrated = migrateLegacyViewLayout({
      version: 1,
      hidden: ["host.recent-projects"],
      order: { "projects-page.main": ["host.recent-projects", "host.browse"] },
    });

    expect(migrated?.panels).toEqual({
      "host.recent-projects": { visible: false },
    });
  });

  it("discards entries that are not usable view identifiers", () => {
    const migrated = migrateLegacyViewLayout({
      version: 1,
      hidden: ["", 7, null, "host.ok"],
      order: { "left-sidebar": ["host.ok", 42, "x".repeat(201)] },
    });

    expect(migrated?.panels).toEqual({ "host.ok": { visible: false, order: 0 } });
  });

  it("tolerates a version 1 payload with nothing usable in it", () => {
    expect(migrateLegacyViewLayout({ version: 1 })).toEqual({
      version: 2,
      panels: {},
      regions: {},
      workspaceLayouts: {},
      legacyPanelsMerged: true,
    });
    expect(
      migrateLegacyViewLayout({ version: 1, hidden: "nope", order: 12 }),
    ).toEqual(EMPTY_SHELL_LAYOUT_DOCUMENT);
  });

  it("is not a version 1 document", () => {
    expect(migrateLegacyViewLayout({ version: 2, panels: {} })).toBeNull();
    expect(migrateLegacyViewLayout(null)).toBeNull();
  });
});

describe("version 2 validation", () => {
  it("validates lower-stage geometry", () => {
    const parsed = parseShellLayoutDocument({
      version: 2,
      panels: {},
      regions: {},
      lowerStage: {
        selectedViewId: "host.timeline",
        collapsed: true,
        sizePx: 420,
      },
      workspaceLayouts: {},
    });
    expect(parsed?.lowerStage).toEqual({ collapsed: true, sizePx: 420 });

    expect(
      parseShellLayoutDocument({
        version: 2,
        panels: {},
        regions: {},
        lowerStage: { collapsed: "yes", sizePx: Number.NaN },
        workspaceLayouts: {},
      }),
    ).not.toHaveProperty("lowerStage");
  });

  it("keeps every valid field", () => {
    const parsed = parseShellLayoutDocument({
      version: 2,
      panels: {
        "host.scopes": { region: "right-sidebar", visible: false, order: 3 },
      },
      regions: {
        "bottom-dock": {
          selectedViewId: "host.scopes",
          collapsed: true,
          sizePx: 320,
        },
        "left-sidebar": { selectedViewId: null },
      },
      workspaceLayouts: {
        "host.color": {
          panels: { "host.scopes": { region: "right-sidebar" } },
          regions: { "right-sidebar": { sizePx: 480 } },
        },
      },
    });

    expect(parsed).toEqual({
      version: 2,
      panels: {
        "host.scopes": { region: "right-sidebar", visible: false, order: 3 },
      },
      regions: {
        "bottom-dock": {
          selectedViewId: "host.scopes",
          collapsed: true,
          sizePx: 320,
        },
        "left-sidebar": { selectedViewId: null },
      },
      workspaceLayouts: {
        "host.color": {
          panels: { "host.scopes": { region: "right-sidebar" } },
          regions: { "right-sidebar": { sizePx: 480 } },
        },
      },
    });
  });

  it("retains unknown view identifiers so a disabled extension recovers its placement", () => {
    const parsed = parseShellLayoutDocument({
      version: 2,
      panels: { "example.a/report": { visible: false, order: 2 } },
      regions: {},
      workspaceLayouts: {},
    });

    expect(parsed?.panels["example.a/report"]).toEqual({
      visible: false,
      order: 2,
    });
  });

  it("drops invalid enums, non-finite numbers, and wrong-typed fields", () => {
    const parsed = parseShellLayoutDocument({
      version: 2,
      panels: {
        "host.a": { region: "floating", visible: "yes", order: Number.NaN },
        "host.b": { region: "right-sidebar", visible: 1, order: Infinity },
        "host.c": "not-an-object",
        "": { visible: false },
      },
      regions: {
        "left-sidebar": { sizePx: -10, collapsed: "true" },
        "right-sidebar": { sizePx: Number.NaN },
        "projects-page.main": { sizePx: 200 },
        nonsense: { sizePx: 200 },
      },
      workspaceLayouts: { "host.color": 5, "": { panels: {} } },
    });

    // `host.a` had nothing valid left, so it carries no intent at all.
    expect(parsed).toEqual({
      version: 2,
      panels: { "host.b": { region: "right-sidebar" } },
      regions: {},
      workspaceLayouts: {},
    });
  });

  it("refuses payloads that are not layout documents", () => {
    for (const raw of [
      null,
      undefined,
      42,
      "{}",
      [],
      { version: 3 },
      { version: "2" },
      {},
    ]) {
      expect(parseShellLayoutDocument(raw)).toBeNull();
    }
  });

  it("caps how much corrupt input it will carry forward", () => {
    const panels: Record<string, unknown> = {};
    for (let index = 0; index < 900; index += 1) {
      panels[`junk.${index}`] = { visible: false };
    }
    const parsed = parseShellLayoutDocument({
      version: 2,
      panels,
      regions: {},
      workspaceLayouts: {},
    });

    expect(Object.keys(parsed?.panels ?? {})).toHaveLength(500);
  });
});

describe("selectShellLayoutDocument", () => {
  // A version 2 document written before panels lived here — Phase B only ever
  // stored geometry — must not silently discard the version 1 preferences.
  it("folds legacy panels under an unmerged current document", () => {
    const document = selectShellLayoutDocument({
      current: {
        version: 2,
        panels: { "host.a": { visible: false } },
        regions: { "left-sidebar": { sizePx: 400 } },
        workspaceLayouts: {},
      },
      legacy: {
        version: 1,
        hidden: ["host.a", "host.b"],
        order: { "left-sidebar": ["host.b"] },
      },
    });

    expect(document.panels).toEqual({
      // The current document wins wherever both have an opinion.
      "host.a": { visible: false },
      "host.b": { visible: false, order: 0 },
    });
    expect(document.regions).toEqual({ "left-sidebar": { sizePx: 400 } });
    expect(document.legacyPanelsMerged).toBe(true);
  });

  it("leaves an already-merged document alone", () => {
    const document = selectShellLayoutDocument({
      current: {
        version: 2,
        panels: { "host.a": { visible: false } },
        regions: {},
        workspaceLayouts: {},
        legacyPanelsMerged: true,
      },
      // The user has since re-shown this panel, so the legacy record must not
      // hide it again on the next reload.
      legacy: { version: 1, hidden: ["host.b"], order: {} },
    });

    expect(document.panels).toEqual({ "host.a": { visible: false } });
  });

  it("migrates the legacy document when the current one is missing or corrupt", () => {
    expect(
      selectShellLayoutDocument({
        current: "corrupt",
        legacy: { version: 1, hidden: ["host.b"], order: {} },
      }).panels,
    ).toEqual({ "host.b": { visible: false } });
  });

  it("falls back to no preference when neither source is usable", () => {
    expect(selectShellLayoutDocument({})).toEqual(EMPTY_SHELL_LAYOUT_DOCUMENT);
  });
});
