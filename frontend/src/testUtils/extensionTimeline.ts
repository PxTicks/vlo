import { vi } from "vitest";
import type { ExtensionTimelineTransaction } from "@vlo/extension-sdk";

/**
 * A complete `ExtensionTimelineTransaction` of no-op spies, for tests that care
 * about one or two commands.
 *
 * The transaction contract grows as host surfaces open up, and a test that
 * hand-rolls the whole object has to be edited every time — noise that says
 * nothing about the behaviour under test. Override only what the test asserts
 * on; the rest stay callable spies.
 */
export function createExtensionTimelineTransactionStub(
  overrides: Partial<ExtensionTimelineTransaction> = {},
): ExtensionTimelineTransaction {
  return {
    createEntity: vi.fn(() => "stub-entity"),
    updatePayload: vi.fn(),
    moveEntity: vi.fn(),
    removeEntity: vi.fn(),
    createClip: vi.fn(() => "stub-clip"),
    moveClip: vi.fn(),
    trimClip: vi.fn(),
    splitClip: vi.fn(),
    removeClip: vi.fn(),
    createTrack: vi.fn(() => "stub-track"),
    updateTrack: vi.fn(),
    removeTrack: vi.fn(),
    upsertTransform: vi.fn(() => "stub-transform"),
    removeTransform: vi.fn(),
    createTransition: vi.fn(() => "stub-transition"),
    updateTransitionParameters: vi.fn(),
    removeTransition: vi.fn(),
    addClipMask: vi.fn(() => "stub-mask"),
    updateMaskParameters: vi.fn(),
    setMaskActiveRange: vi.fn(),
    removeMask: vi.fn(),
    ...overrides,
  };
}
