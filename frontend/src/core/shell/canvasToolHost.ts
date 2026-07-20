import type {
  ExtensionCanvasPointerEvent,
  ExtensionCanvasToolDefinition,
  ExtensionCanvasToolSession,
} from "@vlo/extension-sdk";
import {
  hostContextKeys,
  type HostContextKeyService,
} from "./contextKeys";
import type { ShellDisposable } from "./hostMenuCatalog";

export interface ShellCanvasToolEntry {
  readonly id: string;
  readonly localId: string;
  readonly ownerId: string;
  readonly commandId: string;
  readonly definition: Readonly<ExtensionCanvasToolDefinition>;
  readonly reportError: (message: string, error: unknown) => void;
}

export interface CanvasToolHostBinding {
  readonly session: ExtensionCanvasToolSession;
  clearOverlay(): void;
  setCursor(cursor: string | null): void;
  setExtensionToolActive(active: boolean): void;
}

/**
 * Shell-owned arbitration for exclusive player-canvas interaction modes.
 * Owner qualification and SDK lifecycle ownership stay in the extensions
 * adapter; the Player only consumes this generic, prevalidated table.
 */
export class CanvasToolHost {
  private readonly entries = new Map<string, ShellCanvasToolEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly contextKeys: HostContextKeyService;
  private host: CanvasToolHostBinding | null = null;
  private activeEntry: ShellCanvasToolEntry | null = null;
  private revision = 0;

  constructor(contextKeys: HostContextKeyService = hostContextKeys) {
    this.contextKeys = contextKeys;
  }

  register(entry: ShellCanvasToolEntry): ShellDisposable {
    if (this.entries.has(entry.id)) {
      throw new Error(`Canvas tool '${entry.id}' is already registered.`);
    }
    const frozen = Object.freeze({ ...entry });
    this.entries.set(entry.id, frozen);
    this.emitChange();
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.entries.get(entry.id) !== frozen) return;
        if (this.activeEntry === frozen) {
          this.deactivateActive({ keepHostMode: false, emit: false });
        }
        this.entries.delete(entry.id);
        this.emitChange();
      },
    });
  }

  listAvailable(): readonly ShellCanvasToolEntry[] {
    return [...this.entries.values()].filter((entry) => {
      const when = entry.definition.when;
      return when === undefined || this.contextKeys.evaluate(when);
    });
  }

  getActiveId(): string | null {
    return this.activeEntry?.id ?? null;
  }

  activate(id: string): boolean {
    if (id === this.activeEntry?.id) return true;
    const entry = this.entries.get(id);
    const host = this.host;
    if (!entry || !host) return false;
    if (
      entry.definition.when !== undefined &&
      !this.contextKeys.evaluate(entry.definition.when)
    ) {
      return false;
    }

    const switchingTools = this.activeEntry !== null;
    if (switchingTools) {
      this.deactivateActive({ keepHostMode: true, emit: false });
    } else {
      host.clearOverlay();
      host.setExtensionToolActive(true);
    }
    try {
      entry.definition.activate(host.session);
    } catch (error) {
      host.clearOverlay();
      host.setCursor(null);
      host.setExtensionToolActive(false);
      entry.reportError("Canvas tool activation failed.", error);
      if (switchingTools) this.emitChange();
      return false;
    }
    this.activeEntry = entry;
    host.setCursor(entry.definition.cursor ?? "crosshair");
    this.emitChange();
    return true;
  }

  deactivate(): void {
    this.deactivateActive({ keepHostMode: false, emit: true });
  }

  private deactivateActive(options: {
    keepHostMode: boolean;
    emit: boolean;
  }): void {
    const entry = this.activeEntry;
    if (!entry) return;
    this.activeEntry = null;
    try {
      entry.definition.deactivate();
    } catch (error) {
      entry.reportError("Canvas tool deactivation failed.", error);
    }
    this.host?.clearOverlay();
    this.host?.setCursor(null);
    if (!options.keepHostMode) this.host?.setExtensionToolActive(false);
    if (options.emit) this.emitChange();
  }

  dispatchPointer(event: ExtensionCanvasPointerEvent): boolean {
    const entry = this.activeEntry;
    if (!entry) return false;
    try {
      entry.definition.onPointer(event);
    } catch (error) {
      entry.reportError("Canvas tool pointer handler failed.", error);
    }
    return true;
  }

  attachHost(binding: CanvasToolHostBinding): ShellDisposable {
    if (this.host && this.host !== binding) this.deactivate();
    this.host = binding;
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.host !== binding) return;
        this.deactivate();
        this.host = null;
      },
    });
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
        // Observers only derive toolbar and interaction state.
      }
    }
  }
}

export const canvasToolHost = new CanvasToolHost();
