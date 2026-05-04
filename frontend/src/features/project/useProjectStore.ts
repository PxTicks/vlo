import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Project } from "../../types/ProjectState";
import { useTimelineStore } from "../timeline";
import { fileSystemService } from "./services/FileSystemService";
import { projectPersistenceService } from "./services/ProjectPersistenceService";
import { recentProjectsService } from "./services/RecentProjectsService";
import { VLO_APP_VERSION } from "./constants";
import { PROJECT_ASPECT_RATIOS } from "./aspectRatioOptions";
import type { ProjectDocumentConfig } from "./types/ProjectDocument";
import { flushAllBrushMaskCommits } from "../masks/runtime/brushAssetSync";

export type AspectRatio = "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
export type AssetBrowserDisplay = "grouped" | "ungrouped";
export type ProjectFitMode = "contain" | "cover";

export interface ProjectConfig {
  aspectRatio: AspectRatio;
  fps: number;
  fitMode: ProjectFitMode;
  layoutMode?: "full-height" | "compact";
  assetBrowserDisplay: AssetBrowserDisplay;
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  aspectRatio: "16:9",
  fps: 30,
  fitMode: "cover",
  layoutMode: "compact",
  assetBrowserDisplay: "grouped",
};

const VALID_ASPECT_RATIOS = new Set<AspectRatio>(PROJECT_ASPECT_RATIOS);

const VALID_FIT_MODES = new Set<ProjectFitMode>(["contain", "cover"]);
const VALID_LAYOUT_MODES = new Set<NonNullable<ProjectConfig["layoutMode"]>>([
  "full-height",
  "compact",
]);
const VALID_ASSET_BROWSER_DISPLAY_MODES = new Set<AssetBrowserDisplay>([
  "grouped",
  "ungrouped",
]);

const getProjectConfigFromDocument = (
  value: ProjectDocumentConfig | undefined,
): ProjectConfig => {
  const aspectRatio = VALID_ASPECT_RATIOS.has(value?.aspectRatio as AspectRatio)
    ? (value?.aspectRatio as AspectRatio)
    : DEFAULT_PROJECT_CONFIG.aspectRatio;

  const layoutMode = VALID_LAYOUT_MODES.has(
    value?.layoutMode as NonNullable<ProjectConfig["layoutMode"]>,
  )
    ? (value?.layoutMode as NonNullable<ProjectConfig["layoutMode"]>)
    : DEFAULT_PROJECT_CONFIG.layoutMode;

  const fps =
    typeof value?.fps === "number" && Number.isFinite(value.fps) && value.fps > 0
      ? value.fps
      : DEFAULT_PROJECT_CONFIG.fps;

  // Existing projects without fitMode default to "contain" for backwards compat
  const fitMode = VALID_FIT_MODES.has(value?.fitMode as ProjectFitMode)
    ? (value?.fitMode as ProjectFitMode)
    : "contain";

  const assetBrowserDisplay = VALID_ASSET_BROWSER_DISPLAY_MODES.has(
    value?.assetBrowserDisplay as AssetBrowserDisplay,
  )
    ? (value?.assetBrowserDisplay as AssetBrowserDisplay)
    : DEFAULT_PROJECT_CONFIG.assetBrowserDisplay;

  return {
    aspectRatio,
    fps,
    fitMode,
    layoutMode,
    assetBrowserDisplay,
  };
};

const hasProjectConfigChanged = (
  current: ProjectConfig,
  next: ProjectConfig,
): boolean =>
  current.aspectRatio !== next.aspectRatio ||
  current.fps !== next.fps ||
  current.fitMode !== next.fitMode ||
  current.layoutMode !== next.layoutMode ||
  current.assetBrowserDisplay !== next.assetBrowserDisplay;

async function flushOpenProjectPersistence(): Promise<void> {
  await flushAllBrushMaskCommits();
  await useTimelineStore.getState().flushPendingPersistence();
  await projectPersistenceService.flushAll();

  try {
    const { flushAllAssetPersistence } = await import("../userAssets");
    await flushAllAssetPersistence();
  } catch (error) {
    console.warn("Failed to flush pending asset persistence", error);
  }
}

export interface ProjectState {
  project: Project | null;
  rootHandle: FileSystemDirectoryHandle | null;
  config: ProjectConfig;
  createProject: (
    title: string,
    parentHandle: FileSystemDirectoryHandle,
    configOverrides?: Partial<ProjectConfig>,
  ) => Promise<void>;
  loadProject: (handle: FileSystemDirectoryHandle) => Promise<void>;
  updateTitle: (newTitle: string) => Promise<void>;
  updateConfig: (updates: Partial<ProjectConfig>) => Promise<void>;
  assignAssetFolder: (folderPath: string) => void;
  saveProject: () => Promise<string | null>;
  resetProject: () => void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      project: null,
      rootHandle: null,
      config: { ...DEFAULT_PROJECT_CONFIG },

