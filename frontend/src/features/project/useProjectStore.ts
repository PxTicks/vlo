import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Project } from "../../types/ProjectState";
import { useTimelineStore } from "../timeline";
import { fileSystemService } from "./services/FileSystemService";
import { projectDocumentService } from "./services/ProjectDocumentService";
import { recentProjectsService } from "./services/RecentProjectsService";
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  VLO_APP_VERSION,
} from "./constants";
import type {
  ProjectDocumentConfig,
  TimelineSnapshot,
} from "./types/ProjectDocument";

export type AspectRatio = "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

export interface ProjectConfig {
  aspectRatio: AspectRatio;
  fps: number;
  layoutMode?: "full-height" | "compact";
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  aspectRatio: "16:9",
  fps: 30,
  layoutMode: "compact",
};

const VALID_ASPECT_RATIOS = new Set<AspectRatio>([
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
]);

const VALID_LAYOUT_MODES = new Set<NonNullable<ProjectConfig["layoutMode"]>>([
  "full-height",
  "compact",
]);

const isTimelineSnapshot = (value: unknown): value is TimelineSnapshot => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TimelineSnapshot>;
  return Array.isArray(candidate.tracks) && Array.isArray(candidate.clips);
};

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

  return {
    aspectRatio,
    fps,
    layoutMode,
  };
};

const hasProjectConfigChanged = (
  current: ProjectConfig,
  next: ProjectConfig,
): boolean =>
  current.aspectRatio !== next.aspectRatio ||
  current.fps !== next.fps ||
  current.layoutMode !== next.layoutMode;

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
          await useTimelineStore.getState().flushPendingPersistence();

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
          projectDocumentService.resetProjectDocumentCache();

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
          await get().saveProject();

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
          await useTimelineStore.getState().flushPendingPersistence();

          fileSystemService.setHandle(handle);
          projectDocumentService.resetProjectDocumentCache();

          const data = await projectDocumentService.readProjectDocument();
          const projectId = data.id;
          const projectTitle = data.title;
          const projectCreatedAt = data.created_at;
          const projectConfig = getProjectConfigFromDocument(data.config);

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
            await get().saveProject();

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
              lastModified: data.last_modified || Date.now(),
              rootAssetsFolder: handle.name,
            },
            rootHandle: handle,
            config: projectConfig,
          });

          const timeline = isTimelineSnapshot(data.timeline)
            ? data.timeline
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
          const timelineState = useTimelineStore.getState();

          await projectDocumentService.updateProjectDocument((draft) => {
            const hasExistingProjectIdentity =
              typeof draft.id === "string" ||
              typeof draft.title === "string" ||
              typeof draft.created_at === "number";

            draft.id = project.id;
            draft.title = project.title;
            draft.created_at = project.createdAt;
            draft.schemaVersion = CURRENT_PROJECT_SCHEMA_VERSION;
            if (!hasExistingProjectIdentity) {
              draft.createdWithVloVersion = VLO_APP_VERSION;
            }
            draft.lastSavedWithVloVersion = VLO_APP_VERSION;
            draft.config = structuredClone(config);

            if (!isTimelineSnapshot(draft.timeline)) {
              draft.timeline = {
                tracks: structuredClone(timelineState.tracks),
                clips: structuredClone(timelineState.clips),
              };
            }
          });

          return project.id;
        } catch (e) {
          console.error("Failed to save project.json", e);
          return null;
        }
      },

      resetProject: () => {
        projectDocumentService.resetProjectDocumentCache();
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
