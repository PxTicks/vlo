import { describe, expect, it } from "vitest";
import { HostContextKeyService } from "../contextKeys";
import { HostOptionCatalog } from "../optionCatalog";

function declareSortModes(catalog: HostOptionCatalog) {
  return catalog.declare({
    id: "library.sort-modes",
    validateValue: (value) =>
      typeof value === "object" &&
      value !== null &&
      "field" in value &&
      typeof (value as { field: unknown }).field === "string",
    valueSchema: { field: "string", direction: "'asc' | 'desc'" },
  });
}

describe("HostOptionCatalog", () => {
  it("declares catalogues, validates values, and disposes cleanly", () => {
    const catalog = new HostOptionCatalog();
    const declaration = declareSortModes(catalog);
    expect(catalog.has("library.sort-modes")).toBe(true);
    expect(catalog.describeAll()).toEqual([
      {
        id: "library.sort-modes",
        valueSchema: { field: "string", direction: "'asc' | 'desc'" },
      },
    ]);

    catalog.registerHostOption("library.sort-modes", {
      id: "date-desc",
      label: "Newest First",
      value: { field: "createdAt", direction: "desc" },
    });
    expect(() =>
      catalog.registerHostOption("library.sort-modes", {
        id: "bad",
        label: "Bad",
        value: { direction: "desc" },
      }),
    ).toThrow(/fails the 'library.sort-modes' schema/);
    expect(() =>
      catalog.registerHostOption("missing.catalogue", {
        id: "x",
        label: "X",
        value: { field: "name" },
      }),
    ).toThrow(/undeclared catalogue/);

    declaration.dispose();
    expect(catalog.has("library.sort-modes")).toBe(false);
    expect(catalog.listOptions("library.sort-modes")).toEqual([]);
  });

  it("orders options by order, host-before-contributed, then ID", () => {
    const catalog = new HostOptionCatalog();
    declareSortModes(catalog);
    catalog.registerContributedOption("library.sort-modes", {
      id: "example.tags/by-tag",
      label: "By Tag",
      value: { field: "name" },
      order: 0,
    });
    catalog.registerHostOption("library.sort-modes", {
      id: "name-asc",
      label: "Name (A-Z)",
      value: { field: "name" },
      order: 0,
    });
    catalog.registerHostOption("library.sort-modes", {
      id: "date-desc",
      label: "Newest First",
      value: { field: "createdAt" },
      order: -1,
    });

    expect(
      catalog.listOptions("library.sort-modes").map((option) => option.id),
    ).toEqual(["date-desc", "name-asc", "example.tags/by-tag"]);
  });

  it("requires owner-qualified IDs for contributed options and rejects duplicates", () => {
    const catalog = new HostOptionCatalog();
    declareSortModes(catalog);
    expect(() =>
      catalog.registerContributedOption("library.sort-modes", {
        id: "unqualified",
        label: "X",
        value: { field: "name" },
      }),
    ).toThrow(/owner-qualified/);

    expect(() =>
      catalog.registerContributedOption("library.sort-modes", {
        id: "example_tags/by_tag",
        label: "By tag",
        value: { field: "name" },
      }),
    ).not.toThrow();

    catalog.registerHostOption("library.sort-modes", {
      id: "name-asc",
      label: "Name",
      value: { field: "name" },
    });
    expect(() =>
      catalog.registerHostOption("library.sort-modes", {
        id: "name-asc",
        label: "Name again",
        value: { field: "name" },
      }),
    ).toThrow(/already registered/);
  });

  it("resolves `when` conditions against context keys, failing closed", () => {
    const catalog = new HostOptionCatalog();
    const contextKeys = new HostContextKeyService();
    declareSortModes(catalog);
    catalog.registerHostOption("library.sort-modes", {
      id: "always",
      label: "Always",
      value: { field: "name" },
    });
    catalog.registerHostOption("library.sort-modes", {
      id: "gated",
      label: "Gated",
      value: { field: "createdAt" },
      when: { key: "project.open" },
    });

    expect(
      catalog
        .resolveOptions("library.sort-modes", contextKeys)
        .map((option) => option.id),
    ).toEqual(["always"]);
    contextKeys.set("project.open", true);
    expect(
      catalog
        .resolveOptions("library.sort-modes", contextKeys)
        .map((option) => option.id),
    ).toEqual(["always", "gated"]);
  });

  it("looks up single options for value consumers", () => {
    const catalog = new HostOptionCatalog();
    declareSortModes(catalog);
    catalog.registerHostOption("library.sort-modes", {
      id: "name-asc",
      label: "Name",
      value: { field: "name", direction: "asc" },
    });
    expect(catalog.getOption("library.sort-modes", "name-asc")?.value).toEqual({
      field: "name",
      direction: "asc",
    });
    expect(catalog.getOption("library.sort-modes", "missing")).toBeUndefined();
  });

  it("detaches and freezes schemas, values, conditions, and result arrays", () => {
    const catalog = new HostOptionCatalog();
    const schema = { field: "string" };
    catalog.declare({
      id: "library.sort-modes",
      validateValue: (value) => typeof value === "object" && value !== null,
      valueSchema: schema,
    });
    const value = { field: "name" };
    const when = { key: "project.open" } as const;
    catalog.registerHostOption("library.sort-modes", {
      id: "name-asc",
      label: "Name",
      value,
      when,
    });

    schema.field = "changed";
    value.field = "changed";
    expect(catalog.describeAll()[0].valueSchema).toEqual({ field: "string" });
    expect(catalog.listOptions("library.sort-modes")[0].value).toEqual({
      field: "name",
    });
    expect(Object.isFrozen(catalog.describeAll())).toBe(true);
    expect(Object.isFrozen(catalog.describeAll()[0].valueSchema)).toBe(true);
    expect(Object.isFrozen(catalog.listOptions("library.sort-modes"))).toBe(
      true,
    );
    expect(Object.isFrozen(catalog.listOptions("library.sort-modes")[0].value)).toBe(
      true,
    );
    expect(Object.isFrozen(catalog.listOptions("library.sort-modes")[0].when)).toBe(
      true,
    );
  });

  it("rejects invalid option IDs, non-finite values, and invalid conditions", () => {
    const catalog = new HostOptionCatalog();
    catalog.declare({
      id: "library.sort-modes",
      validateValue: () => true,
      valueSchema: {},
    });
    expect(() =>
      catalog.registerHostOption("library.sort-modes", {
        id: "Bad option",
        label: "Bad",
        value: {},
      }),
    ).toThrow(/Invalid catalogue option ID/);
    expect(() =>
      catalog.registerHostOption("library.sort-modes", {
        id: "non-finite",
        label: "Bad",
        value: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/finite JSON/);
    expect(() =>
      catalog.registerHostOption("library.sort-modes", {
        id: "bad-condition",
        label: "Bad",
        value: {},
        when: { key: "Bad Key" },
      }),
    ).toThrow(/context key/);
  });
});
