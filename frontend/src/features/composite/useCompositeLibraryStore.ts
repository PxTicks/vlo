import { create } from "zustand";
import type {
  CompositeAsset,
  CompositeContent,
} from "../../types/TimelineTypes";
import { isCompositeClip } from "../../types/TimelineTypes";
import { projectPersistenceService } from "../project";
import { useProjectStore } from "../project/useProjectStore";
import {
  deleteAsset,
  getAssetById,
  getAssets,
  waitForAssetPersistence,
} from "../userAssets";
import {
  getTimelineClips,
  getTimelineCompositePlacementIds,
  insertTimelineBaseClipAtTime,
  syncTimelineCompositePlacementRevision,
  removeTimelineClips,
} from "../timeline/api";
import type {
  CompositeBakeRequest,
  CompositeBakeQueueCallbacks,
} from "./services/CompositeBakeQueue";
import { compositeBakeQueue } from "./services/CompositeBakeQueue";
import type { BakedComposite } from "./services/bakeComposite";
import { waitForCompositeSourcePresentation } from "./services/CompositeSourcePresentationService";
import {
  beginCompositeRender,
  endCompositeRender,
  setCompositeBakeRuntimeStatus,
  useCompositeRenderStatusStore,
} from "./useCompositeRenderStatusStore";
import { createCompositeBaseClipFromAsset } from "./utils/createCompositeClip";
import {
  INITIAL_COMPOSITE_REVISION,
  resolveCompositeBakeValidity,
  resolveCompositeRevision,
} from "./utils/compositeBakeValidity";
import { contentContainsComposite } from "./utils/compositeReferences";
import {
  createCompositeBakeKey,
  serializeCompositeBakeKey,
} from "./utils/compositeRenderContract";

interface CompositeBrowserRevealRequest {
  compositeAssetId: string;
  requestId: number;
}

interface CreateCompositeAssetInput {
  id?: string;
  name?: string;
  content: CompositeContent;
  signal?: AbortSignal;
  onProgress?: (percentage: number) => void;
}

interface UpdateCompositeAssetContentInput {
  content: CompositeContent;
  signal?: AbortSignal;
  onProgress?: (percentage: number) => void;
}

interface CompositeLibraryState {
  composites: CompositeAsset[];
  isLoading: boolean;
  selectedCompositeIds: string[];
  revealRequest: CompositeBrowserRevealRequest | null;
  fetchComposites: () => Promise<void>;
  createCompositeAsset: (
    input: CreateCompositeAssetInput,
  ) => Promise<CompositeAsset>;
  updateCompositeAssetContent: (
    compositeAssetId: string,
    input: UpdateCompositeAssetContentInput,
  ) => Promise<CompositeAsset | null>;
  retryCompositeBake: (compositeAssetId: string) => Promise<boolean>;
  renameCompositeAsset: (
    compositeAssetId: string,
    name: string,
  ) => Promise<void>;
  deleteCompositeAsset: (compositeAssetId: string) => Promise<void>;
  placeCompositeAssetAtTime: (
    compositeAssetId: string,
    startTick: number,
  ) => string | null;
  selectComposite: (compositeAssetId: string | null, isMulti?: boolean) => void;
  setSelectedCompositeIds: (compositeAssetIds: string[]) => void;
  clearSelection: () => void;
  revealCompositeInBrowser: (compositeAssetId: string) => void;
  clearRevealRequest: (requestId: number) => void;
}

let compositeMutationTail = Promise.resolve();

