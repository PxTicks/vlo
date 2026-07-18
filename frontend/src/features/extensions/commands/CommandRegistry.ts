import type {
  ExtensionApiScope,
  ExtensionCommandApi,
  ExtensionCommandDefinition,
  ExtensionCommandInvocation,
  ExtensionContextKeyExpression,
  ExtensionDisposable,
  ExtensionKeybindingRequest,
  ExtensionUiRegistration,
  JsonValue,
} from "../types";
import { jsonValueSchema } from "../persistence/extensionPayload";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionDefinition,
} from "../registry/ExtensionContributionRegistry";
import {
  assertContextKeyExpression,
  hostContextKeys,
  type HostContextKeyService,
} from "./contextKeys";
import type { HostKeybindingRegistry } from "./KeybindingRegistry";
import { hostKeybindingRegistry } from "./KeybindingRegistry";

const HOST_COMMAND_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;

/** A host-owned command. Registered by feature modules with stable dotted IDs. */
export interface HostCommandDefinition {
  readonly id: string;
  readonly title: string;
  readonly when?: ExtensionContextKeyExpression;
  readonly run: (
    invocation: ExtensionCommandInvocation,
  ) => void | Promise<void>;
}

interface RuntimeCommandDefinition extends ExtensionContributionDefinition {
  readonly kind: "command";
  readonly title: string;
  readonly icon?: ExtensionCommandDefinition["icon"];
  readonly when?: ExtensionContextKeyExpression;
  readonly run: ExtensionCommandDefinition["run"];
  readonly report: ExtensionApiScope["report"];
}

function cloneSubject(subject: JsonValue | undefined): JsonValue | undefined {
  if (subject === undefined) return undefined;
  const parsed = jsonValueSchema.safeParse(subject);
  if (!parsed.success) {
    throw new Error("Command subjects must be finite JSON.");
  }
  return structuredClone(parsed.data);
}

/**
 * The single command table. Host commands and extension commands live side by
 * side; menus, keybindings, and future palette/toolbar surfaces execute
 * through it rather than holding callbacks of their own.
 */
export class HostCommandRegistry {
  private readonly hostCommands = new Map<string, HostCommandDefinition>();
  private readonly extensionCommands =
    new ExtensionContributionRegistry<RuntimeCommandDefinition>("command");
  /**
   * Host commands extensions may invoke via `execute()`. Deliberately empty
   * until real use cases justify each entry: contributing a menu item the
   * user clicks is the intended path, not programmatic host control.
   */
  private readonly hostExecuteAllowlist = new Set<string>();
  private hostRevision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly contextKeys: HostContextKeyService;
  private readonly keybindings: HostKeybindingRegistry;

  constructor(
    contextKeys: HostContextKeyService = hostContextKeys,
    keybindings: HostKeybindingRegistry = hostKeybindingRegistry,
  ) {
    this.contextKeys = contextKeys;
    this.keybindings = keybindings;
    this.extensionCommands.subscribe(() => this.emitChange());
  }

