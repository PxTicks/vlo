import type { ClipTransform, TimelineClip } from "../../../types/TimelineTypes";
import { getEntryForTransform } from "./TransformationRegistry";
import type {
  FilterRenderContext,
  FilterTimeDependency,
  TransformationRenderingPolicy,
} from "./types";

export interface TemporalRenderingRequirements {
  readonly timeDependency: FilterTimeDependency;
  readonly maxHistorySeconds: number;
  readonly maxStepSeconds: number | null;
}

export const NO_TEMPORAL_RENDERING_REQUIREMENTS: TemporalRenderingRequirements =
  Object.freeze({
    timeDependency: "none",
    maxHistorySeconds: 0,
    maxStepSeconds: null,
  });

function dependencyRank(dependency: FilterTimeDependency): number {
  if (dependency === "history") return 2;
  if (dependency === "sample") return 1;
  return 0;
}

export function mergeTemporalRenderingRequirements(
  requirements: readonly TemporalRenderingRequirements[],
): TemporalRenderingRequirements {
  if (requirements.length === 0) {
    return NO_TEMPORAL_RENDERING_REQUIREMENTS;
  }

  let timeDependency: FilterTimeDependency = "none";
  let maxHistorySeconds = 0;
  let maxStepSeconds: number | null = null;
  for (const requirement of requirements) {
    if (
      dependencyRank(requirement.timeDependency) >
      dependencyRank(timeDependency)
    ) {
      timeDependency = requirement.timeDependency;
    }
    maxHistorySeconds = Math.max(
      maxHistorySeconds,
      requirement.maxHistorySeconds,
    );
    if (requirement.maxStepSeconds !== null) {
      maxStepSeconds =
        maxStepSeconds === null
          ? requirement.maxStepSeconds
          : Math.min(maxStepSeconds, requirement.maxStepSeconds);
    }
  }

  return Object.freeze({
    timeDependency,
    maxHistorySeconds,
    maxStepSeconds,
  });
}

export function getTransformRenderingPolicy(
  transform: ClipTransform,
): TransformationRenderingPolicy | null {
  if (!transform.isEnabled) return null;
  const entry = getEntryForTransform(transform);
  return entry?.rendering ?? null;
}

export function collectTemporalRenderingRequirements(
  transformationSets: readonly (readonly ClipTransform[])[],
): TemporalRenderingRequirements {
  const policies: TransformationRenderingPolicy[] = [];
  for (const transformations of transformationSets) {
    for (const transform of transformations) {
      const policy = getTransformRenderingPolicy(transform);
      if (policy && policy.timeDependency !== "none") {
        policies.push(policy);
      }
    }
  }
  return mergeTemporalRenderingRequirements(policies);
}

/**
 * Stable identity for the enabled temporal portion of transformation stacks.
 * The preview coordinator uses this to replay when a history filter is added,
 * removed, or replaced while the playhead is paused.
 */
export function getTemporalTransformationTopologyKey(
  transformationSets: readonly (readonly ClipTransform[])[],
): string {
  const parts: string[] = [];
  transformationSets.forEach((transformations, setIndex) => {
    transformations.forEach((transform, transformIndex) => {
      const policy = getTransformRenderingPolicy(transform);
      if (!policy || policy.timeDependency === "none") return;
      const filterName =
        transform.type === "filter" && "filterName" in transform
          ? String(transform.filterName)
          : "";
      parts.push(
        [
          setIndex,
          transformIndex,
          transform.id,
          transform.type,
          filterName,
          policy.timeDependency,
          policy.maxHistorySeconds,
          policy.maxStepSeconds ?? "unbounded",
        ].join(":"),
      );
    });
  });
  return parts.join("|");
}

/** Source identity that must reset temporal feedback when edited in place. */
export function getTemporalClipSourceIdentity(clip: TimelineClip): string {
  if (clip.type === "video" || clip.type === "image" || clip.type === "audio") {
    return `${clip.id}:${clip.type}:asset:${clip.assetId}`;
  }
  if (clip.type === "text") {
    return `${clip.id}:text:${JSON.stringify(clip.textData)}`;
  }
  if (clip.type === "extension") {
    return `${clip.id}:extension:${JSON.stringify(clip.extensionPayload)}`;
  }
  return `${clip.id}:${clip.type}`;
}

export function collectClipTemporalRenderingRequirements(
  clips: readonly TimelineClip[],
): TemporalRenderingRequirements {
  return collectTemporalRenderingRequirements(
    clips.map((clip) => clip.transformations ?? []),
  );
}

/**
 * Cache identity required by a rendered transform chain. Stateless chains may
 * reuse their ordinary source/parameter key; sample/history chains must also
 * vary by the host-certified logical sample.
 */
export function getTemporalSampleCacheIdentity(
  transforms: readonly ClipTransform[],
  render: FilterRenderContext,
): string | null {
  const isTimeDependent = transforms.some((transform) => {
    const policy = getTransformRenderingPolicy(transform);
    return policy !== null && policy.timeDependency !== "none";
  });
  return isTimeDependent
    ? `sample:${render.sequenceId}:${render.sampleId}`
    : null;
}
