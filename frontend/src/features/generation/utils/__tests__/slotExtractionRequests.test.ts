import { describe, expect, it } from "vitest";

import type { GenerationMediaInputValue } from "../../types";
import {
  bumpSlotExtractionRequestIds,
  pickChangedSlotIds,
} from "../slotExtractionRequests";

const first = { kind: "asset" } as GenerationMediaInputValue;
const second = { kind: "asset" } as GenerationMediaInputValue;
const third = { kind: "timelineSelection" } as GenerationMediaInputValue;

describe("pickChangedSlotIds", () => {
  it("reports the slots a reorder rewrote and leaves the rest alone", () => {
    const slotIds = ["s0", "s1", "s2"];

    // The value in s2 moved to s0; s1 never moved, so its own extraction must
    // survive rather than be thrown away and restarted.
    expect(
      pickChangedSlotIds(
        slotIds,
        [first, second, third],
        [third, second, first],
      ),
    ).toEqual(["s0", "s2"]);
  });

  it("reports a slot a clear emptied and the ones that shifted into place", () => {
    expect(
      pickChangedSlotIds(
        ["s0", "s1", "s2"],
        [first, second, third],
        [second, third, null],
      ),
    ).toEqual(["s0", "s1", "s2"]);
  });

  it("reports nothing when the edit was a no-op", () => {
    expect(
      pickChangedSlotIds(["s0", "s1"], [first, null], [first, null]),
    ).toEqual([]);
  });

  it("treats a missing reading as an empty slot", () => {
    expect(pickChangedSlotIds(["s0"], [undefined as never], [null])).toEqual([]);
  });
});

describe("bumpSlotExtractionRequestIds", () => {
  it("invalidates each named slot once, starting from zero", () => {
    const requestIds: Record<string, number> = { s0: 4 };

    bumpSlotExtractionRequestIds(requestIds, ["s0", "s1", "s1"]);

    expect(requestIds).toEqual({ s0: 5, s1: 1 });
  });

  it("leaves untouched slots at their current request", () => {
    const requestIds: Record<string, number> = { s0: 2, s1: 7 };

    bumpSlotExtractionRequestIds(requestIds, ["s0"]);

    expect(requestIds).toEqual({ s0: 3, s1: 7 });
  });
});
