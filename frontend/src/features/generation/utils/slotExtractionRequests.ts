import type { GenerationMediaInputValue } from "../types";

/**
 * Slot-scoped bookkeeping for in-flight extractions.
 *
 * An extraction belongs to the slot it started in. Any edit that rewrites a
 * slot — clearing a batch item, reordering one, moving one to another input —
 * therefore has to invalidate that slot's request, or the render finishing
 * afterwards writes its result into a slot it no longer owns.
 */

/**
 * The slots an edit actually rewrote, given what they held before and after.
 * Comparison is by reference: the store moves the same value objects between
 * slots, so a different object (or an emptied slot) is a real change, while
 * slots the edit left alone compare equal and keep their running extractions.
 */
export function pickChangedSlotIds(
  slotIds: readonly string[],
  before: readonly (GenerationMediaInputValue | null)[],
  after: readonly (GenerationMediaInputValue | null)[],
): string[] {
  return slotIds.filter(
    (_, index) => (before[index] ?? null) !== (after[index] ?? null),
  );
}

/**
 * Invalidates each slot's current request, so results still in flight for them
 * are discarded instead of written back. Mutates the caller's map, which is the
 * same ref the extraction callbacks read their guard from.
 */
export function bumpSlotExtractionRequestIds(
  requestIds: Record<string, number>,
  slotIds: readonly string[],
): void {
  for (const slotId of new Set(slotIds)) {
    requestIds[slotId] = (requestIds[slotId] ?? 0) + 1;
  }
}
