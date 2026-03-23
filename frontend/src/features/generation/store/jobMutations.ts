import type { ComfyUIPreview } from "../services/ComfyUIWebSocket";
import type { GenerationJob, GenerationJobOutput } from "../types";
import {
  getPreviewFrameExtension,
  getPreviewFrameIndex,
  replacePreviewAnimation,
  revokeJobPostprocessPreview,
  revokePreviewAnimation,
} from "./previewState";
import type {
  ComfyUIConnectionStatus,
  GenerationStore,
  GenerationStorePatch,
  PostprocessResultPatch,
  PreviewAnimation,
} from "./types";

export function isActiveGenerationJob(
  job: GenerationJob | null | undefined,
): boolean {
  return job?.status === "queued" || job?.status === "running";
}

export function markJobError(
  state: GenerationStore,
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
  state: GenerationStore,
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
  state: GenerationStore,
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

export function completeGenerationJob(
  state: GenerationStore,
  promptId: string,
  outputsOverride?: GenerationJob["outputs"],
): { patch: GenerationStorePatch; completedJob: GenerationJob | null } {
  const currentJob = state.jobs.get(promptId);
  if (!currentJob) {
    return { patch: {}, completedJob: null };
  }

  const completedJob: GenerationJob = {
    ...currentJob,
    status: "completed",
    progress: 100,
    currentNode: null,
    completedAt: Date.now(),
    outputs: outputsOverride ?? currentJob.outputs,
  };

  const updated = new Map(state.jobs);
  updated.set(promptId, completedJob);
  revokePreviewAnimation(state.previewAnimation);

  return {
    patch: {
      jobs: updated,
      previewAnimation: null,
      ...(state.activeJobId === promptId ? { activeJobId: null } : {}),
    },
    completedJob,
  };
}

export function applyJobProgress(
  state: GenerationStore,
  promptId: string,
  progress: number,
  currentNode: string,
): GenerationStorePatch {
  const job = state.jobs.get(promptId);
  if (!job) return {};

  const updated = new Map(state.jobs);
  updated.set(promptId, {
    ...job,
    status: "running",
    progress,
    currentNode,
  });
  return { jobs: updated, activeJobId: promptId };
}

export function applyExecutingNode(
  state: GenerationStore,
  promptId: string,
  currentNode: string,
): GenerationStorePatch {
  const job = state.jobs.get(promptId);
  if (!job) return {};

  const updated = new Map(state.jobs);
  updated.set(promptId, {
    ...job,
    status: "running",
    currentNode,
  });
  return { jobs: updated, activeJobId: promptId };
}

export function appendJobOutputs(
  state: GenerationStore,
  promptId: string,
  newOutputs: GenerationJobOutput[],
): GenerationStorePatch {
  const job = state.jobs.get(promptId);
  if (!job || newOutputs.length === 0) return {};

  const updated = new Map(state.jobs);
  updated.set(promptId, {
    ...job,
    outputs: [...job.outputs, ...newOutputs],
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

export function applyPreviewUpdate(
  state: GenerationStore,
  preview: ComfyUIPreview,
): GenerationStorePatch {
  if (state.latestPreviewUrl) {
    URL.revokeObjectURL(state.latestPreviewUrl);
  }
  const nextPreviewUrl = URL.createObjectURL(preview.blob);
  const nextAnimation = buildNextAnimation(state.previewAnimation, preview);

  const activeJobId = state.activeJobId;
  if (!activeJobId) {
    return {
      latestPreviewUrl: nextPreviewUrl,
      previewAnimation: nextAnimation,
    };
  }

  const activeJob = state.jobs.get(activeJobId);
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
  state: GenerationStore,
  jobId: string,
): GenerationStorePatch {
  revokeJobPostprocessPreview(state.jobs.get(jobId));
  const updated = new Map(state.jobs);
  updated.delete(jobId);
  const nextPreviewFrames = new Map(state.jobPreviewFrames);
  nextPreviewFrames.delete(jobId);
  return { jobs: updated, jobPreviewFrames: nextPreviewFrames };
}
