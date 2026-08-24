import type { Asset } from "../../../types/Asset";
import type { AssetFamily } from "../../../types/Asset";
import type {
  CompositeAsset,
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../../types/TimelineTypes";

export interface TimelineSnapshot {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  transitions?: Transition[];
}

export interface ProjectDocumentConfig {
  aspectRatio?: "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
  /**
   * Short edge in pixels. Absent in projects saved before it existed, and
   * intentionally untyped by the `ProjectOutputResolution` union: this is the
   * on-disk shape, which may carry a rung written by a different vlo version.
   * vlo only ever writes a supported rung; the loader narrows what it reads.
   */
  outputResolution?: number;
  fps?: number;
  fitMode?: "contain" | "cover";
  layoutMode?: "full-height" | "compact";
  assetBrowserDisplay?: "grouped" | "ungrouped";
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
  assetFamilies?: Record<string, AssetFamily>;
  composites?: Record<string, CompositeAsset>;
  timeline?: TimelineSnapshot;
  [key: string]: unknown;
}

export type {
  AssetIndexDocument,
  AssetMetadataDocument,
  CompositeLibraryDocument,
  LegacyProjectDocument,
  PersistedAssetIndexEntry,
  ProjectManifestDocument,
  TimelineDocument,
} from "../schemas/projectPersistenceSchemas";
