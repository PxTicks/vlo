export { ProjectManager } from "./components/ProjectManager";
export { ProjectTitle } from "./components/ProjectTitle";
export { useProjectStore } from "./useProjectStore";
export { fileSystemService } from "./services/FileSystemService";
export { projectDocumentService } from "./services/ProjectDocumentService";
export {
  projectPersistenceService,
  prepareAssetForPersistence,
} from "./services/ProjectPersistenceService";
export { PROJECT_ASPECT_RATIOS } from "./aspectRatioOptions";
export type {
  ProjectState,
  ProjectConfig,
  AspectRatio,
  AssetBrowserDisplay,
  ProjectFitMode,
} from "./useProjectStore";
export type {
  AssetIndexDocument,
  AssetMetadataDocument,
  PersistedAssetIndexEntry,
  ProjectDocument,
  ProjectManifestDocument,
  TimelineDocument,
  TimelineSnapshot,
} from "./types/ProjectDocument";
