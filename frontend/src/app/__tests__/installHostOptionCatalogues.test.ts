import { describe, expect, it } from "vitest";
import { hostOptionCatalog } from "../../core/shell/optionCatalog";
import { installHostOptionCatalogues } from "../installHostOptionCatalogues";

describe("installHostOptionCatalogues", () => {
  it("declares every host catalogue before extension activation", () => {
    installHostOptionCatalogues();
    expect(
      hostOptionCatalog.describeAll().map((catalogue) => catalogue.id),
    ).toEqual([
      "animation.scalar-sources",
      "animation.interpolations",
      "canvas.brush-presets",
      "export.formats",
      "library.sort-modes",
    ]);
  });
});
