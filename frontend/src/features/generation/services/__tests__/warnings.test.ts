import { describe, expect, it } from "vitest";
import { mergeRuleWarnings } from "../warnings";

describe("mergeRuleWarnings", () => {
  it("deduplicates warnings while preserving order", () => {
    const first = { code: "a", message: "first" };
    const second = { code: "b", message: "second" };

    const merged = mergeRuleWarnings(
      [first, second],
      [first],
      [second, { code: "c", message: "third", node_id: "1" }],
    );

    expect(merged).toEqual([
      first,
      second,
      { code: "c", message: "third", node_id: "1" },
    ]);
  });
});
