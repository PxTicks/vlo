// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { TwistFilter } from "pixi-filters";
import { twistFilterDefinition } from "../filters/twist";

describe("twistFilterDefinition", () => {
  it("keeps offset state isolated per filter instance", () => {
    const FilterClass = twistFilterDefinition.FilterClass as new () => TwistFilter;

    const first = new FilterClass();
    const second = new FilterClass();

    expect(first.offset).not.toBe(second.offset);

    first.offsetX = 120;
    first.offsetY = 220;

    expect(second.offsetX).toBe(0);
    expect(second.offsetY).toBe(0);
  });
});
