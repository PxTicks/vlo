import type { ReactNode } from "react";
import type { JsonValue } from "@vlo/extension-sdk";

/**
 * Ordering groups sort lexically, items by `order` within a group (extension
 * placements after host items at equal order), and the renderer inserts a
 * divider at each group boundary. This is the conventional trailing group
 * for extension placements that don't target a specific host group.
 */
export const EXTENSION_MENU_GROUP = "9_extensions";

interface HostMenuItemBase {
  /** Stable item ID. Anchor target and test handle; treat renames as contract. */
  readonly id: string;
  /** Ordering group, e.g. "1_clip". See {@link EXTENSION_MENU_GROUP}. */
  readonly group: string;
  /** Position within the group; defaults to declaration order. */
  readonly order?: number;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
}

/**
 * A menu item that executes a command from the host command table. Enablement
 * combines `disabled` with the command's `when` clause; the label falls back
 * to the command's title.
 */
export interface HostMenuCommandItem extends HostMenuItemBase {
  readonly kind: "command";
  readonly command: string;
  /** Detached JSON subject passed to the command invocation. */
  readonly subject?: JsonValue;
  readonly label?: string;
}

/**
 * A menu item with an inline handler. This is the migration lane for host
 * handlers still coupled to component state; new items should prefer
 * `kind: "command"` so every menu surface stays a projection of the command
 * table.
 */
export interface HostMenuActionItem extends HostMenuItemBase {
  readonly kind: "action";
  readonly label: string;
  readonly run: () => void;
}

export type HostMenuItemDescriptor = HostMenuCommandItem | HostMenuActionItem;
