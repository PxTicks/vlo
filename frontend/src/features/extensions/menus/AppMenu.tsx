import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import {
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  type MenuProps,
} from "@mui/material";
import type { ExtensionUiMenuItemContext } from "../types";
import { hostCommandRegistry } from "../commands/CommandRegistry";
import { hostContextKeys } from "../commands/contextKeys";
import { useExtensionMenuItems } from "../ui/useExtensionMenuItems";
import type { HostMenuId } from "./menuCatalogue";
import {
  EXTENSION_MENU_GROUP,
  type HostMenuItemDescriptor,
} from "./menuDescriptors";

/** The subject shape belonging to one catalogued menu ID. */
export type HostMenuSubject<TMenuId extends HostMenuId> = Extract<
  ExtensionUiMenuItemContext,
  { slot: TMenuId }
>;

export interface AppMenuProps<TMenuId extends HostMenuId = HostMenuId> {
  /** Catalogued host menu ID (`menuCatalogue.ts`); typos fail to compile. */
  readonly menuId: TMenuId;
  /** Detached menu subject shared with extension contributions. */
  readonly subject: HostMenuSubject<TMenuId>;
  readonly items: readonly HostMenuItemDescriptor[];
  readonly open: boolean;
  readonly onClose: () => void;
  readonly anchorEl?: MenuProps["anchorEl"];
  readonly anchorPosition?: MenuProps["anchorPosition"];
  readonly anchorOrigin?: MenuProps["anchorOrigin"];
  readonly transformOrigin?: MenuProps["transformOrigin"];
  /** Menu-root passthroughs; MUI portals bubble through the React tree. */
  readonly onClick?: (event: MouseEvent<HTMLElement>) => void;
  readonly onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
  /**
   * Test-ID prefix for extension-contributed items. Defaults to the
   * standard prefix; wave-1 call-sites pass their historical prefixes.
   */
  readonly extensionItemTestIdPrefix?: string;
}

interface RenderableMenuItem {
  readonly key: string;
  readonly group: string;
  readonly order: number;
  readonly label: string;
  readonly icon: ReactNode | null;
  readonly disabled: boolean;
  readonly testId?: string;
  readonly select: () => void;
}

/**
 * The single descriptor-driven menu renderer. Host call-sites describe their
 * items as data; extension contributions registered for `menuId` merge into
 * the trailing extension group with per-item error isolation. Rendering a menu
 * through this component is what makes it part of the extensible catalogue.
 */
export function AppMenu<TMenuId extends HostMenuId>({
  menuId,
  subject,
  items,
  open,
  onClose,
  anchorEl,
  anchorPosition,
  anchorOrigin,
  transformOrigin,
  onClick,
  onContextMenu,
  extensionItemTestIdPrefix = "extension-menu-item-",
}: AppMenuProps<TMenuId>) {
  // Statically guaranteed by HostMenuSubject; guards non-TS callers and casts.
  if (subject.slot !== menuId) {
    throw new Error(
      `AppMenu subject slot '${subject.slot}' does not match menu '${menuId}'.`,
    );
  }
  // Command enablement is context-key- and registry-driven; re-render on both.
  useSyncExternalStore(
    (listener) => hostContextKeys.subscribe(listener),
    () => hostContextKeys.getRevision(),
    () => hostContextKeys.getRevision(),
  );
  useSyncExternalStore(
    (listener) => hostCommandRegistry.subscribe(listener),
    () => hostCommandRegistry.getRevision(),
    () => hostCommandRegistry.getRevision(),
  );
  const extensionItems = useExtensionMenuItems(menuId, subject);

  const renderable: RenderableMenuItem[] = items.map((item, index) => {
    if (item.kind === "command") {
      const known = hostCommandRegistry.has(item.command);
      return {
        key: item.id,
        group: item.group,
        order: item.order ?? index,
        label: item.label ?? hostCommandRegistry.getTitle(item.command) ?? item.command,
        icon: item.icon ?? null,
        disabled:
          Boolean(item.disabled) ||
          !known ||
          !hostCommandRegistry.isEnabled(item.command),
        select: () => {
          hostCommandRegistry.executeCommand(item.command, {
            subject: item.subject,
            source: "menu",
          });
        },
      };
    }
    return {
      key: item.id,
      group: item.group,
      order: item.order ?? index,
      label: item.label,
      icon: item.icon ?? null,
      disabled: Boolean(item.disabled),
      select: item.run,
    };
  });

  for (const [index, item] of extensionItems.entries()) {
    renderable.push({
      key: item.id,
      group: EXTENSION_MENU_GROUP,
      order: index,
      label: item.label,
      icon: item.icon,
      disabled: false,
      testId: `${extensionItemTestIdPrefix}${item.id}`,
      select: item.select,
    });
  }

  renderable.sort(
    (left, right) =>
      left.group.localeCompare(right.group) ||
      left.order - right.order ||
      left.key.localeCompare(right.key),
  );

  const children: ReactNode[] = [];
  let previousGroup: string | null = null;
  for (const item of renderable) {
    if (previousGroup !== null && previousGroup !== item.group) {
      children.push(<Divider key={`divider-${item.group}`} />);
    }
    previousGroup = item.group;
    children.push(
      <MenuItem
        key={item.key}
        disabled={item.disabled}
        data-testid={item.testId}
        onClick={() => {
          item.select();
          onClose();
        }}
      >
        {item.icon ? <ListItemIcon>{item.icon}</ListItemIcon> : null}
        <ListItemText>{item.label}</ListItemText>
      </MenuItem>,
    );
  }

  return (
    <Menu
      open={open}
      onClose={onClose}
      anchorEl={anchorEl}
      anchorReference={anchorPosition ? "anchorPosition" : "anchorEl"}
      anchorPosition={anchorPosition}
      anchorOrigin={anchorOrigin}
      transformOrigin={transformOrigin}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {children}
    </Menu>
  );
}
