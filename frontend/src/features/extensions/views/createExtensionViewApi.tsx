import type { ComponentType } from "react";
import type {
  ExtensionApiScope,
  ExtensionDisposable,
  ExtensionTrustedUiViewDefinition,
  ExtensionUiRegistration,
  ExtensionUiViewComponentProps,
} from "../types";
import {
  hostViewRegistry,
  type HostViewRegistry,
  type ShellViewComponentProps,
} from "../../../core/shell/viewRegistry";
import { assertContextKeyExpression } from "../../../core/shell/contextKeys";
import { ExtensionTrustedReactMount } from "../ui/ExtensionTrustedReactMount";

const LOCAL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export interface ExtensionViewApi {
  registerView(definition: ExtensionTrustedUiViewDefinition): ExtensionUiRegistration;
  openView(id: string): boolean;
}

/** Owner-scoped trusted-view adapter over the feature-free shell registry. */
export function createExtensionViewApi(
  scope: ExtensionApiScope,
  registry: HostViewRegistry = hostViewRegistry,
): ExtensionViewApi {
  return Object.freeze({
    registerView: (
      definition: ExtensionTrustedUiViewDefinition,
    ): ExtensionUiRegistration => {
      if (definition.apiVersion !== 1 || definition.kind !== "trusted-view") {
        throw new Error(`UI view '${definition.id}' must use trusted-view API 1.`);
      }
      if (!LOCAL_ID_PATTERN.test(definition.id)) {
        throw new Error(
          `Invalid UI view ID '${definition.id}'. Use lowercase letters, numbers, dots, underscores, or hyphens.`,
        );
      }
      if (typeof definition.component !== "function") {
        throw new Error(`UI view '${definition.id}' must provide a component.`);
      }
      if (definition.icon !== undefined && typeof definition.icon !== "function") {
        throw new Error(`UI view '${definition.id}' icon must be a component.`);
      }
      if (definition.when !== undefined) {
        assertContextKeyExpression(definition.when, `UI view '${definition.id}'`);
      }
      const qualifiedId = `${scope.extension.id}/${definition.id}`;
      const TrustedComponent = definition.component as ComponentType<
        ExtensionUiViewComponentProps
      >;
      const TrustedIcon = definition.icon as ComponentType<object> | undefined;
      function ExtensionViewMount(props: ShellViewComponentProps) {
        return (
          <ExtensionTrustedReactMount
            contributionId={qualifiedId}
            surface="Extension view"
            report={scope.report}
            component={TrustedComponent}
            componentProps={{
              viewId: qualifiedId,
              region: props.region,
              active: props.active,
            }}
          />
        );
      }
      function ExtensionViewIcon() {
        if (!TrustedIcon) return null;
        return (
          <ExtensionTrustedReactMount
            contributionId={qualifiedId}
            surface="Extension view icon"
            report={scope.report}
            component={TrustedIcon}
            componentProps={{}}
            fallback={null}
          />
        );
      }
      const registration = registry.registerEntry({
        id: qualifiedId,
        title: definition.title,
        icon: TrustedIcon ? ExtensionViewIcon : undefined,
        defaultRegion: definition.defaultRegion,
        // Built-in regions keep their primary tabs first unless the author
        // deliberately requests another position or the user reorders them.
        order: definition.order ?? 1_000,
        when: definition.when,
        keepMounted: true,
        component: ExtensionViewMount,
        source: "extension",
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
    openView: (localId: string): boolean => {
      if (scope.signal.aborted) return false;
      if (!LOCAL_ID_PATTERN.test(localId)) {
        throw new Error(`Invalid UI view ID '${localId}'.`);
      }
      const qualifiedId = `${scope.extension.id}/${localId}`;
      const entry = registry.get(qualifiedId);
      if (!entry || entry.source !== "extension") {
        throw new Error(`UI view '${qualifiedId}' is not registered.`);
      }
      // Extension views are not portable in this release, so the registration
      // region is still the region; for dock regions the registry forwards to
      // the layout kernel, which owns selection.
      return registry.select(entry.defaultRegion, qualifiedId);
    },
  });
}
