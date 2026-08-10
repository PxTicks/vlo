/**
 * What an editor surface needs from the editor around it.
 *
 * The player asks for nothing, but the timeline needs the scroll container the
 * editor's drag coordinators measure against and the clip overlays assembled
 * from every feature that contributes one. Both are live per-render values, so
 * they reach the surface through this context rather than being frozen into a
 * module-scope registration.
 */
import { createContext, useContext, type RefObject } from "react";
import type { TimelineClipOverlayDefinition } from "../../features/timeline";

export interface EditorStageServices {
  /** Timeline scroll container, shared with the editor's drag coordinators. */
  readonly scrollContainerRef: RefObject<HTMLDivElement | null>;
  readonly clipOverlays: readonly TimelineClipOverlayDefinition[];
}

export const EditorStageServicesContext =
  createContext<EditorStageServices | null>(null);

export function useEditorStageServices(): EditorStageServices {
  const services = useContext(EditorStageServicesContext);
  if (!services) {
    throw new Error(
      "Editor stage surfaces must render inside EditorStageServicesContext.",
    );
  }
  return services;
}