  registerHostCommand(definition: HostCommandDefinition): ExtensionDisposable {
    const id = definition.id;
    if (!HOST_COMMAND_ID_PATTERN.test(id) || !id.includes(".")) {
      throw new Error(`Invalid host command ID '${id}'.`);
    }
    if (this.hostCommands.has(id) || this.extensionCommands.has(id)) {
      throw new Error(`Command '${id}' is already registered.`);
    }
    if (typeof definition.run !== "function") {
      throw new Error(`Host command '${id}' must define run().`);
    }
    if (definition.when !== undefined) {
      assertContextKeyExpression(definition.when, `Host command '${id}'`);
    }
    this.hostCommands.set(id, Object.freeze({ ...definition }));
    this.hostRevision += 1;
    this.emitChange();
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.hostCommands.delete(id);
        this.hostRevision += 1;
        this.emitChange();
      },
    });
  }

  getTitle(commandId: string): string | undefined {
    return (
      this.hostCommands.get(commandId)?.title ??
      (this.extensionCommands.get(commandId)?.definition as
        | RuntimeCommandDefinition
        | undefined)?.title
    );
  }

  has(commandId: string): boolean {
    return (
      this.hostCommands.has(commandId) || this.extensionCommands.has(commandId)
    );
  }

  isEnabled(commandId: string): boolean {
    const when =
      this.hostCommands.get(commandId)?.when ??
      (this.extensionCommands.get(commandId)?.definition as
        | RuntimeCommandDefinition
        | undefined)?.when;
    if (when === undefined) return this.has(commandId);
    return this.contextKeys.evaluate(when);
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
    if (!this.has(commandId) || !this.isEnabled(commandId)) return false;
    const host = this.hostCommands.get(commandId);
    if (host) {
      void this.runIsolated(commandId, host.run, invocation, (message, error) =>
        console.error(message, error),
      );
      return true;
    }
    const contribution = this.extensionCommands.get(commandId);
    if (!contribution) return false;
    const definition = contribution.definition;
    void this.runIsolated(commandId, definition.run, invocation, (message, error) =>
      definition.report("error", message, error),
    );
    return true;
  }

  bind(scope: ExtensionApiScope): ExtensionCommandApi {
    const bound = this.extensionCommands.bind(scope);
    return Object.freeze({
      register: (
        definition: ExtensionCommandDefinition,
      ): ExtensionUiRegistration =>
        bound.register(this.compileCommand(definition, scope.report)),
      registerKeybinding: (
        request: ExtensionKeybindingRequest,
      ): ExtensionUiRegistration => {
        if (request.apiVersion !== 1) {
          throw new Error(
            `Keybinding '${request.id}' must use keybinding API 1.`,
          );
        }
        if (
          typeof request.command !== "string" ||
          request.command.length === 0
        ) {
          throw new Error(
            `Keybinding '${request.id}' must reference a local command ID.`,
          );
        }
        const qualifiedCommand = `${scope.extension.id}/${request.command}`;
        if (!this.extensionCommands.has(qualifiedCommand)) {
          throw new Error(
            `Keybinding '${request.id}' references unregistered command ` +
              `'${request.command}'. Register the command first.`,
          );
        }
        const registration = this.keybindings.registerExtensionBinding(scope, {
          id: request.id,
          chord: request.chord,
          commandId: qualifiedCommand,
          regions: request.regions,
        });
        const owned = scope.own(registration);
        return Object.freeze({
          id: `${scope.extension.id}/${request.id}`,
          dispose: () => owned.dispose(),
        });
      },
      execute: async (
        commandId: string,
        subject?: JsonValue,
      ): Promise<void> => {
        const invocation: ExtensionCommandInvocation = Object.freeze({
          subject: cloneSubject(subject),
          source: "api",
        });
        if (this.hostCommands.has(commandId)) {
          if (!this.hostExecuteAllowlist.has(commandId)) {
            throw new Error(
              `Host command '${commandId}' is not allowlisted for extension execution.`,
            );
          }
          if (!this.isEnabled(commandId)) return;
          await this.hostCommands.get(commandId)?.run(invocation);
          return;
        }
        const ownId = `${scope.extension.id}/${commandId}`;
        const contribution = this.extensionCommands.get(ownId);
        if (!contribution) {
          throw new Error(`Command '${commandId}' is not registered.`);
        }
        if (!this.isEnabled(ownId)) return;
        await contribution.definition.run(invocation);
      },
      getContextKey: (key: string): JsonValue | undefined =>
        this.contextKeys.get(key),
    });
  }

  /** Notifies on both host and extension command changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.extensionCommands.getRevision() + this.hostRevision;
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Command observers are derived render notifications only.
      }
    }
  }

  private compileCommand(
    definition: ExtensionCommandDefinition,
    report: ExtensionApiScope["report"],
  ): RuntimeCommandDefinition {
    if (definition.apiVersion !== 1) {
      throw new Error(`Command '${definition.id}' must use command API 1.`);
    }
    if (
      typeof definition.title !== "string" ||
      definition.title.trim().length === 0 ||
      definition.title.trim().length > 80
    ) {
      throw new Error(
        `Command '${definition.id}' title must be 1-80 characters.`,
      );
    }
    if (typeof definition.run !== "function") {
      throw new Error(`Command '${definition.id}' must define run().`);
    }
    if (definition.icon !== undefined && typeof definition.icon !== "function") {
      throw new TypeError(
        `Command '${definition.id}' icon must be a component function.`,
      );
    }
    if (definition.when !== undefined) {
      assertContextKeyExpression(definition.when, `Command '${definition.id}'`);
    }
    return Object.freeze({
      id: definition.id,
      apiVersion: 1,
      kind: "command",
      title: definition.title.trim(),
      icon: definition.icon,
      when: definition.when,
      run: definition.run,
      execution: "trusted",
      report,
    });
  }

  private async runIsolated(
    commandId: string,
    run: ExtensionCommandDefinition["run"],
    invocation: ExtensionCommandInvocation,
    reportError: (message: string, error: unknown) => void,
  ): Promise<void> {
    try {
      await run(invocation);
    } catch (error) {
      reportError(`Command '${commandId}' failed.`, error);
    }
  }
}

export const hostCommandRegistry = new HostCommandRegistry();
