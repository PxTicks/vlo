/**
 * The shell-owned host menu catalogue (extension-shell-surfaces-plan §3.2,
 * §3.10). A menu is catalogued by declaring its ID together with a structural
 * validator for the detached subject it carries; declaring here is what makes
 * a menu a valid target for extension menu-item contributions and for the
 * imperative context-menu service. This module is feature-free: features
 * declare into it, never the reverse.
 */

import type { JsonValue } from "@vlo/extension-sdk";

const MENU_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;

export interface ShellDisposable {
  dispose(): void;
}

export interface HostMenuDeclaration {
  readonly id: string;
  /**
   * Structural check for this menu's subject. Runs at render/show time for
   * host call-sites, so it guards non-TS callers and stale casts; extension
   * contributions receive only subjects that passed it.
   */
  readonly validateSubject: (subject: unknown) => boolean;
  /**
   * Serialisable structural description of the subject, surfaced through
   * extension menu discovery (`menus.listMenus()`). Documentation-grade;
   * `validateSubject` is authoritative.
   */
  readonly subjectSchema: JsonValue;
}

/** Discovery projection of one declared menu. */
export interface HostMenuDescription {
  readonly id: string;
  readonly subjectSchema: JsonValue;
}

export class HostMenuCatalog {
  private readonly menus = new Map<string, HostMenuDeclaration>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  declare(declaration: HostMenuDeclaration): ShellDisposable {
    const { id } = declaration;
    if (!MENU_ID_PATTERN.test(id)) {
      throw new Error(`Invalid host menu ID '${id}'.`);
    }
    if (this.menus.has(id)) {
      throw new Error(`Host menu '${id}' is already declared.`);
    }
    if (typeof declaration.validateSubject !== "function") {
      throw new Error(`Host menu '${id}' must declare validateSubject().`);
    }
    if (declaration.subjectSchema === undefined) {
      throw new Error(`Host menu '${id}' must declare a subjectSchema.`);
    }
    this.menus.set(id, Object.freeze({ ...declaration }));
    this.emitChange();
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.menus.delete(id);
        this.emitChange();
      },
    });
  }

  has(menuId: string): boolean {
    return this.menus.has(menuId);
  }

  list(): readonly string[] {
    return [...this.menus.keys()];
  }

  /** Discovery projection for extension `menus.listMenus()`. */
  describeAll(): readonly HostMenuDescription[] {
    return [...this.menus.values()].map((declaration) =>
      Object.freeze({
        id: declaration.id,
        subjectSchema: declaration.subjectSchema,
      }),
    );
  }

  /** False for unknown menus; validator exceptions fail closed as invalid. */
  validateSubject(menuId: string, subject: unknown): boolean {
    const declaration = this.menus.get(menuId);
    if (!declaration) return false;
    try {
      return declaration.validateSubject(subject);
    } catch {
      return false;
    }
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
        // Catalogue observers are derived notifications only.
      }
    }
  }
}

export const hostMenuCatalog = new HostMenuCatalog();
