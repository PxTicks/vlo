import type { Asset } from "../../../types/Asset";
import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";

export interface TimelineSnapshot {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
}

export interface ProjectDocumentConfig {
  aspectRatio?: "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
  fps?: number;
  layoutMode?: "full-height" | "compact";
}

export interface ProjectDocument {
  id?: string;
  title?: string;
  version?: string;
  schemaVersion?: number;
  createdWithVloVersion?: string;
  lastSavedWithVloVersion?: string;
  created_at?: number;
  last_modified?: number;
  config?: ProjectDocumentConfig;
  assets?: Record<string, Asset>;
  timeline?: TimelineSnapshot;
  [key: string]: unknown;
}
