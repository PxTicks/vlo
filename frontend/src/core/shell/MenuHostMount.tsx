import { useSyncExternalStore } from "react";
import { AppMenu } from "./AppMenu";
import { contextMenuService } from "./contextMenuService";
import type { HostMenuId, HostMenuSubject } from "./hostMenus";

/**
 * Renders the shell context-menu service's active request through `AppMenu`.
 * Mount once in the app shell, beside the extension modal host.
 */
export function MenuHostMount() {
  useSyncExternalStore(
    (listener) => contextMenuService.subscribe(listener),
    () => contextMenuService.getRevision(),
    () => contextMenuService.getRevision(),
  );
  const active = contextMenuService.getActive();
  if (active === null) return null;
  // The service validated the subject against the catalogued schema at
  // show(); the casts restore the typed pairing the service stores erased.
  return (
    <AppMenu
      menuId={active.menuId as HostMenuId}
      subject={active.subject as HostMenuSubject<HostMenuId>}
      items={active.items}
      open
      onClose={() => contextMenuService.close(active.requestId)}
      anchorPosition={{ top: active.position.y, left: active.position.x }}
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}
