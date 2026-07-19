import type { ReactNode } from "react";
import type { JsonValue } from "@vlo/extension-sdk";

/**
 * Contribution seam between the shell menu renderer and the extensions
 * feature (plan §3.10): shell renders whatever the installed source returns,
 * without importing extension registries. Contributions are command
 * placements — the shell resolves label and enablement from its command
 * table and dispatches through it, so contributed items never carry
 * selection callbacks (plan §3.3). The source is a React hook — `AppMenu`
 * calls it unconditionally on every render — so its identity must never
 * change once rendering has begun; installation latches on first use and
 * later replacement throws.
 */
export interface ContributedMenuCommand {
  /** Owner-qualified placement ID; doubles as the test-ID suffix. */
  readonly id: string;
  /** Fully qualified command ID resolved in the shell command table. */
  readonly command: string;
  /** Ordering group; sorts lexically alongside host groups. */
  readonly group: string;
  readonly order: number;
  /** Pre-wrapped, error-isolated icon element, or null when none. */
  readonly icon: ReactNode | null;
  /** Detached, frozen subject clone passed to the command invocation. */
  readonly subject: JsonValue;
}

export type MenuContributionsHook = (
  menuId: string,
  subject: unknown,
) => readonly ContributedMenuCommand[];

const EMPTY_SOURCE: MenuContributionsHook = () => [];

let source: MenuContributionsHook = EMPTY_SOURCE;
let latched = false;

export function installMenuContributions(hook: MenuContributionsHook): void {
  if (source === hook) return;
  if (latched) {
    throw new Error(
      "Menu contributions must be installed before the first menu render.",
    );
  }
  if (source !== EMPTY_SOURCE) {
    throw new Error("A menu contributions source is already installed.");
  }
  source = hook;
}

/** Latches: after the first call the installed source is fixed for the app. */
export function getMenuContributions(): MenuContributionsHook {
  latched = true;
  return source;
}
