import { describe, expect, it } from "vitest";
import { HostMenuCatalog } from "../hostMenuCatalog";

describe("HostMenuCatalog", () => {
  it("declares menus, validates subjects, and disposes cleanly", () => {
    const catalog = new HostMenuCatalog();
    const registration = catalog.declare({
      id: "timeline.track.context",
      validateSubject: (subject) =>
        typeof subject === "object" &&
        subject !== null &&
        "trackId" in subject,
    });

    expect(catalog.has("timeline.track.context")).toBe(true);
    expect(catalog.list()).toEqual(["timeline.track.context"]);
    expect(
      catalog.validateSubject("timeline.track.context", { trackId: "t1" }),
    ).toBe(true);
    expect(catalog.validateSubject("timeline.track.context", {})).toBe(false);

    registration.dispose();
    expect(catalog.has("timeline.track.context")).toBe(false);
  });

  it("fails closed for unknown menus and throwing validators", () => {
    const catalog = new HostMenuCatalog();
    catalog.declare({
      id: "a.b",
      validateSubject: () => {
        throw new Error("boom");
      },
    });
    expect(catalog.validateSubject("missing.menu", {})).toBe(false);
    expect(catalog.validateSubject("a.b", {})).toBe(false);
  });

  it("rejects invalid IDs, duplicates, and missing validators", () => {
    const catalog = new HostMenuCatalog();
    expect(() =>
      catalog.declare({ id: "Bad Menu", validateSubject: () => true }),
    ).toThrow(/Invalid host menu ID/);
    catalog.declare({ id: "a.b", validateSubject: () => true });
    expect(() =>
      catalog.declare({ id: "a.b", validateSubject: () => true }),
    ).toThrow(/already declared/);
    expect(() =>
      catalog.declare({
        id: "c.d",
        validateSubject: undefined as unknown as () => boolean,
      }),
    ).toThrow(/validateSubject/);
  });
});
