export { ProjectManager } from "./components/ProjectManager";
export { ProjectTitle } from "./components/ProjectTitle";
export { useProjectStore } from "./useProjectStore";
export { fileSystemService } from "./services/FileSystemService";
export { projectDocumentService } from "./services/ProjectDocumentService";
export {
  projectPersistenceService,
  prepareAssetForPersistence,
} from "./services/ProjectPersistenceService";
export {
  projectTrashService,
  PROJECT_TRASH_LIMIT_BYTES,
} from "./services/ProjectTrashService";
export { PROJECT_ASPECT_RATIOS } from "./aspectRatioOptions";
export type {
  ProjectState,
  ProjectConfig,
  AspectRatio,
  AssetBrowserDisplay,
  ProjectFitMode,
  ProjectTimelineSnapshotRequest,
} from "./useProjectStore";
export type {
  AssetIndexDocument,
  AssetMetadataDocument,
  CompositeLibraryDocument,
  PersistedAssetIndexEntry,
  ProjectDocument,
  ProjectManifestDocument,
  TimelineDocument,
  TimelineSnapshot,
} from "./types/ProjectDocument";
