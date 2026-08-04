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
import { bindOwnerScopedSubscribe } from "../utils/ownerScopedSubscribe";
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
    // Resolves false rather than throwing when the command's `when` is false:
    // a disabled command is an ordinary runtime state, not an author error, so
    // it is reported as an outcome. Unknown or non-allowlisted IDs still throw
    // — those are mistakes in the extension, not states of the editor.
    execute: async (commandId: string, subject?: JsonValue): Promise<boolean> => {
      const invocation: ExtensionCommandInvocation = Object.freeze({
        subject: cloneSubject(subject),
        source: "api",
      });
      // Own commands resolve first. Local IDs may contain dots, so an
      // extension can legitimately name one `project.open-thing`; checking the
      // host table first would make its own command unreachable — and would
      // send it into the allowlist gate for a command it owns.
      const ownId = `${scope.extension.id}/${commandId}`;
      const entry = table.getEntry(ownId);
      if (entry) {
        if (!table.isEnabled(ownId)) return false;
        await entry.run(invocation);
        return true;
      }
      if (table.isHostCommand(commandId)) {
        if (!table.isHostExecuteAllowlisted(commandId)) {
          throw new Error(
            `Host command '${commandId}' is not allowlisted for extension execution.`,
          );
        }
        if (!table.isEnabled(commandId)) return false;
        await table.getEntry(commandId)?.run(invocation);
        return true;
      }
      throw new Error(`Command '${commandId}' is not registered.`);
    },
    getContextKey: (key: string): JsonValue | undefined => contextKeys.get(key),
    subscribeContextKeys: bindOwnerScopedSubscribe(
      scope,
      // The key service notifies without a revision of its own; keys are a
      // read-through view, so the token would have no independent meaning.
      { subscribe: (listener) => contextKeys.subscribe(listener), getRevision: () => 0 },
      "Context key",
    ),
  });
}
