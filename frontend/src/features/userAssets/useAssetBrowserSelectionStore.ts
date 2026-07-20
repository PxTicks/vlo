import { create } from "zustand";

interface AssetBrowserSelectionState {
  selectedAssetIds: string[];
  clearSelection: () => void;
  selectAsset: (assetId: string) => void;
  setSelectedAssetIds: (assetIds: string[]) => void;
  toggleAssetSelection: (assetId: string) => void;
}

export const useAssetBrowserSelectionStore =
  create<AssetBrowserSelectionState>((set) => ({
    selectedAssetIds: [],

    setSelectedAssetIds: (assetIds) => {
      set({ selectedAssetIds: [...assetIds] });
    },

    clearSelection: () => {
      set({ selectedAssetIds: [] });
    },

    selectAsset: (assetId) => {
      set((state) => {
        if (
          state.selectedAssetIds.length === 1 &&
          state.selectedAssetIds[0] === assetId
        ) {
          return state;
        }

        return { selectedAssetIds: [assetId] };
      });
    },

    toggleAssetSelection: (assetId) => {
      set((state) => {
        const isSelected = state.selectedAssetIds.includes(assetId);
        return {
          selectedAssetIds: isSelected
            ? state.selectedAssetIds.filter((id) => id !== assetId)
            : [...state.selectedAssetIds, assetId],
        };
      });
    },
  }));

/** Canonical Zustand identity exposed only through the trusted host directory. */
export function getAssetBrowserSelectionStoreForTrustedHostAccess(): typeof useAssetBrowserSelectionStore {
  return useAssetBrowserSelectionStore;
}
