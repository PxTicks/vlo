import type {
  ExtensionCommandInvocation,
  ExtensionContextKeyExpression,
} from "@vlo/extension-sdk";
import {
  assertContextKeyExpression,
  hostContextKeys,
  type HostContextKeyService,
} from "./contextKeys";
import type { ShellDisposable } from "./hostMenuCatalog";

const HOST_COMMAND_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;

/** A host-owned command. Registered by feature modules with stable dotted IDs. */
export interface HostCommandDefinition {
  readonly id: string;
  readonly title: string;
  /**
   * Opts this command into `api.ui.commands.execute()`. Host commands are an
   * authority surface, so this is per-command review by construction: someone
   * writes it at the definition site, and it lives and dies with the entry.
   * The intended path for extensions remains contributing a menu item the
   * *user* invokes; reach for this only when there is no scoped equivalent.
   */
  readonly allowExtensionExecute?: boolean;
  readonly when?: ExtensionContextKeyExpression;
  readonly run: (
    invocation: ExtensionCommandInvocation,
  ) => void | Promise<void>;
}

/**
 * One command in the table. Host entries report failures to the console;
 * the extensions adapter registers owner-qualified entries whose failures
 * report to the owning scope.
 */
export interface CommandTableEntry {
  readonly id: string;
  readonly title: string;
  readonly icon?: () => unknown;
  readonly when?: ExtensionContextKeyExpression;
  readonly run: (
    invocation: ExtensionCommandInvocation,
  ) => void | Promise<void>;
  readonly source: "host" | "extension";
  /** Host entries only; see {@link HostCommandDefinition.allowExtensionExecute}. */
  readonly allowExtensionExecute?: boolean;
  readonly reportError: (message: string, error: unknown) => void;
}

/**
 * The single command table (extension-shell-surfaces plan §3.1, shell-owned
 * per §3.10). Menus, keybindings, and future palette/toolbar surfaces execute
 * through it rather than holding callbacks of their own. Host and extension
 * commands live side by side as uniform entries; the owner-scoped SDK facade
 * over `registerEntry` lives in the extensions feature.
 */
export class HostCommandTable {
  private readonly entries = new Map<string, CommandTableEntry>();
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly contextKeys: HostContextKeyService;

  constructor(contextKeys: HostContextKeyService = hostContextKeys) {
    this.contextKeys = contextKeys;
  }

  registerHostCommand(definition: HostCommandDefinition): ShellDisposable {
    const id = definition.id;
    if (!HOST_COMMAND_ID_PATTERN.test(id) || !id.includes(".")) {
      throw new Error(`Invalid host command ID '${id}'.`);
    }
    if (typeof definition.run !== "function") {
      throw new Error(`Host command '${id}' must define run().`);
    }
    if (definition.when !== undefined) {
      assertContextKeyExpression(definition.when, `Host command '${id}'`);
    }
    return this.registerEntry({
      id,
      title: definition.title,
      when: definition.when,
      run: definition.run,
      source: "host",
      ...(definition.allowExtensionExecute === true
        ? { allowExtensionExecute: true }
        : {}),
      reportError: (message, error) => console.error(message, error),
    });
  }

  /**
   * Adapter seam for pre-validated entries (the extensions feature's
   * owner-qualified commands). Duplicate IDs reject across both sources.
   */
  registerEntry(entry: CommandTableEntry): ShellDisposable {
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error("Command entries require a non-empty ID.");
    }
    if (this.entries.has(entry.id)) {
      throw new Error(`Command '${entry.id}' is already registered.`);
    }
    const frozen = Object.freeze({ ...entry });
    this.entries.set(entry.id, frozen);
    this.emitChange();
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.entries.get(entry.id) === frozen) {
          this.entries.delete(entry.id);
          this.emitChange();
        }
      },
    });
  }

  getEntry(commandId: string): CommandTableEntry | undefined {
    return this.entries.get(commandId);
  }

  getTitle(commandId: string): string | undefined {
    return this.entries.get(commandId)?.title;
  }

  has(commandId: string): boolean {
    return this.entries.has(commandId);
  }

  isHostCommand(commandId: string): boolean {
    return this.entries.get(commandId)?.source === "host";
  }

  /**
   * Carried on the entry rather than a parallel set, so an allowance cannot
   * outlive the command it was granted for. No host command opts in today;
   * the mechanism exists so the SDK's documented capability is reachable and
   * each future grant is a reviewable one-line change.
   */
  isHostExecuteAllowlisted(commandId: string): boolean {
    const entry = this.entries.get(commandId);
    return entry?.source === "host" && entry.allowExtensionExecute === true;
  }

  isEnabled(commandId: string): boolean {
    const entry = this.entries.get(commandId);
    if (!entry) return false;
    if (entry.when === undefined) return true;
    return this.contextKeys.evaluate(entry.when);
  }

  /**
   * Host-surface dispatch (menus, keybindings). Returns false when the command
   * is missing or disabled; execution failures are isolated and reported so a
   * throwing command never breaks the invoking surface.
   */
  executeCommand(
    commandId: string,
    invocation: ExtensionCommandInvocation,
  ): boolean {
    const entry = this.entries.get(commandId);
    if (!entry || !this.isEnabled(commandId)) return false;
    void (async () => {
      try {
        await entry.run(invocation);
      } catch (error) {
        entry.reportError(`Command '${commandId}' failed.`, error);
      }
    })();
    return true;
  }

  /** Notifies on any command registration or disposal, either source. */
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
        // Command observers are derived render notifications only.
      }
    }
  }
}

export const hostCommandTable = new HostCommandTable();
