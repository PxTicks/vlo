import { create } from "zustand";
import type {
  CompositeAsset,
  CompositeContent,
} from "../../types/TimelineTypes";
import { isCompositeClip } from "../../types/TimelineTypes";
import { projectPersistenceService } from "../project";
import { deleteAsset } from "../userAssets";
import { insertBaseClipAtTime } from "../timeline/utils/insertAssetToTimeline";
import { useTimelineStore } from "../timeline/useTimelineStore";
import { bakeComposite } from "./services/bakeComposite";
import {
  beginCompositeRender,
  endCompositeRender,
} from "./useCompositeRenderStatusStore";
import { createCompositeBaseClipFromAsset } from "./utils/createCompositeClip";
import { contentContainsComposite } from "./utils/compositeReferences";

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

function clone<T>(value: T): T {
  return structuredClone(value);
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
  return useTimelineStore
    .getState()
    .clips.filter(
      (clip) => isCompositeClip(clip) && clip.compositeId === compositeAssetId,
    )
    .map((clip) => clip.id);
}

async function deleteBakedAsset(assetId: string | undefined): Promise<void> {
  if (!assetId) {
    return;
  }

  try {
    await deleteAsset(assetId);
  } catch (error) {
    console.warn(
      `[CompositeLibrary] Failed to delete old composite bake '${assetId}'`,
      error,
    );
  }
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
        set({
          composites: sortComposites(Object.values(document.composites)),
        });
      } finally {
        set({ isLoading: false });
      }
    },

    createCompositeAsset: async (input) => {
      const id = input.id ?? `composite_${crypto.randomUUID()}`;
      const now = Date.now();
      const content = clone(input.content);
      const currentComposites = get().composites;

      if (contentContainsComposite(content)) {
        throw new Error("Composites cannot contain other composites.");
      }

      beginCompositeRender(id);
      const { asset } = await bakeComposite(content, {
        signal: input.signal,
        onProgress: input.onProgress,
        compositeAssetId: id,
      }).finally(() => endCompositeRender(id));

      const composite: CompositeAsset = {
        id,
        name: input.name?.trim() || "Composite",
        content,
        bakedAssetId: asset.id,
        createdAt: now,
        updatedAt: now,
      };
      const nextComposites = sortComposites([...currentComposites, composite]);

      try {
        await persistComposites(nextComposites);
      } catch (error) {
        await deleteBakedAsset(asset.id);
        throw error;
      }

      set({ composites: nextComposites });
      return composite;
    },

    updateCompositeAssetContent: async (compositeAssetId, input) => {
      const currentComposites = get().composites;
      const existing = currentComposites.find(
        (candidate) => candidate.id === compositeAssetId,
      );
      if (!existing) {
        return null;
      }

      const content = clone(input.content);
      if (contentContainsComposite(content)) {
        throw new Error("Composites cannot contain other composites.");
      }

      beginCompositeRender(compositeAssetId);
      const { asset, bakedDurationTicks } = await bakeComposite(content, {
        signal: input.signal,
        onProgress: input.onProgress,
        compositeAssetId,
      }).finally(() => endCompositeRender(compositeAssetId));

      const updated: CompositeAsset = {
        ...existing,
        content,
        bakedAssetId: asset.id,
        updatedAt: Date.now(),
      };
      const nextComposites = sortComposites(
        currentComposites.map((candidate) =>
          candidate.id === compositeAssetId ? updated : candidate,
        ),
      );

      try {
        await persistComposites(nextComposites);
      } catch (error) {
        await deleteBakedAsset(asset.id);
        throw error;
      }

      set({ composites: nextComposites });
      // Repoint every placement at the fresh bake so the edit shows everywhere,
      // then drop the now-unreferenced previous bake.
      useTimelineStore
        .getState()
        .relinkCompositePlacements(
          compositeAssetId,
          asset.id,
          bakedDurationTicks,
        );
      if (existing.bakedAssetId && existing.bakedAssetId !== asset.id) {
        await deleteBakedAsset(existing.bakedAssetId);
      }
      return updated;
    },

    renameCompositeAsset: async (compositeAssetId, name) => {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return;
      }

      const currentComposites = get().composites;
      getCompositeOrThrow(currentComposites, compositeAssetId);
      const nextComposites = sortComposites(
        currentComposites.map((candidate) =>
          candidate.id === compositeAssetId
            ? { ...candidate, name: trimmedName, updatedAt: Date.now() }
            : candidate,
        ),
      );
      await persistComposites(nextComposites);
      set({ composites: nextComposites });
    },

    deleteCompositeAsset: async (compositeAssetId) => {
      const currentComposites = get().composites;
      const composite = currentComposites.find(
        (candidate) => candidate.id === compositeAssetId,
      );
      if (!composite) {
        return;
      }

      const nextComposites = currentComposites.filter(
        (candidate) => candidate.id !== compositeAssetId,
      );
      await persistComposites(nextComposites);
      set((state) => ({
        composites: sortComposites(nextComposites),
        selectedCompositeIds: state.selectedCompositeIds.filter(
          (id) => id !== compositeAssetId,
        ),
      }));

      const placementIds = getPlacementIdsForComposite(compositeAssetId);
      if (placementIds.length > 0) {
        useTimelineStore.getState().removeClips(placementIds);
      }
      await deleteBakedAsset(composite.bakedAssetId);
    },

    placeCompositeAssetAtTime: (compositeAssetId, startTick) => {
      const composite = get().composites.find(
        (candidate) => candidate.id === compositeAssetId,
      );
      if (!composite) {
        return null;
      }

      return insertBaseClipAtTime(
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
