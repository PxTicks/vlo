import { waitForAssetsPersistence } from "../../userAssets";
import type { GenerationDeliveryWebSocket } from "../services/GenerationDeliveryWebSocket";
import {
  fetchDeliveryFileAsFile,
  type GenerationDeliveryFileRef,
  type GenerationDeliveryManifest,
  type GenerationDeliveryMessage,
} from "../services/generationDeliveryApi";
import { frontendPostprocess } from "../utils/pipeline";
import type { GenerationJob } from "../types";
import { applyPreviewUpdate, setJobPostprocessResult } from "./jobMutations";
import { isGenerationInterruptionMessage } from "./constants";
import type {
  GenerationStoreGet,
  GenerationStorePatch,
  GenerationStoreSet,
} from "./types";

function toJobStatus(
  deliveryStatus: GenerationDeliveryManifest["status"],
): GenerationJob["status"] {
  if (deliveryStatus === "error") {
    return "error";
  }
  if (deliveryStatus === "completed_pending_ack") {
    return "completed";
  }
  return deliveryStatus;
}

// The backend can only stamp the manifest with metadata it derives from the
// current request's pipeline_outputs. On cached preprocess runs, mask_crop is
// inactive so the manifest is missing maskCropMetadata / generationMaskAssetId.
// Merge instead of replacing so values the frontend already populated at
// submission time (via mergeCachedPipelineOutputsIntoResponse) are kept.
function mergeGenerationMetadata(
  existing: GenerationJob["generationMetadata"] | undefined,
  fromManifest: GenerationJob["generationMetadata"] | undefined,
): GenerationJob["generationMetadata"] | undefined {
  if (!existing) return fromManifest;
  if (!fromManifest) return existing;
  return { ...existing, ...fromManifest };
}

function buildJobFromDelivery(
  manifest: GenerationDeliveryManifest,
  existingJob: GenerationJob | undefined,
): GenerationJob | null {
  if (!manifest.prompt_id) {
    return null;
  }
  if (
    existingJob?.status === "error" &&
    isGenerationInterruptionMessage(existingJob.error)
  ) {
    return {
      ...existingJob,
      deliveryId: manifest.delivery_id,
    };
  }

  return {
    ...(existingJob ?? {
      id: manifest.prompt_id,
      status: "queued",
      progress: 0,
      currentNode: null,
      outputs: [],
      error: null,
      submittedAt: manifest.submitted_at ?? Date.now(),
      completedAt: null,
      postprocessedPreview: null,
      postprocessError: null,
      usesSaveImageWebsocketOutputs: false,
    }),
    id: manifest.prompt_id,
    deliveryId: manifest.delivery_id,
    status: toJobStatus(manifest.status),
    progress:
      typeof manifest.progress === "number"
        ? manifest.progress
        : manifest.status === "completed_pending_ack"
          ? 100
          : existingJob?.progress ?? 0,
    currentNode:
      typeof manifest.current_node === "string" ? manifest.current_node : null,
    outputs: Array.isArray(manifest.outputs)
      ? manifest.outputs
      : existingJob?.outputs ?? [],
    error: typeof manifest.error === "string" ? manifest.error : null,
    submittedAt: manifest.submitted_at ?? existingJob?.submittedAt ?? Date.now(),
    completedAt:
      manifest.completed_at ??
      (manifest.status === "completed_pending_ack" || manifest.status === "error"
        ? Date.now()
        : existingJob?.completedAt ?? null),
    postprocessConfig:
      manifest.postprocess_config ?? existingJob?.postprocessConfig,
    aspectRatioProcessing:
      manifest.aspect_ratio_processing ?? existingJob?.aspectRatioProcessing ?? null,
    generationMetadata: mergeGenerationMetadata(
      existingJob?.generationMetadata,
      manifest.generation_metadata,
    ),
    autoFamilyRequestKey:
      manifest.auto_family_request_key ??
      existingJob?.autoFamilyRequestKey ??
      null,
    usesSaveImageWebsocketOutputs:
      manifest.uses_save_image_websocket_outputs ??
      existingJob?.usesSaveImageWebsocketOutputs ??
      false,
    saveImageWebsocketNodeIds: existingJob?.saveImageWebsocketNodeIds,
    preparedMaskFile: existingJob?.preparedMaskFile ?? null,
  };
}

function compactPreviewFrameFiles(frameFiles: File[] | undefined): File[] {
  return (frameFiles ?? []).filter((file): file is File => file instanceof File);
}

function compareDeliveryPreviewFrames(
  left: GenerationDeliveryFileRef,
  right: GenerationDeliveryFileRef,
): number {
  const leftIndex =
    typeof left.frame_index === "number" ? left.frame_index : Number.MAX_SAFE_INTEGER;
  const rightIndex =
    typeof right.frame_index === "number" ? right.frame_index : Number.MAX_SAFE_INTEGER;
  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  return left.filename.localeCompare(right.filename);
}

