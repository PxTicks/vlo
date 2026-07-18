import type { HostMenuItemDescriptor } from "./menuDescriptors";
import {
  hostMenuCatalog,
  type HostMenuCatalog,
  type ShellDisposable,
} from "./hostMenuCatalog";

/**
 * Imperative context-menu service (extension-shell-surfaces-plan §3.2) for
 * call-sites without a natural component home — components that own anchor
 * state should render `AppMenu` directly. One menu is active at a time; a
 * `MenuHostMount` in the app shell renders the active request.
 */
export interface ShellContextMenuRequest {
  readonly menuId: string;
  /** Detached subject; must satisfy the menu's catalogued subject schema. */
  readonly subject: unknown;
  readonly items: readonly HostMenuItemDescriptor[];
  readonly position: { readonly x: number; readonly y: number };
}

export interface ActiveShellContextMenu extends ShellContextMenuRequest {
  readonly requestId: number;
}

export class ContextMenuService {
  private active: ActiveShellContextMenu | null = null;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private nextRequestId = 1;
  private readonly catalog: HostMenuCatalog;

  constructor(catalog: HostMenuCatalog = hostMenuCatalog) {
    this.catalog = catalog;
  }

  /**
   * Shows one context menu, replacing any active one. Throws on undeclared
   * menus or invalid subjects — both are host programming errors.
   */
  show(request: ShellContextMenuRequest): ShellDisposable {
    if (!this.catalog.has(request.menuId)) {
      throw new Error(
        `Context menu '${request.menuId}' is not in the host menu catalogue.`,
      );
    }
    if (!this.catalog.validateSubject(request.menuId, request.subject)) {
      throw new Error(
        `Context menu '${request.menuId}' subject failed its schema.`,
      );
    }
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.active = Object.freeze({ ...request, requestId });
    this.emitChange();
    return Object.freeze({
      dispose: () => this.close(requestId),
    });
  }

  /** Closes the active menu; with `requestId`, only if it is still active. */
  close(requestId?: number): void {
    if (this.active === null) return;
    if (requestId !== undefined && this.active.requestId !== requestId) return;
    this.active = null;
    this.emitChange();
  }

  getActive(): ActiveShellContextMenu | null {
    return this.active;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.revision;
  }

  private emitChange(): void {
    this.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Menu observers are derived render notifications only.
      }
    }
  }
}

export const contextMenuService = new ContextMenuService();
