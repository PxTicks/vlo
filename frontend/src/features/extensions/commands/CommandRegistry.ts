import type {
  ExtensionApiScope,
  ExtensionCommandApi,
  ExtensionCommandDefinition,
  ExtensionCommandInvocation,
  ExtensionDisposable,
  ExtensionKeybindingRequest,
  ExtensionUiRegistration,
  JsonValue,
} from "../types";
import { jsonValueSchema } from "../../../core/shell/jsonValue";
import {
  hostCommandTable,
  type CommandTableEntry,
  type HostCommandTable,
} from "../../../core/shell/commandTable";
import {
  assertContextKeyExpression,
  hostContextKeys,
  type HostContextKeyService,
} from "../../../core/shell/contextKeys";
import {
  hostKeybindingRegistry,
  type HostKeybindingRegistry,
} from "../../../core/shell/keybindingRegistry";

// Matches the contribution registries' local-ID grammar.
const LOCAL_COMMAND_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/**
 * The command table itself is shell infrastructure (plan §3.10); this module
 * is the extensions-side adapter. The singleton re-export keeps existing
 * host imports stable.
 */
export { hostCommandTable as hostCommandRegistry };
export type { HostCommandDefinition } from "../../../core/shell/commandTable";
export type { HostCommandTable } from "../../../core/shell/commandTable";

function cloneSubject(subject: JsonValue | undefined): JsonValue | undefined {
  if (subject === undefined) return undefined;
  const parsed = jsonValueSchema.safeParse(subject);
  if (!parsed.success) {
    throw new Error("Command subjects must be finite JSON.");
  }
  return structuredClone(parsed.data);
}

function compileEntry(
  scope: ExtensionApiScope,
  definition: ExtensionCommandDefinition,
): CommandTableEntry {
  if (definition.apiVersion !== 1) {
    throw new Error(`Command '${definition.id}' must use command API 1.`);
  }
  if (!LOCAL_COMMAND_ID_PATTERN.test(definition.id)) {
    throw new Error(
      `Invalid command ID '${definition.id}'. Use lowercase letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  if (
    typeof definition.title !== "string" ||
    definition.title.trim().length === 0 ||
    definition.title.trim().length > 80
  ) {
    throw new Error(`Command '${definition.id}' title must be 1-80 characters.`);
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
  return {
    id: `${scope.extension.id}/${definition.id}`,
    title: definition.title.trim(),
    icon: definition.icon,
    when: definition.when,
    run: definition.run,
    source: "extension",
    reportError: (message, error) => scope.report("error", message, error),
  };
}

/**
 * Owner-scoped `api.ui.commands` facade over the shell command table:
 * owner-qualified IDs, activation rollback via `scope.own`, failures reported
 * to the owning scope, and the host-execute allowlist gate.
 */
export function createExtensionCommandApi(
  scope: ExtensionApiScope,
  table: HostCommandTable = hostCommandTable,
  keybindings: HostKeybindingRegistry = hostKeybindingRegistry,
  contextKeys: HostContextKeyService = hostContextKeys,
): ExtensionCommandApi {
  return Object.freeze({
    register: (
      definition: ExtensionCommandDefinition,
    ): ExtensionUiRegistration => {
      const entry = compileEntry(scope, definition);
      const registration = scope.own(
        table.registerEntry(entry) as ExtensionDisposable,
      );
      return Object.freeze({
        id: entry.id,
        dispose: () => void registration.dispose(),
      });
    },
    registerKeybinding: (
      request: ExtensionKeybindingRequest,
    ): ExtensionUiRegistration => {
      if (request.apiVersion !== 1) {
        throw new Error(`Keybinding '${request.id}' must use keybinding API 1.`);
      }
      if (!LOCAL_COMMAND_ID_PATTERN.test(request.id)) {
        throw new Error(
          `Invalid keybinding ID '${request.id}'. Use lowercase letters, numbers, dots, underscores, or hyphens.`,
        );
      }
      if (typeof request.command !== "string" || request.command.length === 0) {
        throw new Error(
          `Keybinding '${request.id}' must reference a local command ID.`,
        );
      }
      const qualifiedCommand = `${scope.extension.id}/${request.command}`;
      if (!table.has(qualifiedCommand)) {
        throw new Error(
          `Keybinding '${request.id}' references unregistered command ` +
            `'${request.command}'. Register the command first.`,
        );
      }
      // Owner policy lives here, not in the shell registry (§3.10 review
      // finding 3): qualification, scope ownership, diagnostic routing.
      const qualifiedId = `${scope.extension.id}/${request.id}`;
      const registration = keybindings.registerContributedBinding({
        id: qualifiedId,
        chord: request.chord,
        commandId: qualifiedCommand,
        regions: request.regions,
        onDiagnostic: (message) => scope.report("warning", message),
      });
      const owned = scope.own(registration as ExtensionDisposable);
      return Object.freeze({
        id: qualifiedId,
        dispose: () => void owned.dispose(),
      });
    },
    execute: async (commandId: string, subject?: JsonValue): Promise<void> => {
      const invocation: ExtensionCommandInvocation = Object.freeze({
        subject: cloneSubject(subject),
        source: "api",
      });
      if (table.isHostCommand(commandId)) {
        if (!table.isHostExecuteAllowlisted(commandId)) {
          throw new Error(
            `Host command '${commandId}' is not allowlisted for extension execution.`,
          );
        }
        if (!table.isEnabled(commandId)) return;
        await table.getEntry(commandId)?.run(invocation);
        return;
      }
      const ownId = `${scope.extension.id}/${commandId}`;
      const entry = table.getEntry(ownId);
      if (!entry) {
        throw new Error(`Command '${commandId}' is not registered.`);
      }
      if (!table.isEnabled(ownId)) return;
      await entry.run(invocation);
    },
    getContextKey: (key: string): JsonValue | undefined => contextKeys.get(key),
  });
}
