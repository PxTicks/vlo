import type {
  ExtensionApiScope,
  ExtensionDisposable,
  ExtensionScopeApi,
  ExtensionScopeDefinition,
  ExtensionScopeRegistration,
} from "../types";
import {
  hostScopeRegistry,
  type HostScopeRegistry,
  type ScopeRenderTarget,
} from "../../scopes";

const LOCAL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/**
 * Owner-scoped `api.ui.scopes` facade over the host scope registry. The
 * registry validates the surface and owns presentation; the adapter qualifies
 * the ID, enrolls the registration for activation rollback, and isolates the
 * per-sample `render` callback.
 */
export function createExtensionScopeApi(
  scope: ExtensionApiScope,
  registry: HostScopeRegistry = hostScopeRegistry,
): ExtensionScopeApi {
  return Object.freeze({
    register: (
      definition: ExtensionScopeDefinition,
    ): ExtensionScopeRegistration => {
      if (definition.apiVersion !== 1 || definition.kind !== "trusted-scope") {
        throw new Error(`Scope '${definition.id}' must use trusted-scope API 1.`);
      }
      if (!LOCAL_ID_PATTERN.test(definition.id)) {
        throw new Error(
          `Invalid scope ID '${definition.id}'. Use lowercase letters, numbers, dots, underscores, or hyphens.`,
        );
      }
      if (typeof definition.render !== "function") {
        throw new Error(`Scope '${definition.id}' must provide render().`);
      }
      const qualifiedId = `${scope.extension.id}/${definition.id}`;
      const render = definition.render.bind(definition);
      // The sampler calls this several times a second, so a scope that throws
      // every frame would otherwise flood the diagnostics buffer it shares with
      // activation. Report the first failure, then stay quiet until it draws.
      let reportedFailure = false;
      const registration = registry.registerEntry({
        id: qualifiedId,
        label: definition.label,
        width: definition.width,
        height: definition.height,
        order: definition.order ?? 1_000,
        source: "extension",
        render: (target: ScopeRenderTarget) => {
          try {
            render(target);
            reportedFailure = false;
          } catch (error) {
            if (!reportedFailure) {
              reportedFailure = true;
              scope.report("error", `Scope '${qualifiedId}' failed to render.`, error);
            }
          }
        },
      });
      let owned: ExtensionDisposable;
      try {
        owned = scope.own(registration as ExtensionDisposable);
      } catch (error) {
        registration.dispose();
        throw error;
      }
      return Object.freeze({
        id: qualifiedId,
        dispose: () => void owned.dispose(),
      });
    },
  });
}
