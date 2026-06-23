import { planTransformRender } from "../../../transformations/effectMaskRenderPlan";
import type {
  FrameNode,
  FrameNodeId,
  FrameResolutionGraph,
  FrameWorkKey,
  ResolvedClipFrameJob,
} from "./framePlanningTypes";
import {
  createClipOutputWorkKey,
  createEffectChainWorkKey,
  createMaskCoverageWorkKey,
  createMaskSyncWorkKey,
  createSourceFrameWorkKey,
} from "./frameWorkKeys";

export class FrameGraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameGraphValidationError";
  }
}

export class FrameResolutionGraphBuilder {
  private readonly epoch: number;
  private readonly jobs: readonly ResolvedClipFrameJob[];
  private readonly nodes: FrameNode[] = [];
  private readonly nodeById = new Map<FrameNodeId, FrameNode>();
  private readonly nodeIdByWorkKey = new Map<FrameWorkKey, FrameNodeId>();
  private readonly outputByJobId = new Map<string, FrameNodeId>();

  constructor(epoch: number, jobs: readonly ResolvedClipFrameJob[]) {
    this.epoch = epoch;
    this.jobs = jobs;
  }

  addNode(
    node: FrameNode,
    options: { deduplicate?: boolean } = {},
  ): FrameNodeId {
    if (this.nodeById.has(node.id)) {
      throw new FrameGraphValidationError(
        `Duplicate frame node id '${node.id}'`,
      );
    }

    if (options.deduplicate !== false) {
      const existingId = this.nodeIdByWorkKey.get(node.workKey);
      if (existingId) {
        return existingId;
      }
    }

    this.nodes.push(node);
    this.nodeById.set(node.id, node);
    this.nodeIdByWorkKey.set(node.workKey, node.id);
    return node.id;
  }

  setOutput(jobId: string, nodeId: FrameNodeId): void {
    if (this.outputByJobId.has(jobId)) {
      throw new FrameGraphValidationError(
        `Duplicate output mapping for frame job '${jobId}'`,
      );
    }
    this.outputByJobId.set(jobId, nodeId);
  }

  build(): FrameResolutionGraph {
    const graph: FrameResolutionGraph = {
      epoch: this.epoch,
      jobs: this.jobs,
      nodes: this.nodes,
      outputByJobId: this.outputByJobId,
    };
    validateFrameResolutionGraph(graph);
    return graph;
  }
}

export function validateFrameResolutionGraph(
  graph: FrameResolutionGraph,
): readonly FrameNode[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const jobIds = new Set(graph.jobs.map((job) => job.id));

  for (const node of graph.nodes) {
    for (const inputId of node.inputs) {
      if (!nodeById.has(inputId)) {
        throw new FrameGraphValidationError(
          `Frame node '${node.id}' references missing input '${inputId}'`,
        );
      }
    }
  }
  for (const [jobId, outputId] of graph.outputByJobId) {
    if (!jobIds.has(jobId)) {
      throw new FrameGraphValidationError(
        `Output references missing frame job '${jobId}'`,
      );
    }
    if (!nodeById.has(outputId)) {
      throw new FrameGraphValidationError(
        `Frame job '${jobId}' references missing output '${outputId}'`,
      );
    }
  }

  const visiting = new Set<FrameNodeId>();
  const visited = new Set<FrameNodeId>();
  const ordered: FrameNode[] = [];

  const visit = (node: FrameNode): void => {
    if (visited.has(node.id)) return;
    if (visiting.has(node.id)) {
      throw new FrameGraphValidationError(
        `Cycle detected at frame node '${node.id}'`,
      );
    }
    visiting.add(node.id);
    for (const inputId of node.inputs) {
      visit(nodeById.get(inputId)!);
    }
    visiting.delete(node.id);
    visited.add(node.id);
    ordered.push(node);
  };

  for (const node of graph.nodes) {
    visit(node);
  }
  return ordered;
}

function nodeId(epoch: number, kind: FrameNode["kind"], suffix: string): string {
  return `${epoch}:${kind}:${suffix}`;
}

export function buildFrameResolutionGraph(
  epoch: number,
  jobs: readonly ResolvedClipFrameJob[],
): FrameResolutionGraph {
  const builder = new FrameResolutionGraphBuilder(epoch, jobs);
  const sourceIdByJobId = new Map<string, string>();

  for (const job of jobs) {
    const sourceId = builder.addNode({
      id: nodeId(epoch, "source", job.id),
      kind: "source",
      workKey: createSourceFrameWorkKey(job),
      inputs: [],
      sourceKind: job.sourceFrame.decodeKey ? "asset" : "generated",
      jobIds: [job.id],
      sourceFrame: job.sourceFrame,
    });
    sourceIdByJobId.set(job.id, sourceId);
  }

  for (const job of jobs) {
    const sourceId = sourceIdByJobId.get(job.id)!;
    const maskSyncId = builder.addNode(
      {
        id: nodeId(epoch, "mask-sync", job.id),
        kind: "mask-sync",
        workKey: createMaskSyncWorkKey(epoch, job),
        inputs: [sourceId],
        jobId: job.id,
      },
      { deduplicate: false },
    );

    const transformPlan = planTransformRender(job.activeClip.transformations);
    const requests =
      transformPlan.mode === "offscreen"
        ? transformPlan.steps.flatMap((step) =>
            step.resolution.kind === "masked"
              ? [
                  {
                    expression: step.resolution.expression,
                    transformId: step.transform.id,
                  },
                ]
              : [],
          )
        : [];
    const coverageId = builder.addNode(
      {
        id: nodeId(epoch, "mask-coverage", job.id),
        kind: "mask-coverage",
        workKey: createMaskCoverageWorkKey(epoch, job),
        inputs: [maskSyncId],
        jobId: job.id,
        requests,
      },
      { deduplicate: false },
    );
    const effectId = builder.addNode(
      {
        id: nodeId(epoch, "effect-chain", job.id),
        kind: "effect-chain",
        workKey: createEffectChainWorkKey(epoch, job),
        inputs: [sourceId, coverageId],
        jobId: job.id,
        transforms: job.activeClip.transformations ?? [],
      },
      { deduplicate: false },
    );
    const outputId = builder.addNode(
      {
        id: nodeId(epoch, "clip-output", job.id),
        kind: "clip-output",
        workKey: createClipOutputWorkKey(epoch, job),
        inputs: [effectId],
        jobId: job.id,
      },
      { deduplicate: false },
    );
    builder.setOutput(job.id, outputId);
  }

  const graph = builder.build();
  const sourceJobsByNodeId = new Map<string, string[]>();
  for (const job of jobs) {
    const id = sourceIdByJobId.get(job.id)!;
    const grouped = sourceJobsByNodeId.get(id) ?? [];
    grouped.push(job.id);
    sourceJobsByNodeId.set(id, grouped);
  }

  const nodes = graph.nodes.map((node) =>
    node.kind === "source"
      ? { ...node, jobIds: sourceJobsByNodeId.get(node.id) ?? node.jobIds }
      : node,
  );
  return { ...graph, nodes };
}
