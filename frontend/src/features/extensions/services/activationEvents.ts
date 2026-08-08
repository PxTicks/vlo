import { useProjectStore } from "../../project";

export type ParsedActivationEvent =
  | { readonly kind: "startup" }
  | { readonly kind: "project-open" }
  | { readonly kind: "extension"; readonly extensionId: string };

const EXTENSION_EVENT_PREFIX = "onExtension:";
const EXTENSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/**
 * Parses one declared activation event. Returns null for anything the host does
 * not publish; the backend manifest validator rejects those before a package is
 * ever approved, so this is a second gate rather than the only one.
 */
export function parseActivationEvent(value: string): ParsedActivationEvent | null {
  if (value === "onStartup") return { kind: "startup" };
  if (value === "onProjectOpen") return { kind: "project-open" };
  if (value.startsWith(EXTENSION_EVENT_PREFIX)) {
    const extensionId = value.slice(EXTENSION_EVENT_PREFIX.length);
    if (!EXTENSION_ID_PATTERN.test(extensionId)) return null;
    return { kind: "extension", extensionId };
  }
  return null;
}

/** A project is open once it has both a record and a filesystem root. */
export function isProjectOpen(): boolean {
  const state = useProjectStore.getState();
  return state.project !== null && state.rootHandle !== null;
}

/**
 * Fires once, the first time a project is open. The runtime only needs the
 * leading edge: a package activates on the first project and stays active
 * across later switches, exactly as a startup package does.
 */
export function subscribeProjectOpen(listener: () => void): () => void {
  if (isProjectOpen()) {
    listener();
    return () => undefined;
  }
  const unsubscribe = useProjectStore.subscribe(() => {
    if (!isProjectOpen()) return;
    unsubscribe();
    listener();
  });
  return unsubscribe;
}