async function runCompositeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = compositeMutationTail;
  let release: () => void = () => undefined;
  compositeMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    await previous.catch(() => undefined);
    return await operation();
  } finally {
    release();
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hasIdenticalCompositeContent(
  left: CompositeContent,
  right: CompositeContent,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortComposites(composites: readonly CompositeAsset[]): CompositeAsset[] {
  return [...composites].sort((left, right) => {
    const updatedDelta = right.updatedAt - left.updatedAt;
    if (updatedDelta !== 0) return updatedDelta;
    return left.name.localeCompare(right.name);
  });
}

function toCompositeRecord(
  composites: readonly CompositeAsset[],
): Record<string, CompositeAsset> {
  return Object.fromEntries(
    composites.map((composite) => [composite.id, clone(composite)]),
  );
}

async function persistComposites(
  composites: readonly CompositeAsset[],
): Promise<void> {
  await projectPersistenceService.updateCompositeLibrary((draft) => {
    draft.composites = toCompositeRecord(composites);
  });
}

function getCompositeOrThrow(
  composites: readonly CompositeAsset[],
  compositeAssetId: string,
): CompositeAsset {
  const composite = composites.find(
    (candidate) => candidate.id === compositeAssetId,
  );
  if (!composite) {
    throw new Error(`Composite '${compositeAssetId}' was not found.`);
  }
  return composite;
}

function getPlacementIdsForComposite(compositeAssetId: string): string[] {
  return getTimelineCompositePlacementIds([compositeAssetId]);
}

async function deleteBakedAsset(assetId: string | undefined): Promise<void> {
  if (!assetId) {
    return;
  }

  try {
    await deleteAsset(assetId, { cleanupMode: "immediate" });
  } catch (error) {
    console.warn(
      `[CompositeLibrary] Failed to delete composite bake '${assetId}'`,
      error,
    );
  }
}

function getPublishedBakeAssetId(composite: CompositeAsset): string | undefined {
  return composite.bake?.assetId ?? composite.bakedAssetId;
}

function isBakeAssetReferenced(assetId: string): boolean {
  const placementOwnsAsset = getTimelineClips().some(
    (clip) =>
      !isCompositeClip(clip) && "assetId" in clip && clip.assetId === assetId,
  );
  if (placementOwnsAsset) {
    return true;
  }
  return useCompositeLibraryStore
    .getState()
    .composites.some(
      (composite) => getPublishedBakeAssetId(composite) === assetId,
    );
}

async function retireBakeAssetWhenUnowned(
  assetId: string | undefined,
  replacement?: {
    compositeId: string;
    revision: number;
    assetId: string;
  },
): Promise<void> {
  if (!assetId || isBakeAssetReferenced(assetId)) {
    return;
  }
  if (replacement && getPlacementIdsForComposite(replacement.compositeId).length > 0) {
    const presented = await waitForCompositeSourcePresentation(replacement);
    if (!presented) {
      // Retaining an orphaned cache is safer than revoking a decoder source
      // before a slow replacement frame reaches the GPU. Project cleanup can
      // collect it later.
      return;
    }
  }
  if (!isBakeAssetReferenced(assetId)) {
    await deleteBakedAsset(assetId);
  }
}

function getSafeBakeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "Composite bake failed.";
}

function isValidProducedBake(
  request: CompositeBakeRequest,
  result: BakedComposite,
): boolean {
  const registered = getAssetById(result.asset.id);
  const metadata = registered?.creationMetadata;
  return Boolean(
    registered &&
      registered.type === "video" &&
      typeof registered.duration === "number" &&
      Number.isFinite(registered.duration) &&
      registered.duration > 0 &&
      result.bakeKey === request.requestedKey &&
      metadata?.source === "composite" &&
      metadata.compositeAssetId === request.compositeId &&
      metadata.compositeRevision === request.revision &&
      metadata.bakeKey === request.requestedKey &&
      (registered.src || registered.sourcePath || registered.file),
  );
}

async function createRequestedBakeKey(
  content: CompositeContent,
): Promise<string> {
  const { getProjectDimensions } = await import("../renderer/utils/dimensions");
  const project = useProjectStore.getState();
  return serializeCompositeBakeKey(
    createCompositeBakeKey({
      content,
      projectFps: project.config.fps,
      logicalDimensions: getProjectDimensions(project.config.aspectRatio),
      assets: getAssets(),
    }),
  );
}

function matchesBakeRequest(
  composite: CompositeAsset | undefined,
  request: CompositeBakeRequest,
): composite is CompositeAsset {
  return Boolean(
    composite &&
      resolveCompositeRevision(composite) === request.revision &&
      composite.bake?.requestedKey === request.requestedKey,
  );
}

const bakeQueueCallbacks: CompositeBakeQueueCallbacks = {
  onStarted: async (request) => {
    beginCompositeRender(request.compositeId);
    setCompositeBakeRuntimeStatus(request.compositeId, {
      status: "rendering",
      progress: 0,
      revision: request.revision,
      requestedKey: request.requestedKey,
    });
    await runCompositeMutation(async () => {
      const currentComposites = useCompositeLibraryStore.getState().composites;
      const current = currentComposites.find(
        (candidate) => candidate.id === request.compositeId,
      );
      if (!matchesBakeRequest(current, request)) {
        return;
      }
      const next = sortComposites(
        currentComposites.map((candidate) =>
          candidate.id === request.compositeId
            ? {
                ...candidate,
                bake: {
                  ...candidate.bake,
                  status: "rendering" as const,
                  requestedKey: request.requestedKey,
                  error: undefined,
                  updatedAt: Date.now(),
                },
              }
            : candidate,
        ),
      );
      await persistComposites(next);
      useCompositeLibraryStore.setState({ composites: next });
    });
  },
  onProgress: (request, percentage) => {
    setCompositeBakeRuntimeStatus(request.compositeId, {
      status: "rendering",
      progress: Math.max(0, Math.min(100, percentage)),
      revision: request.revision,
      requestedKey: request.requestedKey,
    });
  },
  onCompleted: async (request, result) => {
    await waitForAssetPersistence(result.asset.id);
    if (!isValidProducedBake(request, result)) {
      throw new Error("The produced composite cache failed validation.");
    }

    let previousBakeAssetId: string | undefined;
    let didPublish = false;
    await runCompositeMutation(async () => {
      const currentComposites = useCompositeLibraryStore.getState().composites;
      const current = currentComposites.find(
        (candidate) => candidate.id === request.compositeId,
      );
      if (
        useProjectStore.getState().project?.id !== request.projectId ||
        !matchesBakeRequest(current, request) ||
        result.bakeKey !== request.requestedKey
      ) {
        return;
      }

      previousBakeAssetId = getPublishedBakeAssetId(current);
      const updatedAt = Date.now();
      const ready: CompositeAsset = {
        ...current,
        bake: {
          status: "ready",
          requestedKey: request.requestedKey,
          readyKey: request.requestedKey,
          readyRevision: request.revision,
          assetId: result.asset.id,
          updatedAt,
        },
        bakedAssetId: result.asset.id,
        updatedAt,
      };
      const next = sortComposites(
        currentComposites.map((candidate) =>
          candidate.id === request.compositeId ? ready : candidate,
        ),
      );

      await persistComposites(next);
      useCompositeLibraryStore.setState({ composites: next });
      didPublish = true;
    });

    if (!didPublish) {
      await deleteBakedAsset(result.asset.id);
      return;
    }

    setCompositeBakeRuntimeStatus(request.compositeId, null);
    endCompositeRender(request.compositeId);
    if (previousBakeAssetId !== result.asset.id) {
      await retireBakeAssetWhenUnowned(previousBakeAssetId, {
        compositeId: request.compositeId,
        revision: request.revision,
        assetId: result.asset.id,
      });
    }
  },
  onFailed: async (request, error) => {
    await runCompositeMutation(async () => {
      const currentComposites = useCompositeLibraryStore.getState().composites;
      const current = currentComposites.find(
        (candidate) => candidate.id === request.compositeId,
      );
      if (!matchesBakeRequest(current, request)) {
        return;
      }
      const next = sortComposites(
        currentComposites.map((candidate) =>
          candidate.id === request.compositeId
            ? {
                ...candidate,
                bake: {
                  ...candidate.bake,
                  status: "failed" as const,
                  requestedKey: request.requestedKey,
                  error: getSafeBakeError(error),
                  updatedAt: Date.now(),
                },
              }
            : candidate,
        ),
      );
      await persistComposites(next);
      useCompositeLibraryStore.setState({ composites: next });
    });
    setCompositeBakeRuntimeStatus(request.compositeId, null);
    endCompositeRender(request.compositeId);
  },
  onCancelled: (request) => {
    const runtime = useCompositeRenderStatusStore
      .getState()
      .bakeStatusByCompositeId.get(request.compositeId);
    if (
      runtime?.revision === request.revision &&
      runtime.requestedKey === request.requestedKey
    ) {
      setCompositeBakeRuntimeStatus(request.compositeId, null);
      endCompositeRender(request.compositeId);
    }
  },
  disposeResult: async (result) => {
    await deleteBakedAsset(result.asset.id);
  },
};

function enqueueCompositeBake(
  composite: CompositeAsset,
  requestedKey: string,
  options: Pick<CreateCompositeAssetInput, "signal" | "onProgress"> = {},
): void {
  const revision = resolveCompositeRevision(composite);
  setCompositeBakeRuntimeStatus(composite.id, {
    status: "queued",
    progress: 0,
    revision,
    requestedKey,
  });
  compositeBakeQueue.enqueue(
    {
      compositeId: composite.id,
      projectId: useProjectStore.getState().project?.id ?? null,
      revision,
      requestedKey,
      content: composite.content,
      signal: options.signal,
      onProgress: options.onProgress,
    },
    bakeQueueCallbacks,
  );
}

async function queueCurrentCompositeBake(
  compositeAssetId: string,
): Promise<boolean> {
  const current = useCompositeLibraryStore
    .getState()
    .composites.find((candidate) => candidate.id === compositeAssetId);
  if (!current) {
    return false;
  }
  const requestedKey = await createRequestedBakeKey(current.content);
  let queued: CompositeAsset | null = null;
  await runCompositeMutation(async () => {
    const currentComposites = useCompositeLibraryStore.getState().composites;
    const latest = currentComposites.find(
      (candidate) => candidate.id === compositeAssetId,
    );
    if (
      !latest ||
      resolveCompositeRevision(latest) !== resolveCompositeRevision(current)
    ) {
      return;
    }
    const updated: CompositeAsset = {
      ...latest,
      bake: {
        ...latest.bake,
        status: "queued",
        requestedKey,
        error: undefined,
        updatedAt: Date.now(),
      },
    };
    const next = sortComposites(
      currentComposites.map((candidate) =>
        candidate.id === compositeAssetId ? updated : candidate,
      ),
    );
    await persistComposites(next);
    useCompositeLibraryStore.setState({ composites: next });
    queued = updated;
  });
  if (!queued) {
    return false;
  }
  enqueueCompositeBake(queued, requestedKey);
  return true;
}

export const useCompositeLibraryStore = create<CompositeLibraryState>(
  (set, get) => ({
    composites: [],
    isLoading: false,
    selectedCompositeIds: [],
    revealRequest: null,

    fetchComposites: async () => {
      set({ isLoading: true });
      try {
        const document = await projectPersistenceService.readCompositeLibrary();
        const availableAssetIds = new Set(getAssets().map((asset) => asset.id));
        const normalized: CompositeAsset[] = [];
        const toQueue: Array<{
          composite: CompositeAsset;
          requestedKey: string;
        }> = [];

        for (const persisted of Object.values(document.composites)) {
          const composite = clone(persisted);
          const requestedKey = await createRequestedBakeKey(composite.content);
          const validity = resolveCompositeBakeValidity({
            composite,
            expectedBakeKey: requestedKey,
            availableAssetIds,
          });
          const interrupted =
            composite.bake?.status === "queued" ||
            composite.bake?.status === "rendering";
          const staleFailure =
            composite.bake?.status === "failed" &&
            composite.bake.requestedKey !== requestedKey;
          if (
            !validity.valid &&
            (interrupted ||
              staleFailure ||
              composite.bake?.status !== "failed")
          ) {
            composite.bake = {
              ...composite.bake,
              status: "queued",
              requestedKey,
              error: undefined,
              updatedAt: Date.now(),
            };
            toQueue.push({ composite, requestedKey });
          }
          normalized.push(composite);
        }

        const next = sortComposites(normalized);
        if (toQueue.length > 0) {
          await persistComposites(next);
        }
        set({ composites: next });
        for (const queued of toQueue) {
          enqueueCompositeBake(queued.composite, queued.requestedKey);
        }
      } finally {
        set({ isLoading: false });
      }
    },

    createCompositeAsset: async (input) => {
      const id = input.id ?? `composite_${crypto.randomUUID()}`;
      const content = clone(input.content);
      if (contentContainsComposite(content)) {
        throw new Error("Composites cannot contain other composites.");
      }
      const requestedKey = await createRequestedBakeKey(content);
      const now = Date.now();
      const composite: CompositeAsset = {
        id,
        name: input.name?.trim() || "Composite",
        content,
        revision: INITIAL_COMPOSITE_REVISION,
        bake: {
          status: "queued",
          requestedKey,
          updatedAt: now,
        },
        createdAt: now,
        updatedAt: now,
      };

      await runCompositeMutation(async () => {
        const currentComposites = get().composites;
        if (currentComposites.some((candidate) => candidate.id === id)) {
          throw new Error(`Composite '${id}' already exists.`);
        }
        const next = sortComposites([...currentComposites, composite]);
        await persistComposites(next);
        set({ composites: next });
      });
      enqueueCompositeBake(composite, requestedKey, input);
      return composite;
    },

    updateCompositeAssetContent: async (compositeAssetId, input) => {
      const content = clone(input.content);
      if (contentContainsComposite(content)) {
        throw new Error("Composites cannot contain other composites.");
      }
      const initial = get().composites.find(
        (candidate) => candidate.id === compositeAssetId,
      );
      if (!initial) return null;
      if (hasIdenticalCompositeContent(initial.content, content)) {
        return initial;
      }
      const requestedKey = await createRequestedBakeKey(content);
      let updated: CompositeAsset | null = null;
      let didChange = false;

      await runCompositeMutation(async () => {
        const currentComposites = get().composites;
        const existing = currentComposites.find(
          (candidate) => candidate.id === compositeAssetId,
        );
        if (!existing) {
          return;
        }
        if (hasIdenticalCompositeContent(existing.content, content)) {
          updated = existing;
          return;
        }
        const revision = resolveCompositeRevision(existing) + 1;
        const updatedAt = Date.now();
        updated = {
          ...existing,
          content,
          revision,
          bake: {
            ...existing.bake,
            status: "queued",
            requestedKey,
            error: undefined,
            updatedAt,
          },
          updatedAt,
        };
        const next = sortComposites(
          currentComposites.map((candidate) =>
            candidate.id === compositeAssetId ? updated! : candidate,
          ),
        );
        await persistComposites(next);
        set({ composites: next });

        syncTimelineCompositePlacementRevision(compositeAssetId, revision);
        didChange = true;
      });

      if (updated && didChange) {
        enqueueCompositeBake(updated, requestedKey, input);
      }
      return updated;
    },

    retryCompositeBake: queueCurrentCompositeBake,

    renameCompositeAsset: async (compositeAssetId, name) => {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return;
      }
      await runCompositeMutation(async () => {
        const currentComposites = get().composites;
        getCompositeOrThrow(currentComposites, compositeAssetId);
        const next = sortComposites(
          currentComposites.map((candidate) =>
            candidate.id === compositeAssetId
              ? { ...candidate, name: trimmedName, updatedAt: Date.now() }
              : candidate,
          ),
        );
        await persistComposites(next);
        set({ composites: next });
      });
    },

    deleteCompositeAsset: async (compositeAssetId) => {
      compositeBakeQueue.cancel(compositeAssetId);
      let deleted: CompositeAsset | null = null;
      await runCompositeMutation(async () => {
        const currentComposites = get().composites;
        const composite = currentComposites.find(
          (candidate) => candidate.id === compositeAssetId,
        );
        if (!composite) {
          return;
        }
        const next = currentComposites.filter(
          (candidate) => candidate.id !== compositeAssetId,
        );
        await persistComposites(next);
        set((state) => ({
          composites: sortComposites(next),
          selectedCompositeIds: state.selectedCompositeIds.filter(
            (id) => id !== compositeAssetId,
          ),
        }));
        deleted = composite;
      });
      if (!deleted) {
        return;
      }
      const placementIds = getPlacementIdsForComposite(compositeAssetId);
      if (placementIds.length > 0) {
        removeTimelineClips(placementIds);
      }
      await retireBakeAssetWhenUnowned(getPublishedBakeAssetId(deleted));
    },

    placeCompositeAssetAtTime: (compositeAssetId, startTick) => {
      const composite = get().composites.find(
        (candidate) => candidate.id === compositeAssetId,
      );
      if (!composite) {
        return null;
      }
      return insertTimelineBaseClipAtTime(
        createCompositeBaseClipFromAsset(composite),
        startTick,
      );
    },

    selectComposite: (compositeAssetId, isMulti = false) => {
      set((state) => {
        if (compositeAssetId === null) {
          return { selectedCompositeIds: [] };
        }
        if (isMulti) {
          const isSelected =
            state.selectedCompositeIds.includes(compositeAssetId);
          return {
            selectedCompositeIds: isSelected
              ? state.selectedCompositeIds.filter(
                  (id) => id !== compositeAssetId,
                )
              : [...state.selectedCompositeIds, compositeAssetId],
          };
        }
        return { selectedCompositeIds: [compositeAssetId] };
      });
    },

    setSelectedCompositeIds: (compositeAssetIds) => {
      set({ selectedCompositeIds: [...compositeAssetIds] });
    },

    clearSelection: () => set({ selectedCompositeIds: [] }),

    revealCompositeInBrowser: (compositeAssetId) => {
      set({
        revealRequest: {
          compositeAssetId,
          requestId: Date.now(),
        },
      });
    },

    clearRevealRequest: (requestId) => {
      set((state) =>
        state.revealRequest?.requestId === requestId
          ? { revealRequest: null }
          : state,
      );
    },
  }),
);

export function getCompositeAssets(): CompositeAsset[] {
  return useCompositeLibraryStore.getState().composites;
}

export function getCompositeAssetById(
  compositeAssetId: string | null | undefined,
): CompositeAsset | undefined {
  if (!compositeAssetId) {
    return undefined;
  }
  return useCompositeLibraryStore
    .getState()
    .composites.find((composite) => composite.id === compositeAssetId);
}

export function revealCompositeInBrowser(compositeAssetId: string): void {
  useCompositeLibraryStore
    .getState()
    .revealCompositeInBrowser(compositeAssetId);
}

export async function retryCompositeBake(
  compositeAssetId: string,
): Promise<boolean> {
  return useCompositeLibraryStore
    .getState()
    .retryCompositeBake(compositeAssetId);
}
