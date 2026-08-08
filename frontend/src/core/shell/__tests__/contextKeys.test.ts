import { describe, expect, it, vi } from "vitest";
import {
  HostContextKeyService,
  assertContextKeyExpression,
  evaluateContextKeyExpression,
  qualifyContributedKey,
} from "../contextKeys";

describe("assertContextKeyExpression", () => {
  it("accepts key, equals, not, and, and or clauses", () => {
    expect(() =>
      assertContextKeyExpression(
        {
          and: [
            { key: "project.open" },
            { key: "focus.region", equals: "timeline" },
            { not: { key: "playback.playing" } },
            { or: [{ key: "a" }, { key: "b" }] },
          ],
        },
        "Test",
      ),
    ).not.toThrow();
  });

  it.each([
    [null],
    ["project.open"],
    [{}],
    [{ key: "Bad Key" }],
    [{ and: [] }],
    [{ or: "nope" }],
    [{ key: "a", equals: Number.NaN }],
    // Exactly one operator per clause; equals only beside key.
    [{ key: "a", not: { key: "b" } }],
    [{ and: [{ key: "a" }], or: [{ key: "b" }] }],
    [{ not: { key: "a" }, equals: 1 }],
  ])("rejects malformed expressions: %j", (expression) => {
    expect(() => assertContextKeyExpression(expression, "Test")).toThrow();
  });

  it("rejects expressions nested beyond the depth bound", () => {
    let expression: object = { key: "a" };
    for (let index = 0; index < 10; index += 1) {
      expression = { not: expression };
    }
    expect(() => assertContextKeyExpression(expression, "Test")).toThrow(
      /deeply/,
    );
  });
});

describe("evaluateContextKeyExpression", () => {
  const get = (key: string) =>
    ({
      truthy: true,
      falsy: false,
      count: 2,
      region: "timeline",
    })[key as "truthy"];

  it("tests truthiness, equality, and boolean composition", () => {
    expect(evaluateContextKeyExpression({ key: "truthy" }, get)).toBe(true);
    expect(evaluateContextKeyExpression({ key: "falsy" }, get)).toBe(false);
    expect(evaluateContextKeyExpression({ key: "missing" }, get)).toBe(false);
    expect(
      evaluateContextKeyExpression({ key: "region", equals: "timeline" }, get),
    ).toBe(true);
    expect(
      evaluateContextKeyExpression({ key: "count", equals: 3 }, get),
    ).toBe(false);
    expect(
      evaluateContextKeyExpression(
        { and: [{ key: "truthy" }, { not: { key: "falsy" } }] },
        get,
      ),
    ).toBe(true);
    expect(
      evaluateContextKeyExpression(
        { or: [{ key: "falsy" }, { key: "missing" }] },
        get,
      ),
    ).toBe(false);
  });
});

describe("HostContextKeyService", () => {
  it("publishes values with change notification and detached reads", () => {
    const service = new HostContextKeyService();
    const listener = vi.fn();
    service.subscribe(listener);

    service.set("selection.clipCount", 2);
    expect(service.get("selection.clipCount")).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);

    // Unchanged primitive writes are no-ops.
    service.set("selection.clipCount", 2);
    expect(listener).toHaveBeenCalledTimes(1);

    service.set("selection.clipCount", undefined);
    expect(service.get("selection.clipCount")).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("evaluates expressions against live values", () => {
    const service = new HostContextKeyService();
    service.set("project.open", true);
    expect(service.evaluate({ key: "project.open" })).toBe(true);
    service.set("project.open", false);
    expect(service.evaluate({ key: "project.open" })).toBe(false);
  });

  it("rejects invalid keys and non-JSON values", () => {
    const service = new HostContextKeyService();
    expect(() => service.set("Bad Key", 1)).toThrow(/Invalid host context key/);
    expect(() => service.set("bad.value", Number.NaN)).toThrow(/finite JSON/);
  });
});

describe("contributed context keys", () => {
  it("namespaces a contributor's writes and keeps them readable by anyone", () => {
    const service = new HostContextKeyService();
    const listener = vi.fn();
    service.subscribe(listener);

    const qualified = service.setContributed("example.a", "scanned", 3);
    expect(qualified).toBe("extension.example.a.scanned");
    expect(service.get(qualified)).toBe(3);
    expect(service.evaluate({ key: qualified, equals: 3 })).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the reserved prefix out of reach of host publishers", () => {
    const service = new HostContextKeyService();
    expect(() => service.set("extension.example.a.scanned", 1)).toThrow(
      /reserved contributed prefix/,
    );
  });

  it("refuses a contributed key that repeats the prefix or is malformed", () => {
    const service = new HostContextKeyService();
    expect(() => service.setContributed("example.a", "extension.x", 1)).toThrow(
      /reserved prefix/,
    );
    expect(() => service.setContributed("example.a", "bad key", 1)).toThrow(
      /Invalid/,
    );
    expect(() => service.setContributed("", "scanned", 1)).toThrow(/namespace/);
    expect(() => qualifyContributedKey("example.a", "x".repeat(65))).toThrow(
      /Invalid contributed context key/,
    );
  });

  it("accepts an owner ID containing an underscore", () => {
    const service = new HostContextKeyService();
    expect(service.setContributed("example.a_b", "ready", true)).toBe(
      "extension.example.a_b.ready",
    );
    expect(service.get("extension.example.a_b.ready")).toBe(true);
  });

  it("clears one namespace without touching its neighbours", () => {
    const service = new HostContextKeyService();
    service.set("project.open", true);
    service.setContributed("example.a", "one", 1);
    service.setContributed("example.a", "two", 2);
    // A namespace prefix match must not catch a sibling whose ID starts the
    // same way, which is why the boundary dot is part of the prefix.
    service.setContributed("example.ab", "kept", true);

    service.clearNamespace("example.a");
    expect(service.get("extension.example.a.one")).toBeUndefined();
    expect(service.get("extension.example.a.two")).toBeUndefined();
    expect(service.get("extension.example.ab.kept")).toBe(true);
    expect(service.get("project.open")).toBe(true);
  });
});
