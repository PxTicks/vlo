import {
  contextMenuService,
  type ShellContextMenuRequest,
} from "./contextMenuService";
import type { ShellDisposable } from "./hostMenuCatalog";
import {
  declareHostMenus,
  type HostMenuId,
  type HostMenuSubject,
} from "./hostMenus";
import type { HostMenuItemDescriptor } from "./menuDescriptors";

// Shell-owned catalogue initialization (§3.10 review finding 1): the typed
// entry point guarantees the declarations exist before `show()` validates.
declareHostMenus();

export interface HostContextMenuRequest<TMenuId extends HostMenuId> {
  readonly menuId: TMenuId;
  readonly subject: HostMenuSubject<TMenuId>;
  readonly items: readonly HostMenuItemDescriptor[];
  readonly position: { readonly x: number; readonly y: number };
}

/**
 * Typed entry point for the shell context-menu service. The request is
 * validated against the menu's catalogued subject schema and rendered by
 * `MenuHostMount` in the app shell. The caller owns the returned handle: an
 * open menu is not tied to any component tree, so a component that shows one
 * must dispose it when it unmounts or its subject disappears — React
 * call-sites should use `useHostContextMenu`, which does this automatically.
 * Components that own anchor state should render `AppMenu` directly instead.
 */
export function showHostContextMenu<TMenuId extends HostMenuId>(
  request: HostContextMenuRequest<TMenuId>,
): ShellDisposable {
  return contextMenuService.show(request as ShellContextMenuRequest);
}
