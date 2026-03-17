import { create } from "zustand";

interface ActiveSplineContext {
  clipId: string;
  transformId: string;
  property: string; // e.g. "x", "factor", "opacity"
}

export interface ActiveSectionContext {
  clipId: string;
  sectionId: string;
}

interface TransformationViewState {
  activeSpline: ActiveSplineContext | null;
  activeSection: ActiveSectionContext | null;

  setActiveSpline: (context: ActiveSplineContext | null) => void;
  setActiveSection: (context: ActiveSectionContext | null) => void;
}

export const useTransformationViewStore = create<TransformationViewState>(
  (set) => ({
    activeSpline: null,
    activeSection: null,
    setActiveSpline: (context) => set({ activeSpline: context }),
    setActiveSection: (context) => set({ activeSection: context }),
  }),
);
