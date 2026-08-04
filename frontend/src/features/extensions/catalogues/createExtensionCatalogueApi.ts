import type {
  ExtensionApiScope,
  ExtensionCatalogueApi,
  ExtensionCatalogueInfo,
  ExtensionCatalogueOptionContribution,
  ExtensionCatalogueOptionView,
  ExtensionDisposable,
  ExtensionUiRegistration,
} from "../types";
import {
  hostOptionCatalog,
  type HostOptionCatalog,
} from "../../../core/shell/optionCatalog";
import {
  assertContextKeyExpression,
  hostContextKeys,
  type HostContextKeyService,
} from "../../../core/shell/contextKeys";
import { combineRevisionSources } from "../../../core/shell/revisionRelay";
import { jsonValueSchema } from "../../../core/shell/jsonValue";
import { cloneAndFreezeJsonValue } from "../registry/frozenJson";
import { bindOwnerScopedSubscribe } from "../utils/ownerScopedSubscribe";

// Matches the contribution registries' local-ID grammar.
const LOCAL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/**
 * Owner-scoped `api.ui.catalogues` facade over the shell option catalogue
 * (plan §3.7, honouring the §3.10 split): the adapter owns ID qualification,
 * value detachment, and activation rollback; the shell owns declarations,
 * value-schema validation, and option storage.
 */
export function createExtensionCatalogueApi(
  scope: ExtensionApiScope,
  catalog: HostOptionCatalog = hostOptionCatalog,
  contextKeys: HostContextKeyService = hostContextKeys,
): ExtensionCatalogueApi {
  // `list()` filters by each option's `when`, so its result changes with the
  // context keys as well as with registrations. Watching the catalogue alone
  // would leave a visibility change silent — the reader would keep rendering a
  // stale option set with no signal that anything moved.
  const changes = combineRevisionSources(catalog, contextKeys);
  return Object.freeze({
    addOption: (
      option: ExtensionCatalogueOptionContribution,
    ): ExtensionUiRegistration => {
      if (option.apiVersion !== 1) {
        throw new Error(
          `Catalogue option '${option.id}' must use catalogue API 1.`,
        );
      }
      if (!LOCAL_ID_PATTERN.test(option.id)) {
        throw new Error(
          `Invalid catalogue option ID '${option.id}'. Use lowercase letters, numbers, dots, underscores, or hyphens.`,
        );
      }
      if (!catalog.has(option.catalogueId)) {
        throw new Error(
          `Catalogue option '${option.id}' targets undeclared catalogue '${option.catalogueId}'.`,
        );
      }
      const parsedValue = jsonValueSchema.safeParse(option.value);
      if (!parsedValue.success) {
        throw new Error(
          `Catalogue option '${option.id}' value must be finite JSON.`,
        );
      }
      if (option.when !== undefined) {
        assertContextKeyExpression(
          option.when,
          `Catalogue option '${option.id}'`,
        );
      }
      const qualifiedId = `${scope.extension.id}/${option.id}`;
      const registration = catalog.registerContributedOption(
        option.catalogueId,
        {
          id: qualifiedId,
          label: option.label,
          value: cloneAndFreezeJsonValue(parsedValue.data),
          order: option.order,
          when: option.when,
        },
      );
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
    list: (catalogueId: string): readonly ExtensionCatalogueOptionView[] =>
      Object.freeze(
        catalog.resolveOptions(catalogueId, contextKeys).map((option) =>
          cloneAndFreezeJsonValue({
            id: option.id,
            label: option.label,
            value: option.value,
            order: option.order,
          }),
        ),
      ),
    listCatalogues: (): readonly ExtensionCatalogueInfo[] =>
      Object.freeze(
        catalog.describeAll().map((description) =>
          cloneAndFreezeJsonValue({
            id: description.id,
            valueSchema: description.valueSchema,
          }),
        ),
      ),
    subscribe: bindOwnerScopedSubscribe(scope, changes, "Catalogue"),
    getRevision: () => changes.getRevision(),
  });
}
