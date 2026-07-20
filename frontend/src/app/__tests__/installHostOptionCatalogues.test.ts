import { describe, expect, it } from "vitest";
import { hostOptionCatalog } from "../../core/shell/optionCatalog";
import { installHostOptionCatalogues } from "../installHostOptionCatalogues";

describe("installHostOptionCatalogues", () => {
  it("declares every Phase D catalogue before extension activation", () => {
    installHostOptionCatalogues();
    expect(
      hostOptionCatalog.describeAll().map((catalogue) => catalogue.id),
    ).toEqual([
      "animation.scalar-sources",
      "animation.interpolations",
      "export.formats",
      "library.sort-modes",
    ]);
  });
});

