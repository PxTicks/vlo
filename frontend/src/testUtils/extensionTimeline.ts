import { vi } from "vitest";
import type {
  ExtensionTimelineClipSnapshot,
  ExtensionTimelineTransaction,
} from "@vlo/extension-sdk";

/**
 * A complete `ExtensionTimelineClipSnapshot` with plausible defaults.
 *
 * Same reasoning as the transaction stub below: the snapshot grows as the read
 * surface widens, and a fixture that spells out every field has to be edited
 * each time for reasons unrelated to what it tests. Override the fields the
 * test is actually about.
 */
export function createExtensionClipSnapshot(
  overrides: Partial<ExtensionTimelineClipSnapshot> = {},
): ExtensionTimelineClipSnapshot {
  return Object.freeze({
    id: "clip-1",
    type: "video",
    name: "Clip 1",
    trackId: "track-1",
    startTicks: 0,
    durationTicks: 96_000,
    sourceOffsetTicks: 0,
    sourceDurationTicks: 96_000,
    croppedSourceDurationTicks: 96_000,
    isMuted: false,
    rangeMasks: [],
    transformations: [],
    ...overrides,
  });
}

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
    updateClip: vi.fn(),
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
