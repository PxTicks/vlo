import {
  contextMenuService,
  type ShellContextMenuRequest,
} from "../../../core/shell/contextMenuService";
import type { ShellDisposable } from "../../../core/shell/hostMenuCatalog";
import type { HostMenuItemDescriptor } from "../../../core/shell/menuDescriptors";
import type { HostMenuSubject } from "./AppMenu";
import type { HostMenuId } from "./menuCatalogue";

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
