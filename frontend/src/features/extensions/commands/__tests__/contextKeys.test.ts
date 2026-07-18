import { describe, expect, it, vi } from "vitest";
import {
  HostContextKeyService,
  assertContextKeyExpression,
  evaluateContextKeyExpression,
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