      createProject: async (
        title: string,
        parentHandle: FileSystemDirectoryHandle,
        configOverrides?: Partial<ProjectConfig>,
      ) => {
        try {
          await flushOpenProjectPersistence();

          const exists = await fileSystemService.checkDirectoryExists(
            parentHandle,
            title,
          );
          if (exists) {
            throw new Error(`Project directory "${title}" already exists.`);
          }

          const projectHandle = await parentHandle.getDirectoryHandle(title, {
            create: true,
          });

          fileSystemService.setHandle(projectHandle);
          projectPersistenceService.resetCaches();

          const newProject: Project = {
            id: crypto.randomUUID(),
            title,
            rootAssetsFolder: projectHandle.name,
            createdAt: Date.now(),
            lastModified: Date.now(),
          };

          set({
            project: newProject,
            rootHandle: projectHandle,
            config: { ...DEFAULT_PROJECT_CONFIG, ...configOverrides },
          });

          useTimelineStore.getState().replaceTimelineSnapshot(null);
          const timelineState = useTimelineStore.getState();
          await projectPersistenceService.initializeProjectDocuments({
            id: newProject.id,
            title: newProject.title,
            createdAt: newProject.createdAt,
            config: get().config,
            timeline: {
              tracks: structuredClone(timelineState.tracks),
              clips: structuredClone(timelineState.clips),
            },
          });

          await recentProjectsService.addRecent(
            newProject.id,
            title,
            projectHandle,
          );
        } catch (e) {
          console.error("Failed to create project", e);
          throw e;
        }
      },

      loadProject: async (handle: FileSystemDirectoryHandle) => {
        try {
          await flushOpenProjectPersistence();

          fileSystemService.setHandle(handle);
          projectPersistenceService.resetCaches();

          const loaded = await projectPersistenceService.loadOrMigrateProject();
          const data = loaded.manifest;
          const projectId = data?.id;
          const projectTitle = data?.title;
          const projectCreatedAt = data?.created_at;
          const projectConfig = getProjectConfigFromDocument(data?.config);

          const hasCoreProjectData =
            typeof projectId === "string" &&
            typeof projectTitle === "string" &&
            typeof projectCreatedAt === "number";

          if (!hasCoreProjectData) {
            const newProject: Project = {
              id: crypto.randomUUID(),
              title: handle.name,
              rootAssetsFolder: handle.name,
              createdAt: Date.now(),
              lastModified: Date.now(),
            };

            set({
              project: newProject,
              rootHandle: handle,
              config: projectConfig,
            });

            useTimelineStore.getState().replaceTimelineSnapshot(null);
            const timelineState = useTimelineStore.getState();
            await projectPersistenceService.initializeProjectDocuments({
              id: newProject.id,
              title: newProject.title,
              createdAt: newProject.createdAt,
              config: projectConfig,
              timeline: {
                tracks: structuredClone(timelineState.tracks),
                clips: structuredClone(timelineState.clips),
              },
            });

            const { scanForNewAssets } = await import("../userAssets");
            await scanForNewAssets();

            await recentProjectsService.addRecent(
              newProject.id,
              newProject.title,
              handle,
            );
            return;
          }

          set({
            project: {
              id: projectId,
              title: projectTitle,
              createdAt: projectCreatedAt,
              lastModified: data?.last_modified || Date.now(),
              rootAssetsFolder: handle.name,
            },
            rootHandle: handle,
            config: projectConfig,
          });

          const timeline = loaded.timeline
            ? {
                tracks: loaded.timeline.tracks,
                clips: loaded.timeline.clips,
              }
            : null;
          useTimelineStore.getState().replaceTimelineSnapshot(timeline);

          await recentProjectsService.addRecent(projectId, projectTitle, handle);
        } catch (e) {
          console.error("Failed to load project", e);
          throw e;
        }
      },

      updateTitle: async (newTitle: string) => {
        const { project, saveProject } = get();
        if (!project) return;

        set((state) => ({
          project: state.project ? { ...state.project, title: newTitle } : null,
        }));

        await saveProject();
      },

      updateConfig: async (updates) => {
        const currentConfig = get().config;
        const nextConfig = { ...currentConfig, ...updates };

        if (!hasProjectConfigChanged(currentConfig, nextConfig)) {
          return;
        }

        set({ config: nextConfig });

        if (!get().project) {
          return;
        }

        await get().saveProject();
      },

      assignAssetFolder: (folderPath) =>
        set((state) => ({
          project: state.project
            ? { ...state.project, rootAssetsFolder: folderPath }
            : null,
        })),

      saveProject: async () => {
        const { project, config } = get();
        if (!project) return null;

        try {
          await flushOpenProjectPersistence();

          await projectPersistenceService.updateManifest((draft) => {
            draft.id = project.id;
            draft.title = project.title;
            draft.created_at = project.createdAt;
            draft.lastSavedWithVloVersion = VLO_APP_VERSION;
            draft.config = structuredClone(config);
          });

          return project.id;
        } catch (e) {
          console.error("Failed to save project manifest", e);
          return null;
        }
      },

      resetProject: () => {
        projectPersistenceService.resetCaches();
        useTimelineStore.getState().replaceTimelineSnapshot(null);
        set({ project: null, rootHandle: null, config: { ...DEFAULT_PROJECT_CONFIG } });
      },
    }),
    {
      name: "vid-editor-active-project",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        project: state.project,
        config: state.config,
      }),
    },
  ),
);
