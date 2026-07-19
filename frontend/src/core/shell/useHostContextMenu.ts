import { useCallback, useEffect, useRef } from "react";
import type { ShellDisposable } from "./hostMenuCatalog";
import type { HostMenuId } from "./hostMenus";
import {
  showHostContextMenu,
  type HostContextMenuRequest,
} from "./showHostContextMenu";

/**
 * Component-owned imperative context menus. `MenuHostMount` renders menus at
 * the app shell, so a request would otherwise outlive the component that
 * made it and keep stale closures alive; this hook binds the active request
 * to the caller's lifecycle — replacing it on re-show and closing it on
 * unmount. Use this instead of calling `showHostContextMenu` from React.
 */
export function useHostContextMenu(): <TMenuId extends HostMenuId>(
  request: HostContextMenuRequest<TMenuId>,
) => void {
  const activeRef = useRef<ShellDisposable | null>(null);

  useEffect(
    () => () => {
      activeRef.current?.dispose();
      activeRef.current = null;
    },
    [],
  );

  return useCallback(
    <TMenuId extends HostMenuId>(request: HostContextMenuRequest<TMenuId>) => {
      activeRef.current?.dispose();
      activeRef.current = showHostContextMenu(request);
    },
    [],
  );
}
