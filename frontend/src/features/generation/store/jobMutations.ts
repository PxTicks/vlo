import type { ParsedBinaryPreview as ComfyUIPreview } from "../services/previewBinary";
import type { GenerationJob } from "../types";
import {
  getPreviewFrameExtension,
  getPreviewFrameIndex,
  replacePreviewAnimation,
  revokeJobPostprocessPreview,
  revokePreviewAnimation,
} from "./previewState";
import { isGenerationInterruptionMessage } from "./constants";
import type {
  ComfyUIConnectionStatus,
  GenerationStore,
  GenerationStorePatch,
  PostprocessResultPatch,
  PreviewAnimation,
} from "./types";

type JobErrorState = Pick<
  GenerationStore,
  "jobs" | "jobPreviewFrames" | "previewAnimation" | "activeJobId" | "connectionStatus"
>;

type JobPreviewState = Pick<
  GenerationStore,
  | "latestPreviewUrl"
  | "previewAnimation"
  | "activeJobId"
  | "jobs"
  | "jobPreviewFrames"
>;

type JobPostprocessState = Pick<GenerationStore, "jobs">;

type JobClearState = Pick<GenerationStore, "jobs" | "jobPreviewFrames">;

export function isActiveGenerationJob(
  job: GenerationJob | null | undefined,
): job is GenerationJob & { status: "queued" | "running" } {
  return job?.status === "queued" || job?.status === "running";
}

export function markJobError(
  state: JobErrorState,
  jobId: string,
  errorMessage: string,
  currentNode: string | null,
  options?: {
    nextConnectionStatus?: ComfyUIConnectionStatus;
    clearActiveJob?: boolean;
    completedAt?: number | null;
  },
): GenerationStorePatch {
  const job = state.jobs.get(jobId);
  if (!job) {
    return options?.nextConnectionStatus
      ? { connectionStatus: options.nextConnectionStatus }
      : {};
  }
  if (
    job.status === "error" &&
    isGenerationInterruptionMessage(job.error) &&
    !errorMessage.startsWith("Cancel failed:")
  ) {
    return options?.nextConnectionStatus
      ? { connectionStatus: options.nextConnectionStatus }
      : {};
  }

  const updated = new Map(state.jobs);
  updated.set(jobId, {
    ...job,
    status: "error",
    error: errorMessage,
    currentNode,
    ...(options?.completedAt !== undefined
      ? { completedAt: options.completedAt }
      : {}),
  });

  const nextPreviewFrames = new Map(state.jobPreviewFrames);
  nextPreviewFrames.delete(jobId);
  revokePreviewAnimation(state.previewAnimation);

  return {
    jobs: updated,
    jobPreviewFrames: nextPreviewFrames,
    previewAnimation: null,
    ...(options?.clearActiveJob && state.activeJobId === jobId
      ? { activeJobId: null }
      : {}),
    ...(options?.nextConnectionStatus
      ? { connectionStatus: options.nextConnectionStatus }
      : {}),
  };
}

export function markActiveJobError(
  state: JobErrorState,
  errorMessage: string,
  options?: {
    nextConnectionStatus?: ComfyUIConnectionStatus;
    completedAt?: number | null;
  },
): GenerationStorePatch {
  const activeJobId = state.activeJobId;
  if (!activeJobId) {
    return options?.nextConnectionStatus
      ? { connectionStatus: options.nextConnectionStatus }
      : {};
  }

  const activeJob = state.jobs.get(activeJobId);
  if (!isActiveGenerationJob(activeJob)) {
    return options?.nextConnectionStatus
      ? { connectionStatus: options.nextConnectionStatus }
      : {};
  }

  return markJobError(state, activeJobId, errorMessage, null, {
    clearActiveJob: true,
    completedAt: options?.completedAt,
    nextConnectionStatus: options?.nextConnectionStatus,
  });
}

export function setJobPostprocessResult(
  state: JobPostprocessState,
  jobId: string,
  result: PostprocessResultPatch,
): GenerationStorePatch {
  const currentJob = state.jobs.get(jobId);
  if (!currentJob) return {};

  const previousPreviewUrl = currentJob.postprocessedPreview?.previewUrl;
  const nextPreviewUrl = result.postprocessedPreview?.previewUrl;
  if (previousPreviewUrl && previousPreviewUrl !== nextPreviewUrl) {
    URL.revokeObjectURL(previousPreviewUrl);
  }

  const updated = new Map(state.jobs);
  updated.set(jobId, {
    ...currentJob,
    postprocessedPreview: result.postprocessedPreview ?? null,
    postprocessError: result.postprocessError,
    importedAssetIds: result.importedAssetIds ?? currentJob.importedAssetIds,
  });
  return { jobs: updated };
}

