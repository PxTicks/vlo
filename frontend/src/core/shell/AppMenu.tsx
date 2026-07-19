import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import {
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  type MenuProps,
} from "@mui/material";
import { hostCommandTable } from "./commandTable";
import { hostContextKeys } from "./contextKeys";
import { hostMenuCatalog } from "./hostMenuCatalog";
import {
  declareHostMenus,
  type HostMenuId,
  type HostMenuSubject,
} from "./hostMenus";
import { getMenuContributions } from "./menuContributions";
import type { HostMenuItemDescriptor } from "./menuDescriptors";

// Shell-owned catalogue initialization (§3.10 review finding 1): the renderer
// itself guarantees the declarations exist before any subject validation.
declareHostMenus();

export interface AppMenuProps<TMenuId extends HostMenuId = HostMenuId> {
  /** Catalogued host menu ID (`hostMenus.ts`); typos fail to compile. */
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
   * Test-ID prefix for contributed items. Defaults to the standard prefix;
   * wave-1 call-sites pass their historical prefixes.
   */
  readonly extensionItemTestIdPrefix?: string;
}

interface RenderableMenuItem {
  readonly key: string;
  readonly group: string;
  readonly order: number;
  /** Extension items sort after host items at equal group and order. */
  readonly contributed: boolean;
  readonly label: string;
  readonly icon: ReactNode | null;
  readonly disabled: boolean;
  readonly testId?: string;
  readonly select: () => void;
}

/**
 * The single descriptor-driven menu renderer (plan §3.2, shell-owned per
 * §3.10). Host call-sites describe their items as data; command placements
 * from the installed contributions source (the extensions feature, when
 * present) merge into their declared groups, after host items at equal
 * order. Rendering a menu through this component is what makes it part of
 * the extensible catalogue.
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
  // Statically guaranteed by HostMenuSubject; the catalogued schema guards
  // non-TS callers and stale casts (it also checks `subject.slot`).
  if (!hostMenuCatalog.validateSubject(menuId, subject)) {
    throw new Error(
      `AppMenu subject for '${menuId}' failed the menu's catalogued schema.`,
    );
  }
  // Command enablement is context-key- and table-driven; re-render on both.
  useSyncExternalStore(
    (listener) => hostContextKeys.subscribe(listener),
    () => hostContextKeys.getRevision(),
    () => hostContextKeys.getRevision(),
  );
  useSyncExternalStore(
    (listener) => hostCommandTable.subscribe(listener),
    () => hostCommandTable.getRevision(),
    () => hostCommandTable.getRevision(),
  );
  const contributedItems = getMenuContributions()(menuId, subject);

  const renderable: RenderableMenuItem[] = items.map((item, index) => {
    if (item.kind === "command") {
      const known = hostCommandTable.has(item.command);
      return {
        key: item.id,
        group: item.group,
        order: item.order ?? index,
        contributed: false,
        label:
          item.label ?? hostCommandTable.getTitle(item.command) ?? item.command,
        icon: item.icon ?? null,
        disabled:
          Boolean(item.disabled) ||
          !known ||
          !hostCommandTable.isEnabled(item.command),
        select: () => {
          hostCommandTable.executeCommand(item.command, {
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
      contributed: false,
      label: item.label,
      icon: item.icon ?? null,
      disabled: Boolean(item.disabled),
      select: item.run,
    };
  });

  // Contributed command placements render through the same command-table
  // machinery as host command items; the contribution source has already
  // dropped orphaned or condition-hidden placements.
  for (const item of contributedItems) {
    renderable.push({
      key: item.id,
      group: item.group,
      order: item.order,
      contributed: true,
      label: hostCommandTable.getTitle(item.command) ?? item.command,
      icon: item.icon,
      disabled:
        !hostCommandTable.has(item.command) ||
        !hostCommandTable.isEnabled(item.command),
      testId: `${extensionItemTestIdPrefix}${item.id}`,
      select: () => {
        hostCommandTable.executeCommand(item.command, {
          subject: item.subject,
          source: "menu",
        });
      },
    });
  }

  renderable.sort(
    (left, right) =>
      left.group.localeCompare(right.group) ||
      left.order - right.order ||
      Number(left.contributed) - Number(right.contributed) ||
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
