import type {
  ExtensionApiScope,
  ExtensionCanvasToolApi,
  ExtensionCanvasToolDefinition,
  ExtensionCanvasToolRegistration,
  ExtensionDisposable,
} from "../types";
import {
  hostCommandTable,
  type HostCommandTable,
} from "../../../core/shell/commandTable";
import {
  assertContextKeyExpression,
  hostContextKeys,
  type HostContextKeyService,
} from "../../../core/shell/contextKeys";
import {
  CanvasToolHost,
  canvasToolHost,
  type CanvasToolHostBinding,
} from "../../../core/shell/canvasToolHost";
import { ExtensionContributionRegistry } from "../registry/ExtensionContributionRegistry";

const LABEL_MAX_LENGTH = 80;

function validateDefinition(definition: ExtensionCanvasToolDefinition): void {
  if (definition.apiVersion !== 1) {
    throw new Error(`Canvas tool '${definition.id}' must use canvas-tool API 1.`);
  }
  if (
    typeof definition.label !== "string" ||
    definition.label.trim().length === 0 ||
    definition.label.trim().length > LABEL_MAX_LENGTH
  ) {
    throw new Error(
      `Canvas tool '${definition.id}' label must contain 1-${LABEL_MAX_LENGTH} characters.`,
    );
  }
  if (definition.icon !== undefined && typeof definition.icon !== "function") {
    throw new TypeError(
      `Canvas tool '${definition.id}' icon must be a component function.`,
    );
  }
  if (
    definition.cursor !== undefined &&
    (typeof definition.cursor !== "string" ||
      definition.cursor.trim().length === 0)
  ) {
    throw new TypeError(
      `Canvas tool '${definition.id}' cursor must be a non-empty string.`,
    );
  }
  if (
    typeof definition.activate !== "function" ||
    typeof definition.deactivate !== "function" ||
    typeof definition.onPointer !== "function"
  ) {
    throw new TypeError(
      `Canvas tool '${definition.id}' must define activate(), deactivate(), and onPointer().`,
    );
  }
  if (definition.when !== undefined) {
    assertContextKeyExpression(
      definition.when,
      `Canvas tool '${definition.id}'`,
    );
  }
}

export class ExtensionCanvasToolRegistry {
  private readonly contributions =
    new ExtensionContributionRegistry<ExtensionCanvasToolDefinition>(
      "canvas-tool",
    );
  private readonly host: CanvasToolHost;

  constructor(
    contextKeys: HostContextKeyService = hostContextKeys,
    host?: CanvasToolHost,
  ) {
    this.host = host ?? new CanvasToolHost(contextKeys);
  }

  bind(
    scope: ExtensionApiScope,
    commands: HostCommandTable = hostCommandTable,
  ): ExtensionCanvasToolApi {
    const bound = this.contributions.bind(scope);
    return Object.freeze({
      register: (
        definition: ExtensionCanvasToolDefinition,
      ): ExtensionCanvasToolRegistration => {
        validateDefinition(definition);
        const contribution = bound.register(
          Object.freeze({
            ...definition,
            label: definition.label.trim(),
            cursor: definition.cursor?.trim(),
          }),
        );
        const command = `canvas-tool.${definition.id}`;
        const commandId = `${scope.extension.id}/${command}`;
        let projected: ExtensionDisposable;
        try {
          projected = scope.own(
            this.host.register({
              ...contribution.contribution,
              commandId,
              reportError: (message, error) =>
                scope.report("error", message, error),
            }) as ExtensionDisposable,
          );
        } catch (error) {
          contribution.dispose();
          throw error;
        }
        let commandRegistration: ExtensionDisposable;
        try {
          commandRegistration = scope.own(
            commands.registerEntry({
              id: commandId,
              title: contribution.contribution.definition.label,
              icon: contribution.contribution.definition.icon,
              when: contribution.contribution.definition.when,
              source: "extension",
              run: () => {
                this.host.activate(contribution.id);
              },
              reportError: (message, error) =>
                scope.report("error", message, error),
            }) as ExtensionDisposable,
          );
        } catch (error) {
          projected.dispose();
          contribution.dispose();
          throw error;
        }

        let disposed = false;
        return Object.freeze({
          id: contribution.id,
          command,
          dispose: () => {
            if (disposed) return;
            disposed = true;
            commandRegistration.dispose();
            projected.dispose();
            contribution.dispose();
          },
        });
      },
    });
  }

  listAvailable() {
    return this.host.listAvailable();
  }

  getActiveId(): string | null {
    return this.host.getActiveId();
  }

  activate(id: string): boolean {
    return this.host.activate(id);
  }

  deactivate(): void {
    this.host.deactivate();
  }

  dispatchPointer(event: Parameters<CanvasToolHost["dispatchPointer"]>[0]) {
    return this.host.dispatchPointer(event);
  }

  attachHost(binding: CanvasToolHostBinding): ExtensionDisposable {
    return this.host.attachHost(binding);
  }
}

export const extensionCanvasToolRegistry = new ExtensionCanvasToolRegistry(
  hostContextKeys,
  canvasToolHost,
);

export function createExtensionCanvasToolApi(
  scope: ExtensionApiScope,
): ExtensionCanvasToolApi {
  return extensionCanvasToolRegistry.bind(scope);
}
