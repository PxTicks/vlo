import type { Asset } from "../../../types/Asset";
import type { AssetFamily } from "../../../types/Asset";
import type {
  TimelineClip,
  TimelineGroup,
  TimelineTrack,
} from "../../../types/TimelineTypes";

export interface TimelineSnapshot {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  /**
   * Optional in the snapshot type so legacy in-memory snapshots and test
   * fixtures that predate render groups continue to type-check. Persisted
   * documents always carry `groups: []` once schema-migrated; the store's
   * migrateTimelineSnapshot adapter normalises missing values to `[]`.
   */
  groups?: TimelineGroup[];
}

export interface ProjectDocumentConfig {
  aspectRatio?: "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
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
  timeline?: TimelineSnapshot;
  [key: string]: unknown;
}

export type {
  AssetIndexDocument,
  AssetMetadataDocument,
  LegacyProjectDocument,
  PersistedAssetIndexEntry,
  ProjectManifestDocument,
  TimelineDocument,
} from "../schemas/projectPersistenceSchemas";
