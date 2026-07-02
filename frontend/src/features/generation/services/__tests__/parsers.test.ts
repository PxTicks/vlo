import { describe, expect, it } from "vitest";
import { isRecord } from "../parsers";

describe("generation parsers", () => {
  it("identifies plain objects as records", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("text")).toBe(false);
    expect(isRecord(42)).toBe(false);
  });
});
