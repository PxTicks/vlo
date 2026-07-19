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

/**
 * Typed entry point for the shell context-menu service. Call-sites without a
 * natural component home (canvas overlays, imperative handlers) use this;
 * components that own anchor state should render `AppMenu` directly. The
 * request is validated against the menu's catalogued subject schema and
 * rendered by `MenuHostMount` in the app shell.
 */
export function showHostContextMenu<TMenuId extends HostMenuId>(request: {
  readonly menuId: TMenuId;
  readonly subject: HostMenuSubject<TMenuId>;
  readonly items: readonly HostMenuItemDescriptor[];
  readonly position: { readonly x: number; readonly y: number };
}): ShellDisposable {
  return contextMenuService.show(request as ShellContextMenuRequest);
}
