import type {
  ClipTransform,
  CompositeContent,
  MaskBooleanExpression,
  MaskTimelineClip,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import type { DerivedRenderGroup } from "../../utils/deriveAdjustmentGroups";
import type { FilterRenderContext } from "../../../transformations/catalogue/types";
import type { SourceFrameSyncRef } from "../../utils/sourceFrameSync";
import type { CompositeSourceFallbackReason } from "./CompositeSourcePolicy";

export type FrameJobId = string;
export type FrameNodeId = string;
export type FrameWorkKey = string;

export interface FrameDimensions {
  width: number;
  height: number;
}

export interface ResolvedClipFrameJob {
  id: FrameJobId;
  trackId: string;
  activeClip: TimelineClip;
  effectiveTrackTick: number;
  rawClipTick: number;
  sourceFrame: SourceFrameSyncRef;
  maskClips: readonly MaskTimelineClip[];
  logicalDimensions: FrameDimensions;
  contentSize: FrameDimensions;
  fps: number;
  transitionTransforms?: readonly ClipTransform[];
  compositeSource?: ResolvedCompositeSource;
}

export interface ResolvedCompositeSource {
  mode: "live" | "baked";
  fallbackReason: CompositeSourceFallbackReason | null;
  sourceChanged: boolean;
  switchLatencyMs: number | null;
  compositeId: string;
  placementId: string;
  revision: number;
  bakeKey: string;
  localPresentationTick: number;
  logicalDimensions: FrameDimensions;
  fps: number;
  content: CompositeContent;
  fallbackAssetId: string | null;
  /** Stateless child scenes may reuse identical work within one placement. */
  isStateless?: boolean;
}

export interface FrameNodeBase {
  id: FrameNodeId;
  workKey: FrameWorkKey;
  inputs: readonly FrameNodeId[];
}

export interface SourceFrameNode extends FrameNodeBase {
  kind: "source";
  sourceKind: "asset" | "generated";
  jobIds: readonly FrameJobId[];
  sourceFrame: SourceFrameSyncRef;
}

export interface CompositeSceneNode extends FrameNodeBase {
  kind: "composite-scene";
  jobId: FrameJobId;
  compositeId: string;
  placementId: string;
  revision: number;
  bakeKey: string;
  localPresentationTick: number;
  logicalDimensions: FrameDimensions;
  childOutputIds: readonly FrameNodeId[];
}

export interface MaskSyncNode extends FrameNodeBase {
  kind: "mask-sync";
  jobId: FrameJobId;
}

export interface MaskCoverageRequest {
  expression: MaskBooleanExpression;
  transformId: string;
}

export interface MaskCoverageNode extends FrameNodeBase {
  kind: "mask-coverage";
  jobId: FrameJobId;
  requests: readonly MaskCoverageRequest[];
}

export interface EffectChainNode extends FrameNodeBase {
  kind: "effect-chain";
  jobId: FrameJobId;
  transforms: readonly ClipTransform[];
}

export interface ClipOutputNode extends FrameNodeBase {
  kind: "clip-output";
  jobId: FrameJobId;
}

export type FrameNode =
  | SourceFrameNode
  | CompositeSceneNode
  | MaskSyncNode
  | MaskCoverageNode
  | EffectChainNode
  | ClipOutputNode;

export interface FrameResolutionGraph {
  epoch: number;
  jobs: readonly ResolvedClipFrameJob[];
  nodes: readonly FrameNode[];
  outputByJobId: ReadonlyMap<FrameJobId, FrameNodeId>;
}

export interface TrackPresentationCommand {
  trackId: string;
  jobId: FrameJobId | null;
  visible: boolean;
  parentGroupId: string | null;
  zIndex: number;
}

export interface OutputSinkCommand {
  id: string;
  source: "project-composite";
}

export interface TransitionColorLayerCommand {
  id: string;
  color: string;
  parentGroupId: string | null;
  zIndex: number;
}

export interface ScenePresentationPlan {
  epoch: number;
  tracks: readonly TrackPresentationCommand[];
  adjustmentForest: readonly DerivedRenderGroup[];
  transitionColorLayers?: readonly TransitionColorLayerCommand[];
  encoderSinks: readonly OutputSinkCommand[];
}

export type FrameExecutionPolicy =
  | { mode: "export"; signal?: AbortSignal; render?: FilterRenderContext }
  | {
      mode: "live";
      epoch: number;
      signal?: AbortSignal;
      render?: FilterRenderContext;
      temporalPreviewQuality?: "exact" | "approximate";
      /**
       * Physical raster demand from the live presentation sink. Omit only for
       * callers that intentionally require the source-fidelity fallback.
       */
      outputDimensions?: FrameDimensions;
    };

export interface FrameResourceLease<T> {
  readonly key: FrameWorkKey;
  readonly value: T;
  release(): void;
}

export interface CompositeChildPlanningDiagnostics {
  samples: number;
  warmupSamples: number;
  targetSamples: number;
  cancelledSamples: number;
  failedSamples: number;
  jobsPlanned: number;
  nodesPlanned: number;
  withinFrameDedupHits: number;
  cacheHits: number;
  cacheMisses: number;
  resolutionTimeMs: number;
  decodeTimeMs: number;
  gpuTimeMs: number;
  peakResidentSourceResources: number;
  peakResidentSourceTextureBytes: number;
  peakOutstandingLeases: number;
}

export function createEmptyCompositeChildPlanningDiagnostics(
): CompositeChildPlanningDiagnostics {
  return {
    samples: 0,
    warmupSamples: 0,
    targetSamples: 0,
    cancelledSamples: 0,
    failedSamples: 0,
    jobsPlanned: 0,
    nodesPlanned: 0,
    withinFrameDedupHits: 0,
    cacheHits: 0,
    cacheMisses: 0,
    resolutionTimeMs: 0,
    decodeTimeMs: 0,
    gpuTimeMs: 0,
    peakResidentSourceResources: 0,
    peakResidentSourceTextureBytes: 0,
    peakOutstandingLeases: 0,
  };
}

export interface FramePlanningDiagnostics {
  epoch: number;
  resolutionTimeMs: number;
  jobsPlanned: number;
  nodesPlanned: number;
  nodesExecutedByKind: Record<FrameNode["kind"], number>;
  withinFrameDedupHits: number;
  cacheHits: number;
  cacheMisses: number;
  staleGenerationsDropped: number;
  compositeLiveJobs: number;
  compositeBakedJobs: number;
  compositeFallbackReasons: Partial<
    Record<CompositeSourceFallbackReason, number>
  >;
  compositeNodeFailures: number;
  compositeSourceSwitches: number;
  compositeSwitchLatencyMs: number;
  compositeRuntimeCount: number;
  compositePooledRuntimeCount: number;
  compositeTextureBytes: number;
  compositeOutstandingLeases: number;
  compositeRenderDedupHits: number;
  compositeSnapshotClones: number;
  compositeSnapshotCacheHits: number;
  compositeChild: CompositeChildPlanningDiagnostics;
  compositeChildResidentSourceResources: number;
  compositeChildResidentSourceTextureBytes: number;
  compositeChildOutstandingLeases: number;
  decodeTimeMs: number;
  gpuTimeMs: number;
  residentSourceResources: number;
  residentSourceTextureBytes: number;
  residentCoverageResources: number;
  residentEffectResources: number;
  outstandingLeases: number;
}

export function createEmptyFramePlanningDiagnostics(
  epoch: number,
): FramePlanningDiagnostics {
  return {
    epoch,
    resolutionTimeMs: 0,
    jobsPlanned: 0,
    nodesPlanned: 0,
    nodesExecutedByKind: {
      source: 0,
      "composite-scene": 0,
      "mask-sync": 0,
      "mask-coverage": 0,
      "effect-chain": 0,
      "clip-output": 0,
    },
    withinFrameDedupHits: 0,
    cacheHits: 0,
    cacheMisses: 0,
    staleGenerationsDropped: 0,
    compositeLiveJobs: 0,
    compositeBakedJobs: 0,
    compositeFallbackReasons: {},
    compositeNodeFailures: 0,
    compositeSourceSwitches: 0,
    compositeSwitchLatencyMs: 0,
    compositeRuntimeCount: 0,
    compositePooledRuntimeCount: 0,
    compositeTextureBytes: 0,
    compositeOutstandingLeases: 0,
    compositeRenderDedupHits: 0,
    compositeSnapshotClones: 0,
    compositeSnapshotCacheHits: 0,
    compositeChild: createEmptyCompositeChildPlanningDiagnostics(),
    compositeChildResidentSourceResources: 0,
    compositeChildResidentSourceTextureBytes: 0,
    compositeChildOutstandingLeases: 0,
    decodeTimeMs: 0,
    gpuTimeMs: 0,
    residentSourceResources: 0,
    residentSourceTextureBytes: 0,
    residentCoverageResources: 0,
    residentEffectResources: 0,
    outstandingLeases: 0,
  };
}
