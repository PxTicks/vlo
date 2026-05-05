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

export interface ArmedPathRecordingContext {
  clipId: string;
  transformId: string | null;
}

export interface ActivePathEditorContext {
  clipId: string;
  transformId: string;
}

interface TransformationViewState {
  activeSpline: ActiveSplineContext | null;
  activeSection: ActiveSectionContext | null;
  pathPanelView: "home" | "path";
  armedPathRecording: ArmedPathRecordingContext | null;
  activePathEditor: ActivePathEditorContext | null;

  setActiveSpline: (context: ActiveSplineContext | null) => void;
  setActiveSection: (context: ActiveSectionContext | null) => void;
  setPathPanelView: (view: "home" | "path") => void;
  setArmedPathRecording: (
    context: ArmedPathRecordingContext | null,
  ) => void;
  setActivePathEditor: (context: ActivePathEditorContext | null) => void;
}

export const useTransformationViewStore = create<TransformationViewState>(
  (set) => ({
    activeSpline: null,
    activeSection: null,
    pathPanelView: "home",
    armedPathRecording: null,
    activePathEditor: null,
    setActiveSpline: (context) => set({ activeSpline: context }),
    setActiveSection: (context) => set({ activeSection: context }),
    setPathPanelView: (view) => set({ pathPanelView: view }),
    setArmedPathRecording: (context) => set({ armedPathRecording: context }),
    setActivePathEditor: (context) => set({ activePathEditor: context }),
  }),
);
