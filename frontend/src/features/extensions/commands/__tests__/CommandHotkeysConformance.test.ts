import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionContext,
  ExtensionResource,
  VloExtensionApi,
} from "../../types";
import {
  activate,
  getBumpStateForConformance,
  resetBumpStateForConformance,
} from "../../../../../../extension-fixtures/command-hotkeys/frontend/src/index";
import { ExtensionUiContributionRegistry } from "../../ui/ExtensionUiSlotRegistry";
import { HostCommandTable } from "../../../../core/shell/commandTable";
import { HostContextKeyService } from "../../../../core/shell/contextKeys";
import { HostKeybindingRegistry } from "../../../../core/shell/keybindingRegistry";
import { hostMenuCatalog } from "../../../../core/shell/hostMenuCatalog";
import { declareHostMenus } from "../../../../core/shell/hostMenus";
import {
  ExtensionMenuPlacementRegistry,
  resolveMenuPlacements,
} from "../../menus/ExtensionMenuPlacementRegistry";
import { createExtensionCommandApi } from "../CommandRegistry";

const CLIP_SUBJECT = {
  slot: "timeline.clip.context",
  clip: {
    id: "clip-9",
    type: "video",
    name: "Clip",
    trackId: "track-1",
    startTicks: 0,
    durationTicks: 100,
    transformations: [],
  },
} as const;

function keyEvent(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", { cancelable: true, ...init });
}

describe("command-hotkeys conformance fixture", () => {
  it("registers command, working chord, shadowed collision, and menu placements; disposal removes all", async () => {
    resetBumpStateForConformance();
    declareHostMenus();
    const contextKeys = new HostContextKeyService();
    const keybindings = new HostKeybindingRegistry(() => false);
    const commandTable = new HostCommandTable(contextKeys);
    const uiRegistry = new ExtensionUiContributionRegistry();
    const menuPlacements = new ExtensionMenuPlacementRegistry(
      hostMenuCatalog,
      commandTable,
    );
    const report = vi.fn();
    const resources: ExtensionResource[] = [];
    const scope = {
      extension: { id: "example.command-hotkeys", version: "1.0.0" },
      signal: new AbortController().signal,
      own: <TResource extends ExtensionResource>(resource: TResource) => {
        resources.push(resource);
        return resource;
      },
      report,
    };

    // Host side: a real command-backed default binding on Mod+Z, exactly as
    // the production timeline installs one, for the fixture to collide with.
    const hostUndo = vi.fn();
    commandTable.registerHostCommand({
      id: "timeline.undo",
      title: "Undo",
      run: hostUndo,
    });
    keybindings.registerHostDefault({
      id: "host.timeline.undo",
      chord: "Mod+Z",
      commandId: "timeline.undo",
    });
    contextKeys.set("project.open", true);

    const api = {
      ui: {
        ...uiRegistry.bind(scope),
        commands: createExtensionCommandApi(scope, commandTable, keybindings, contextKeys),
        menus: menuPlacements.bind(scope),
      },
    } as unknown as VloExtensionApi;
    const context = {
      extension: scope.extension,
      sdkVersion: "1.7.0",
      signal: scope.signal,
      api,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      onDispose: (resource: ExtensionResource) => {
        resources.push(resource);
      },
    } as unknown as ExtensionContext<VloExtensionApi>;

    await activate(context);

    // Command registered owner-qualified.
    expect(
      commandTable.getTitle("example.command-hotkeys/bump-counter"),
    ).toBe("Bump Counter");

    // The collision registered inactive with a diagnostic; activation did not
    // fail and the working chord is active.
    expect(
      keybindings.list().map((entry) => [entry.id, entry.active]),
    ).toEqual([
      ["host.timeline.undo", true],
      ["example.command-hotkeys/bump-key", true],
      ["example.command-hotkeys/undo-collision", false],
    ]);
    expect(report).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("shadowed"),
    );

    const dispatch = (event: KeyboardEvent) =>
      keybindings.dispatch(event, null, (commandId) =>
        commandTable.executeCommand(commandId, { source: "keybinding" }),
      );

    // The working chord executes the fixture command.
    expect(dispatch(keyEvent({ key: "b", ctrlKey: true, altKey: true }))).toBe(
      true,
    );
    expect(getBumpStateForConformance()).toMatchObject({
      count: 1,
      lastInvocation: { source: "keybinding" },
    });

    // The shadowed chord still routes to the host command, never the fixture.
    expect(dispatch(keyEvent({ key: "z", ctrlKey: true }))).toBe(true);
    expect(hostUndo).toHaveBeenCalledTimes(1);
    expect(getBumpStateForConformance().count).toBe(1);

    // The `when` clause gates dispatch: no project, no execution, no
    // preventDefault.
    contextKeys.set("project.open", false);
    const gated = keyEvent({ key: "b", ctrlKey: true, altKey: true });
    expect(dispatch(gated)).toBe(false);
    expect(gated.defaultPrevented).toBe(false);
    contextKeys.set("project.open", true);

    // One command, placed in both wave-1 menus through `ui.menus.addItem` —
    // no menu-owned callbacks. The clip placement's structured subject
    // condition passes for this subject.
    const resolveDeps = {
      registry: menuPlacements,
      table: commandTable,
      getContextKey: (key: string) => contextKeys.get(key),
    };
    const clipPlacements = resolveMenuPlacements(
      "timeline.clip.context",
      CLIP_SUBJECT,
      resolveDeps,
    );
    expect(clipPlacements.map((placement) => placement.id)).toEqual([
      "example.command-hotkeys/bump-menu",
    ]);
    expect(
      resolveMenuPlacements(
        "library.item.actions",
        { slot: "library.item.actions", asset: { id: "a1", name: "A", type: "image" } },
        resolveDeps,
      ).map((placement) => placement.id),
    ).toEqual(["example.command-hotkeys/bump-library"]);

    // Invoking the placement dispatches through the command table with the
    // menu's detached subject.
    expect(
      commandTable.executeCommand(clipPlacements[0].command, {
        subject: clipPlacements[0].subject,
        source: "menu",
      }),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(getBumpStateForConformance()).toMatchObject({
        count: 2,
        lastInvocation: { source: "menu", subject: CLIP_SUBJECT },
      });
    });

    // Deactivation removes every owner-scoped registration.
    for (const resource of [...resources].reverse()) {
      if (typeof resource === "function") await resource();
      else await resource.dispose();
    }
    expect(commandTable.has("example.command-hotkeys/bump-counter")).toBe(
      false,
    );
    expect(keybindings.list().map((entry) => entry.id)).toEqual([
      "host.timeline.undo",
    ]);
    expect(menuPlacements.listForMenu("timeline.clip.context")).toEqual([]);
    expect(menuPlacements.listForMenu("library.item.actions")).toEqual([]);
  });
});
