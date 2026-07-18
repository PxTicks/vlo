import type {
  ExtensionCommandInvocation,
  ExtensionModule,
  ExtensionUiMenuItemContext,
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
  const { commands } = context.api.ui;

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

  context.api.ui.registerMenuItem({
    id: "bump-menu",
    apiVersion: 1,
    slot: "timeline.clip.context",
    kind: "menu-item",
    label: "Bump Counter",
    onSelect: (menuContext: ExtensionUiMenuItemContext) => {
      if (menuContext.slot !== "timeline.clip.context") return;
      void commands.execute("bump-counter", { clipId: menuContext.clip.id });
    },
  });

  context.logger.info("command-hotkeys fixture activated", {
    contextKeySample: commands.getContextKey("project.open") ?? null,
  });
};
