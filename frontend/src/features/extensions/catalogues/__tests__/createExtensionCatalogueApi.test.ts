import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { HostOptionCatalog } from "../../../../core/shell/optionCatalog";
import { createExtensionCatalogueApi } from "../createExtensionCatalogueApi";

function createScope(
  extensionId: string,
  resources: ExtensionResource[] = [],
): ExtensionApiScope {
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => {
      resources.push(resource);
      return resource;
    },
    report: vi.fn(),
  };
}

function createHarness(extensionId = "example.catalogue") {
  const catalog = new HostOptionCatalog();
  catalog.declare({
    id: "library.sort-modes",
    validateValue: (value) =>
      typeof value === "object" && value !== null && "field" in value,
    valueSchema: { field: "string" },
  });
  const resources: ExtensionResource[] = [];
  const api = createExtensionCatalogueApi(
    createScope(extensionId, resources),
    catalog,
  );
  return { api, catalog, resources };
}

describe("createExtensionCatalogueApi", () => {
  it("qualifies, detaches, and owns contributed options", async () => {
    const { api, catalog, resources } = createHarness();
    const mutableValue = { field: "name" };
    const registration = api.addOption({
      id: "by-name",
      apiVersion: 1,
      catalogueId: "library.sort-modes",
      label: "By Name",
      value: mutableValue,
    });
    expect(registration.id).toBe("example.catalogue/by-name");

    // Later extension-side mutation must not reach the registered option.
    mutableValue.field = "changed";
    expect(
      catalog.getOption("library.sort-modes", "example.catalogue/by-name")
        ?.value,
    ).toEqual({ field: "name" });

    for (const resource of resources) {
      if (typeof resource === "function") await resource();
      else await resource.dispose();
    }
    expect(
      catalog.getOption("library.sort-modes", "example.catalogue/by-name"),
    ).toBeUndefined();
  });

  it("rejects unknown catalogues, bad IDs, schema violations, and bad conditions", () => {
    const { api } = createHarness();
    expect(() =>
      api.addOption({
        id: "x",
        apiVersion: 1,
        catalogueId: "missing.catalogue",
        label: "X",
        value: { field: "name" },
      }),
    ).toThrow(/undeclared catalogue/);
    expect(() =>
      api.addOption({
        id: "Bad ID",
        apiVersion: 1,
        catalogueId: "library.sort-modes",
        label: "X",
        value: { field: "name" },
      }),
    ).toThrow(/Invalid catalogue option ID/);
    expect(() =>
      api.addOption({
        id: "bad-value",
        apiVersion: 1,
        catalogueId: "library.sort-modes",
        label: "X",
        value: { wrong: true },
      }),
    ).toThrow(/fails the 'library.sort-modes' schema/);
    expect(() =>
      api.addOption({
        id: "bad-when",
        apiVersion: 1,
        catalogueId: "library.sort-modes",
        label: "X",
        value: { field: "name" },
        when: { key: "Bad Key" },
      }),
    ).toThrow(/context key/);
  });

  it("lists options and catalogues as frozen, detached views", () => {
    const { api, catalog } = createHarness();
    catalog.registerHostOption("library.sort-modes", {
      id: "name-asc",
      label: "Name",
      value: { field: "name" },
    });
    api.addOption({
      id: "by-tag",
      apiVersion: 1,
      catalogueId: "library.sort-modes",
      label: "By Tag",
      value: { field: "createdAt" },
      order: 5,
    });

    const options = api.list("library.sort-modes");
    expect(options.map((option) => option.id)).toEqual([
      "name-asc",
      "example.catalogue/by-tag",
    ]);
    expect(Object.isFrozen(options[0])).toBe(true);
    expect(Object.isFrozen(options[0].value)).toBe(true);

    const catalogues = api.listCatalogues();
    expect(catalogues).toEqual([
      { id: "library.sort-modes", valueSchema: { field: "string" } },
    ]);
    expect(Object.isFrozen(catalogues[0])).toBe(true);
  });

  it("rolls back a catalogue entry when activation ownership rejects it", () => {
    const catalog = new HostOptionCatalog();
    catalog.declare({
      id: "library.sort-modes",
      validateValue: (value) =>
        typeof value === "object" && value !== null && "field" in value,
      valueSchema: { field: "string" },
    });
    const scope = createScope("example.catalogue");
    scope.own = () => {
      throw new Error("registration closed");
    };
    const api = createExtensionCatalogueApi(scope, catalog);

    expect(() =>
      api.addOption({
        id: "by-name",
        apiVersion: 1,
        catalogueId: "library.sort-modes",
        label: "By name",
        value: { field: "name" },
      }),
    ).toThrow(/registration closed/);
    expect(catalog.listOptions("library.sort-modes")).toEqual([]);
  });
});
