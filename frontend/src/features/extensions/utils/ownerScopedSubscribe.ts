import type { RevisionSource } from "../../../core/shell/revisionRelay";
import type { ExtensionApiScope } from "../types";

/**
 * Owner-scoped adapter over a shell revision source: listener failures are
 * isolated and reported on the owning scope (the listener stays subscribed,
 * matching host store behaviour), and subscriptions are enrolled for
 * disposal on deactivation.
 */
export function bindOwnerScopedSubscribe(
  scope: ExtensionApiScope,
  source: RevisionSource,
  label: string,
): (listener: () => void) => () => void {
  return (listener: () => void) => {
    if (typeof listener !== "function") {
      throw new TypeError(`${label} subscriber must be a function.`);
    }
    if (scope.signal.aborted) return () => undefined;
    const unsubscribe = source.subscribe(() => {
      try {
        listener();
      } catch (error) {
        scope.report("error", `${label} subscriber failed.`, error);
      }
    });
    const owned = scope.own({ dispose: () => unsubscribe() });
    return () => {
      void owned.dispose();
    };
  };
}