async function fetchDeliveryPreviewFrameFiles(
  previewFrames: GenerationDeliveryFileRef[],
): Promise<File[]> {
  const files: File[] = [];
  for (const previewFrame of [...previewFrames].sort(compareDeliveryPreviewFrames)) {
    const file = await fetchDeliveryFileAsFile(previewFrame);
    if (file) {
      files.push(file);
    }
  }
  return files;
}

export function attachDeliveryClientHandlers(
  client: GenerationDeliveryWebSocket,
  set: GenerationStoreSet,
  get: GenerationStoreGet,
): void {
  const ackingDeliveryIds = new Set<string>();
  let hasActiveLease = false;

  async function acknowledgeDeliveryOnce(
    manifest: GenerationDeliveryManifest,
  ): Promise<void> {
    if (ackingDeliveryIds.has(manifest.delivery_id)) {
      return;
    }
    ackingDeliveryIds.add(manifest.delivery_id);
    client.acknowledgeDelivery(manifest.delivery_id);
  }

  async function rejectCompletedDelivery(
    manifest: GenerationDeliveryManifest,
    errorMessage: string,
  ): Promise<void> {
    client.rejectDelivery(manifest.delivery_id, errorMessage);
  }

  async function processCompletedDelivery(
    manifest: GenerationDeliveryManifest,
  ): Promise<void> {
    if (!manifest.prompt_id) {
      return;
    }
    const existingJob = get().jobs.get(manifest.prompt_id);
    if (existingJob?.deliveryId === manifest.delivery_id) {
      if (
        Array.isArray(existingJob.importedAssetIds) &&
        existingJob.importedAssetIds.length > 0 &&
        !existingJob.postprocessError
      ) {
        await acknowledgeDeliveryOnce(manifest);
        return;
      }
      if (get().postprocessingJobIds.includes(manifest.prompt_id)) {
        return;
      }
      if (existingJob.postprocessError && existingJob.importedAssetIds?.length) {
        await rejectCompletedDelivery(manifest, existingJob.postprocessError);
        return;
      }
    }

    set((state) => {
      if (state.postprocessingJobIds.includes(manifest.prompt_id!)) {
        return {};
      }
      return {
        postprocessingJobIds: [...state.postprocessingJobIds, manifest.prompt_id!],
      };
    });

    // Pull from the merged job state, not raw manifest, so frontend-side
    // metadata (e.g. maskCropMetadata recovered from preprocess cache) isn't
    // dropped on cached gens where the manifest is missing those fields.
    const mergedGenerationMetadata = mergeGenerationMetadata(
      get().jobs.get(manifest.prompt_id)?.generationMetadata,
      manifest.generation_metadata,
    );
    if (!mergedGenerationMetadata) {
      await rejectCompletedDelivery(manifest, "Missing generation metadata");
      return;
    }

    const generationMetadata = structuredClone(mergedGenerationMetadata);
    let importedAssetIds: string[] | undefined;
    let previewFrameFiles: File[] = [];

    try {
      const preparedMaskFile = await fetchDeliveryFileAsFile(
        manifest.prepared_mask ?? null,
      );
      const cachedPreviewFrameFiles = compactPreviewFrameFiles(
        get().jobPreviewFrames.get(manifest.prompt_id),
      );
      const heldPreviewFrames = Array.isArray(manifest.preview_frames)
        ? manifest.preview_frames
        : [];
      previewFrameFiles =
        heldPreviewFrames.length === 0 ||
        cachedPreviewFrameFiles.length >= heldPreviewFrames.length
          ? cachedPreviewFrameFiles
          : await fetchDeliveryPreviewFrameFiles(heldPreviewFrames);

      const postprocessResult = await frontendPostprocess(manifest.outputs, {
        postprocessing: manifest.postprocess_config ?? undefined,
        aspectRatioProcessing: manifest.aspect_ratio_processing ?? null,
        generationMetadata,
        autoFamilyRequestKey: manifest.auto_family_request_key ?? null,
        previewFrameFiles,
        preparedMaskFile: preparedMaskFile ?? undefined,
      });
      importedAssetIds = postprocessResult.importedAssetIds;

      const persistedAssetIds = [...postprocessResult.importedAssetIds];
      if (
        typeof generationMetadata.generationMaskAssetId === "string" &&
        generationMetadata.generationMaskAssetId.length > 0
      ) {
        persistedAssetIds.push(generationMetadata.generationMaskAssetId);
      }
      await waitForAssetsPersistence(persistedAssetIds);

      set((state) => {
        const basePatch = setJobPostprocessResult(state, manifest.prompt_id!, {
          postprocessedPreview: postprocessResult.postprocessedPreview,
          postprocessError: postprocessResult.postprocessError,
          importedAssetIds: postprocessResult.importedAssetIds,
        });
        const nextJobs = new Map(basePatch.jobs ?? state.jobs);
        const currentJob = nextJobs.get(manifest.prompt_id!);
        if (currentJob) {
          nextJobs.set(manifest.prompt_id!, {
            ...currentJob,
            generationMetadata,
          });
        }
        const nextPreviewFrames = new Map(basePatch.jobPreviewFrames ?? state.jobPreviewFrames);
        nextPreviewFrames.delete(manifest.prompt_id!);
        return {
          ...basePatch,
          jobs: nextJobs,
          jobPreviewFrames: nextPreviewFrames,
          postprocessingJobIds: state.postprocessingJobIds.filter(
            (jobId) => jobId !== manifest.prompt_id,
          ),
        };
      });
      await acknowledgeDeliveryOnce(manifest);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Held delivery ingestion failed unexpectedly";
      set((state) => {
        const basePatch = setJobPostprocessResult(state, manifest.prompt_id!, {
          postprocessedPreview: null,
          postprocessError: message,
          ...(importedAssetIds ? { importedAssetIds } : {}),
        });
        const nextPreviewFrames = new Map(basePatch.jobPreviewFrames ?? state.jobPreviewFrames);
        nextPreviewFrames.delete(manifest.prompt_id!);
        return {
          ...basePatch,
          jobPreviewFrames: nextPreviewFrames,
          postprocessingJobIds: state.postprocessingJobIds.filter(
            (jobId) => jobId !== manifest.prompt_id,
          ),
        };
      });
      await rejectCompletedDelivery(manifest, message);
    }
  }

  function applyDeliveryUpdate(manifest: GenerationDeliveryManifest): void {
    if (!manifest.prompt_id) {
      return;
    }
    const existingJob = get().jobs.get(manifest.prompt_id);
    const shouldIgnoreTerminalInterruptedDelivery =
      existingJob?.status === "error" &&
      isGenerationInterruptionMessage(existingJob.error) &&
      (manifest.status === "completed_pending_ack" ||
        manifest.status === "error");

    set((state) => {
      const existingJob = state.jobs.get(manifest.prompt_id!);
      const nextJob = buildJobFromDelivery(manifest, existingJob);
      if (!nextJob) {
        return {};
      }

      const nextJobs = new Map(state.jobs);
      nextJobs.set(manifest.prompt_id!, nextJob);

      const patch: GenerationStorePatch = {
        jobs: nextJobs,
      };
      if (nextJob.status === "queued" || nextJob.status === "running") {
        patch.activeJobId = manifest.prompt_id!;
      } else if (state.activeJobId === manifest.prompt_id) {
        patch.activeJobId = null;
      }
      return patch;
    });

    if (
      manifest.status === "completed_pending_ack" ||
      manifest.status === "error"
    ) {
      void get().processGenerationQueue();
    }

    if (shouldIgnoreTerminalInterruptedDelivery) {
      void acknowledgeDeliveryOnce(manifest);
      return;
    }

    if (manifest.status === "completed_pending_ack") {
      void processCompletedDelivery(manifest);
    } else if (manifest.status === "error") {
      void acknowledgeDeliveryOnce(manifest);
    }
  }

  client.onMessage((message: GenerationDeliveryMessage) => {
    switch (message.type) {
      case "lease_state": {
        hasActiveLease = message.data.active;
        if (!hasActiveLease) {
          ackingDeliveryIds.clear();
        }
        break;
      }
      case "snapshot": {
        if (!hasActiveLease) {
          return;
        }
        for (const delivery of message.data.deliveries) {
          if (
            delivery.status === "error" &&
            delivery.prompt_id &&
            !get().jobs.has(delivery.prompt_id)
          ) {
            void acknowledgeDeliveryOnce(delivery);
            continue;
          }
          applyDeliveryUpdate(delivery);
        }
        break;
      }
      case "delivery_update": {
        if (!hasActiveLease) {
          return;
        }
        applyDeliveryUpdate(message.data.delivery);
        break;
      }
      case "delivery_removed": {
        ackingDeliveryIds.delete(message.data.delivery_id);
        break;
      }
    }
  });

  client.onPreview((preview) => {
    set((state) => applyPreviewUpdate(state, preview));
  });

  client.onConnectionChange((connectionState) => {
    set({
      deliveryConnectionStatus:
        connectionState === "connected" ? "connected" : "disconnected",
    });
    if (connectionState === "disconnected") {
      ackingDeliveryIds.clear();
      hasActiveLease = false;
    }
  });
}
