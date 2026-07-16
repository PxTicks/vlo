import type {
  ClipTransform,
  MaskBooleanExpression,
  MaskTimelineClip,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import type { DerivedRenderGroup } from "../../utils/deriveAdjustmentGroups";
import type { FilterRenderContext } from "../../../transformations/catalogue/types";
import type { SourceFrameSyncRef } from "../../utils/sourceFrameSync";

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
  | { mode: "live"; epoch: number; render?: FilterRenderContext };

export interface FrameResourceLease<T> {
  readonly key: FrameWorkKey;
  readonly value: T;
  release(): void;
}

export interface FramePlanningDiagnostics {
  epoch: number;
  jobsPlanned: number;
  nodesPlanned: number;
  nodesExecutedByKind: Record<FrameNode["kind"], number>;
  withinFrameDedupHits: number;
  cacheHits: number;
  cacheMisses: number;
  staleGenerationsDropped: number;
  decodeTimeMs: number;
  gpuTimeMs: number;
  residentSourceResources: number;
  residentCoverageResources: number;
  residentEffectResources: number;
  outstandingLeases: number;
}

export function createEmptyFramePlanningDiagnostics(
  epoch: number,
): FramePlanningDiagnostics {
  return {
    epoch,
    jobsPlanned: 0,
    nodesPlanned: 0,
    nodesExecutedByKind: {
      source: 0,
      "mask-sync": 0,
      "mask-coverage": 0,
      "effect-chain": 0,
      "clip-output": 0,
    },
    withinFrameDedupHits: 0,
    cacheHits: 0,
    cacheMisses: 0,
    staleGenerationsDropped: 0,
    decodeTimeMs: 0,
    gpuTimeMs: 0,
    residentSourceResources: 0,
    residentCoverageResources: 0,
    residentEffectResources: 0,
    outstandingLeases: 0,
  };
}
