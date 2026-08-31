import { create } from "zustand";

/**
 * Slots whose value is still being produced, before that value exists.
 *
 * A timeline selection confirmed from a media slot spends seconds rendering
 * its thumbnail and its video before `setMediaInputTimelineSelection` puts
 * anything in the store, and a frame capture the same before the frame lands.
 * `isExtracting` on the value cannot cover that window — there is no value to
 * carry it yet — so the panel marks the slot here for the whole operation and
 * the slot renders its `preparing` status throughout.
 */
export interface MediaInputPreparationState {
  preparingInputIds: ReadonlySet<string>;
  beginMediaInputPreparation: (inputId: string) => void;
  endMediaInputPreparation: (inputId: string) => void;
}

const EMPTY_PREPARING_INPUT_IDS: ReadonlySet<string> = new Set<string>();

export const useMediaInputPreparationStore = create<MediaInputPreparationState>(
  (set) => ({
    preparingInputIds: EMPTY_PREPARING_INPUT_IDS,
    beginMediaInputPreparation: (inputId) =>
      set((state) => {
        if (state.preparingInputIds.has(inputId)) return {};
        const next = new Set(state.preparingInputIds);
        next.add(inputId);
        return { preparingInputIds: next };
      }),
    endMediaInputPreparation: (inputId) =>
      set((state) => {
        if (!state.preparingInputIds.has(inputId)) return {};
        const next = new Set(state.preparingInputIds);
        next.delete(inputId);
        return {
          preparingInputIds: next.size > 0 ? next : EMPTY_PREPARING_INPUT_IDS,
        };
      }),
  }),
);
