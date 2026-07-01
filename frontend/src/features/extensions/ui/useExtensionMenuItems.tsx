import { useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import type {
  ExtensionUiMenuItemContext,
  ExtensionUiMenuSlotId,
} from "../types";
import { extensionUiSlotRegistry } from "./ExtensionUiSlotRegistry";
import { ExtensionTrustedReactMount } from "./ExtensionTrustedReactMount";

export interface ExtensionMenuItemView {
  /** Owner-qualified contribution id. */
  readonly id: string;
  readonly label: string;
  /** Pre-wrapped, error-isolated icon element, or null when none was declared. */
  readonly icon: ReactNode | null;
  /** Runs the extension action with the menu subject; failures are isolated. */
  select(): void;
}

/**
 * Host-facing view of the declarative menu items registered for one menu slot,
 * ready to render as native `<MenuItem>`s. Visibility predicates and `onSelect`
 * run inside owner-scoped try/catch so a faulty extension cannot break the host
 * menu; icons render through the shared trusted-React error boundary.
 */
export function useExtensionMenuItems(
  slot: ExtensionUiMenuSlotId,
  context: ExtensionUiMenuItemContext,
): readonly ExtensionMenuItemView[] {
  useSyncExternalStore(
    (listener) => extensionUiSlotRegistry.subscribe(listener),
    () => extensionUiSlotRegistry.getRevision(),
    () => extensionUiSlotRegistry.getRevision(),
  );

  const views: ExtensionMenuItemView[] = [];
  for (const contribution of extensionUiSlotRegistry.listMenuItems(slot)) {
    const definition = contribution.definition;
    if (definition.kind !== "menu-item") continue;

    if (definition.isVisible) {
      try {
        if (!definition.isVisible(context)) continue;
      } catch (error) {
        definition.report(
          "error",
          `Extension menu item '${contribution.id}' visibility check failed.`,
          error,
        );
        continue;
      }
    }

    const iconComponent = definition.icon as ComponentType<
      Record<string, never>
    > | undefined;
    views.push({
      id: contribution.id,
      label: definition.label,
      icon: iconComponent ? (
        <ExtensionTrustedReactMount
          contributionId={contribution.id}
          surface="Menu item icon"
          report={definition.report}
          component={iconComponent}
          componentProps={{}}
          fallback={null}
        />
      ) : null,
      select: () => {
        try {
          definition.onSelect(context);
        } catch (error) {
          definition.report(
            "error",
            `Extension menu item '${contribution.id}' action failed.`,
            error,
          );
        }
      },
    });
  }
  return views;
}
