import { describe, expect, it } from "vitest";
import {
  applyPatches,
  enablePatches,
  produce,
  produceWithPatches,
  type Patch,
} from "../immerLite";

describe("immerLite", () => {
  it("produces a structurally independent draft", () => {
    const base = { nested: { count: 1 }, list: [1, 2] };
    const next = produce(base, (draft) => {
      draft.nested.count = 2;
      draft.list.push(3);
    });

    expect(next).toEqual({ nested: { count: 2 }, list: [1, 2, 3] });
    expect(base).toEqual({ nested: { count: 1 }, list: [1, 2] });
    expect(() => enablePatches()).not.toThrow();
  });

  it("builds add, remove, and replace patches with working inverses", () => {
    const base = {
      kept: { value: 1 },
      changed: [1, { deep: true }],
      removed: "old",
    };
    const [next, patches, inverse] = produceWithPatches(base, (draft) => {
      draft.kept.value = 1;
      draft.changed[1] = { deep: false };
      delete (draft as Partial<typeof draft>).removed;
      Object.assign(draft, { added: { safe: true } });
    });

    expect(patches).toEqual([
      {
        op: "replace",
        path: ["changed"],
        value: [1, { deep: false }],
      },
      { op: "remove", path: ["removed"] },
      { op: "add", path: ["added"], value: { safe: true } },
    ]);
    expect(applyPatches(base, patches)).toEqual(next);
    expect(applyPatches(next, inverse)).toEqual(base);
  });

  it("recognizes unchanged arrays, objects, primitives, and missing keys", () => {
    const base = {
      array: [1, { value: "same" }],
      object: { a: 1, b: 2 },
      primitive: "same",
    };
    const [, patches] = produceWithPatches(base, () => undefined);
    expect(patches).toEqual([]);

    const [, changed] = produceWithPatches(base, (draft) => {
      draft.array = [1];
      draft.object = { a: 1, b: 3 };
      draft.primitive = "different";
    });
    expect(changed).toHaveLength(3);
  });

  it("applies nested object and array operations", () => {
    const base = { nested: { values: ["a", "b"], flag: true } };
    const patches: Patch[] = [
      { op: "replace", path: ["nested", "flag"], value: false },
      { op: "replace", path: ["nested", "values", 0], value: "first" },
      { op: "add", path: ["nested", "values", 2], value: "third" },
      { op: "remove", path: ["nested", "values", 1] },
    ];

    expect(applyPatches(base, patches)).toEqual({
      nested: { values: ["first", "third"], flag: false },
    });
  });

  it("rejects invalid patch paths and array keys", () => {
    expect(() =>
      applyPatches({ value: 1 }, [{ op: "replace", path: [], value: 2 }]),
    ).toThrow("Root path patches are not supported");
    expect(() =>
      applyPatches(
        { value: 1 },
        [{ op: "replace", path: ["value", "nested"], value: 2 }],
      ),
    ).toThrow("Patch parent is not addressable");
    expect(() =>
      applyPatches(
        { nested: {} },
        [{ op: "replace", path: ["nested", "missing", "value"], value: 2 }],
      ),
    ).toThrow("does not exist");
    expect(() =>
      applyPatches(
        { values: ["a"] },
        [{ op: "replace", path: ["values", "bad"], value: "b" }],
      ),
    ).toThrow("Array patch key must be a number");
  });
});
