import type {
  TransformationRenderingPolicy,
  TransformationRenderingPolicyInput,
} from "./types";

// Host scheduling bounds apply equally to native filters and extensions.
const HOST_MAX_HISTORY_SECONDS = 30;
const HOST_MAX_STEP_SECONDS = 1;

export const DEFAULT_TRANSFORMATION_RENDERING_POLICY: TransformationRenderingPolicy =
  Object.freeze({
    timeDependency: "none",
    maxHistorySeconds: 0,
    maxStepSeconds: null,
  });

/**
 * Validate and freeze a native filter rendering policy. Extension declarations
 * are structurally adapted into this input at the extension boundary.
 */
export function normalizeTransformationRenderingPolicy(
  input: TransformationRenderingPolicyInput | undefined,
  definitionId: string,
): TransformationRenderingPolicy {
  if (!input) return DEFAULT_TRANSFORMATION_RENDERING_POLICY;

  const { timeDependency, maxHistorySeconds, maxStepSeconds } = input;
  if (
    timeDependency !== "none" &&
    timeDependency !== "sample" &&
    timeDependency !== "history"
  ) {
    throw new Error(
      `Transformation '${definitionId}' declares an unknown time dependency.`,
    );
  }

  if (maxHistorySeconds !== undefined) {
    if (timeDependency !== "history") {
      throw new Error(
        `Transformation '${definitionId}' may declare maxHistorySeconds only for a history filter.`,
      );
    }
    if (
      !Number.isFinite(maxHistorySeconds) ||
      maxHistorySeconds < 0 ||
      maxHistorySeconds > HOST_MAX_HISTORY_SECONDS
    ) {
      throw new Error(
        `Transformation '${definitionId}' maxHistorySeconds must be within 0..${HOST_MAX_HISTORY_SECONDS} seconds.`,
      );
    }
  }

  if (maxStepSeconds !== undefined) {
    if (timeDependency === "none") {
      throw new Error(
        `Transformation '${definitionId}' may declare maxStepSeconds only for a sample or history filter.`,
      );
    }
    if (
      !Number.isFinite(maxStepSeconds) ||
      maxStepSeconds <= 0 ||
      maxStepSeconds > HOST_MAX_STEP_SECONDS
    ) {
      throw new Error(
        `Transformation '${definitionId}' maxStepSeconds must be within (0..${HOST_MAX_STEP_SECONDS}] seconds.`,
      );
    }
  }

  return Object.freeze({
    timeDependency,
    maxHistorySeconds:
      timeDependency === "history" ? (maxHistorySeconds ?? 0) : 0,
    maxStepSeconds:
      timeDependency === "none" ? null : (maxStepSeconds ?? null),
  });
}
