export { ProjectManager } from "./components/ProjectManager";
export { ProjectTitle } from "./components/ProjectTitle";
export { useProjectStore } from "./useProjectStore";
export { fileSystemService } from "./services/FileSystemService";
export { projectDocumentService } from "./services/ProjectDocumentService";
export { PROJECT_ASPECT_RATIOS } from "./aspectRatioOptions";
export type {
  ProjectState,
  ProjectConfig,
  AspectRatio,
  AssetBrowserDisplay,
  ProjectFitMode,
} from "./useProjectStore";
export type { ProjectDocument, TimelineSnapshot } from "./types/ProjectDocument";