function buildNextAnimation(
  currentAnimation: PreviewAnimation | null,
  preview: ComfyUIPreview,
): PreviewAnimation | null {
  const isVhsFrame =
    typeof preview.frameIndex === "number" &&
    typeof preview.totalFrames === "number" &&
    preview.totalFrames > 0 &&
    typeof preview.frameRate === "number" &&
    preview.frameRate > 0;

  if (!isVhsFrame) {
    return replacePreviewAnimation(currentAnimation, null);
  }

  const totalFrames = preview.totalFrames as number;
  const frameIdx = preview.frameIndex as number;
  const frameRate = preview.frameRate as number;
  const existingAnimation =
    currentAnimation?.totalFrames === totalFrames
      ? currentAnimation
      : replacePreviewAnimation(currentAnimation, null);
  const frameUrls = existingAnimation
    ? existingAnimation.frameUrls.slice()
    : new Array<string | null>(totalFrames).fill(null);
  const oldUrl = frameUrls[frameIdx];
  if (oldUrl) URL.revokeObjectURL(oldUrl);
  frameUrls[frameIdx] = URL.createObjectURL(preview.blob);
  return { frameUrls, frameRate, totalFrames };
}

function matchesPreviewNodeId(
  activeNodeId: string,
  previewNodeId: string,
): boolean {
  return (
    activeNodeId === previewNodeId ||
    activeNodeId.startsWith(previewNodeId) ||
    previewNodeId.startsWith(activeNodeId)
  );
}

function previewMatchesActiveJob(
  activeJob: GenerationJob,
  preview: ComfyUIPreview,
): boolean {
  if (typeof preview.promptId === "string" && preview.promptId.length > 0) {
    return preview.promptId === activeJob.id;
  }

  if (
    typeof preview.nodeId === "string" &&
    preview.nodeId.length > 0 &&
    typeof activeJob.currentNode === "string" &&
    activeJob.currentNode.length > 0
  ) {
    return matchesPreviewNodeId(activeJob.currentNode, preview.nodeId);
  }

  return true;
}

export function applyPreviewUpdate(
  state: JobPreviewState,
  preview: ComfyUIPreview,
): GenerationStorePatch {
  const activeJobId = state.activeJobId;
  const activeJob = activeJobId ? state.jobs.get(activeJobId) : null;
  if (activeJob && isActiveGenerationJob(activeJob)) {
    if (!previewMatchesActiveJob(activeJob, preview)) {
      return {};
    }
  }

  if (state.latestPreviewUrl) {
    URL.revokeObjectURL(state.latestPreviewUrl);
  }
  const nextPreviewUrl = URL.createObjectURL(preview.blob);
  const nextAnimation = buildNextAnimation(state.previewAnimation, preview);

  if (!activeJobId) {
    return {
      latestPreviewUrl: nextPreviewUrl,
      previewAnimation: nextAnimation,
    };
  }

  if (!activeJob || !isActiveGenerationJob(activeJob)) {
    return {
      latestPreviewUrl: nextPreviewUrl,
      previewAnimation: nextAnimation,
    };
  }

  const previewMode = activeJob.postprocessConfig?.mode ?? "auto";
  const shouldCollectPreviewFrames =
    previewMode === "auto" || previewMode === "stitch_frames_with_audio";
  if (
    !shouldCollectPreviewFrames ||
    !activeJob.usesSaveImageWebsocketOutputs
  ) {
    return {
      latestPreviewUrl: nextPreviewUrl,
      previewAnimation: nextAnimation,
    };
  }

  const isFromSaveNode =
    activeJob.currentNode != null &&
    activeJob.saveImageWebsocketNodeIds?.has(activeJob.currentNode);
  if (!isFromSaveNode) {
    return {
      latestPreviewUrl: nextPreviewUrl,
      previewAnimation: nextAnimation,
    };
  }

  const existingFrames = state.jobPreviewFrames.get(activeJobId) ?? [];
  const nextFrames = new Map(state.jobPreviewFrames);
  const previewFrames = existingFrames.slice();
  const frameIndex = getPreviewFrameIndex(preview, existingFrames);
  const mimeType = preview.blob.type || "image/png";

  previewFrames[frameIndex] = new File(
    [preview.blob],
    `ws-preview-${activeJobId}-${frameIndex.toString().padStart(6, "0")}.${getPreviewFrameExtension(mimeType)}`,
    {
      type: mimeType,
      lastModified: Date.now(),
    },
  );
  nextFrames.set(activeJobId, previewFrames);

  return {
    latestPreviewUrl: nextPreviewUrl,
    previewAnimation: nextAnimation,
    jobPreviewFrames: nextFrames,
  };
}

export function clearJobEntry(
  state: JobClearState,
  jobId: string,
): GenerationStorePatch {
  revokeJobPostprocessPreview(state.jobs.get(jobId));
  const updated = new Map(state.jobs);
  updated.delete(jobId);
  const nextPreviewFrames = new Map(state.jobPreviewFrames);
  nextPreviewFrames.delete(jobId);
  return { jobs: updated, jobPreviewFrames: nextPreviewFrames };
}
