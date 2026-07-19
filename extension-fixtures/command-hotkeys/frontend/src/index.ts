import type {
  ExtensionCommandInvocation,
  ExtensionModule,
} from "@vlo/extension-sdk";

interface BumpState {
  count: number;
  lastInvocation: ExtensionCommandInvocation | null;
}

const bumpState: BumpState = { count: 0, lastInvocation: null };

/** Test-only accessor; not part of any host contract. */
export function getBumpStateForConformance(): Readonly<BumpState> {
  return bumpState;
}

export function resetBumpStateForConformance(): void {
  bumpState.count = 0;
  bumpState.lastInvocation = null;
}

export const activate: ExtensionModule["activate"] = (context) => {
  const { commands, menus } = context.api.ui;

  commands.register({
    id: "bump-counter",
    apiVersion: 1,
    title: "Bump Counter",
    when: { key: "project.open" },
    run: (invocation) => {
      bumpState.count += 1;
      bumpState.lastInvocation = invocation;
    },
  });

  commands.registerKeybinding({
    id: "bump-key",
    apiVersion: 1,
    chord: "Mod+Alt+B",
    command: "bump-counter",
  });

  // Deliberate collision with a host-owned chord. The contract under test is
  // shadow-not-fail: activation succeeds, the binding is inactive, and a
  // diagnostic is reported.
  commands.registerKeybinding({
    id: "undo-collision",
    apiVersion: 1,
    chord: "Mod+Z",
    command: "bump-counter",
  });

  // The same command placed in both wave-1 menus: the host renders the item
  // from the command definition and invokes it with the menu's detached
  // subject. The clip placement carries a structured visibility condition
  // over the subject; there are no menu-owned callbacks.
  menus.addItem({
    id: "bump-menu",
    apiVersion: 1,
    menuId: "timeline.clip.context",
    kind: "command",
    command: "bump-counter",
    group: "9_extensions",
    when: { subject: { path: ["clip", "id"] } },
  });
  menus.addItem({
    id: "bump-library",
    apiVersion: 1,
    menuId: "library.item.actions",
    kind: "command",
    command: "bump-counter",
    group: "9_extensions",
  });

  context.logger.info("command-hotkeys fixture activated", {
    contextKeySample: commands.getContextKey("project.open") ?? null,
    menuCatalogue: menus.listMenus().map((menu) => menu.id),
  });
};
