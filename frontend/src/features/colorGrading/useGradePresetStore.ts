import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  GradeParameterJson,
  GradeTimeRange,
} from "./gradeParameters";

export interface GradePreset {
  readonly id: string;
  readonly name: string;
  readonly parameters: GradeParameterJson;
  readonly sourceTimeRange?: GradeTimeRange;
  readonly createdAt: number;
}

interface GradePresetState {
  presets: GradePreset[];
  savePreset(
    name: string,
    parameters: GradeParameterJson,
    sourceTimeRange?: GradeTimeRange,
  ): void;
  removePreset(id: string): void;
}

export const BUILT_IN_GRADE_PRESETS: readonly GradePreset[] = [
  {
    id: "builtin-filmic",
    name: "Filmic soft contrast",
    createdAt: 0,
    parameters: {
      contrast: 1.08,
      kneeThreshold: 1,
      kneeSoftness: 0.16,
      toeAmount: 0.1,
      toeSoftness: 0.16,
      saturation: 0.96,
    },
  },
  {
    id: "builtin-warm",
    name: "Warm natural",
    createdAt: 0,
    parameters: { temperature: 14, tint: 2, saturation: 1.04 },
  },
];

export const useGradePresetStore = create<GradePresetState>()(
  persist(
    (set) => ({
      presets: [],
      savePreset: (name, parameters, sourceTimeRange) =>
        set((state) => ({
          presets: [
            ...state.presets,
            {
              id: crypto.randomUUID(),
              name: name.trim(),
              parameters,
              ...(sourceTimeRange ? { sourceTimeRange } : {}),
              createdAt: Date.now(),
            },
          ],
        })),
      removePreset: (id) =>
        set((state) => ({
          presets: state.presets.filter((preset) => preset.id !== id),
        })),
    }),
    { name: "vlo-color-grade-presets" },
  ),
);
