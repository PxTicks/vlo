import type { ReactNode } from "react";

/**
 * Contribution seam between the shell menu renderer and the extensions
 * feature (plan §3.10): shell renders whatever the installed source returns,
 * without importing extension registries. The source is a React hook —
 * `AppMenu` calls it unconditionally on every render — so its identity must
 * never change once rendering has begun; installation latches on first use
 * and later replacement throws.
 */
export interface ContributedMenuItem {
  /** Owner-qualified contribution ID; doubles as the test-ID suffix. */
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode | null;
  /** Runs the contributed action; failures must be isolated by the source. */
  select(): void;
}

export type MenuContributionsHook = (
  menuId: string,
  subject: unknown,
) => readonly ContributedMenuItem[];

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
