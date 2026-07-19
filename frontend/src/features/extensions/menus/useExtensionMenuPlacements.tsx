import { useSyncExternalStore, type ComponentType } from "react";
import type { ContributedMenuCommand } from "../../../core/shell/menuContributions";
import { ExtensionTrustedReactMount } from "../ui/ExtensionTrustedReactMount";
import {
  extensionMenuPlacementRegistry,
  resolveMenuPlacements,
} from "./ExtensionMenuPlacementRegistry";

/**
 * The extensions half of the §3.10 menu split, in §3.3's command-placement
 * shape: resolves this menu's contributed command placements (orphan
 * dropping, structured `when` conditions, subject detachment) and wraps
 * trusted command icons in the shared error boundary. Label, enablement, and
 * dispatch stay with the shell renderer's command-table machinery. The shell
 * caller already re-renders on command-table and context-key changes, so
 * only placement registrations are subscribed here.
 */
export function useExtensionMenuPlacements(
  menuId: string,
  subject: unknown,
): readonly ContributedMenuCommand[] {
  useSyncExternalStore(
    (listener) => extensionMenuPlacementRegistry.subscribe(listener),
    () => extensionMenuPlacementRegistry.getRevision(),
    () => extensionMenuPlacementRegistry.getRevision(),
  );

  return resolveMenuPlacements(menuId, subject).map((placement) => {
    const iconComponent = placement.icon as ComponentType<
      Record<string, never>
    > | null;
    return {
      id: placement.id,
      command: placement.command,
      group: placement.group,
      order: placement.order,
      icon: iconComponent ? (
        <ExtensionTrustedReactMount
          contributionId={placement.id}
          surface="Menu item icon"
          report={placement.report}
          component={iconComponent}
          componentProps={{}}
          fallback={null}
        />
      ) : null,
      subject: placement.subject,
    };
  });
}
