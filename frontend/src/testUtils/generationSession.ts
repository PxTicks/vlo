import { vi } from "vitest";
import { generationSessionService } from "../features/generation/services/GenerationSessionService";
import type {
  GenerationSessionCommit,
  GenerationSessionPublication,
} from "../features/generation/services/generationSessionTypes";

/**
 * A complete `GenerationSessionPublication` with plausible defaults.
 *
 * The publication grows as the session surface widens, and a fixture that
 * spells out every field has to be edited each time for reasons unrelated to
 * what it tests. Override the fields the test is actually about.
 */
export function createGenerationPublication(
  overrides: Partial<GenerationSessionPublication> = {},
): GenerationSessionPublication {
  return {
    sourceId: "workflow-1",
    instanceId: "instance-1",
    fingerprint: "fingerprint-1",
    mode: "catalogue",
    nodes: [],
    inputs: [],
    editableWidgets: [],
    readiness: { isLoading: false, isReady: true, hasError: false },
    submission: { isBusy: false, queuedCount: 0, canSubmit: true },
    ...overrides,
  };
}

export interface MountedGenerationSession {
  readonly commit: ReturnType<typeof vi.fn>;
  publish(overrides?: Partial<GenerationSessionPublication>): void;
  unmount(): void;
}

/** Mount the session with a spy host and publish one snapshot. */
export function mountGenerationSession(
  overrides: Partial<GenerationSessionPublication> = {},
): MountedGenerationSession {
  const commit = vi.fn<(update: GenerationSessionCommit) => void>();
  const unmount = generationSessionService.mount({ commit });
  generationSessionService.publish(createGenerationPublication(overrides));
  return {
    commit,
    publish: (next: Partial<GenerationSessionPublication> = {}) => {
      generationSessionService.publish(createGenerationPublication(next));
    },
    unmount,
  };
}
