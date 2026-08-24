import type { JsonValue } from "@vlo/extension-sdk";
import {
  hostCommandTable,
  type HostCommandDefinition,
  type HostCommandTable,
} from "../../core/shell/commandTable";
import type { ShellDisposable } from "../../core/shell/hostMenuCatalog";
import {
  useProjectStore,
  type AspectRatio,
  type AssetBrowserDisplay,
  type ProjectFitMode,
} from "./useProjectStore";
import { fileSystemService } from "./services/FileSystemService";
import { recentProjectsService } from "./services/RecentProjectsService";
import { projectPageActions } from "./services/ProjectPageActions";
import { isProjectOutputResolution } from "./outputResolutionOptions";

const ASPECT_RATIOS: readonly AspectRatio[] = [
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
];
const FIT_MODES: readonly ProjectFitMode[] = ["contain", "cover"];
const LAYOUT_MODES = ["full-height", "compact"] as const;
const ASSET_BROWSER_DISPLAYS: readonly AssetBrowserDisplay[] = [
  "grouped",
  "ungrouped",
];

function readSubjectValue(
  subject: JsonValue | undefined,
  field: string,
): JsonValue | undefined {
  if (typeof subject !== "object" || subject === null || Array.isArray(subject)) {
    return undefined;
  }
  return (subject as Record<string, JsonValue>)[field];
}

function pickOption<TOption extends string>(
  value: JsonValue | undefined,
  options: readonly TOption[],
): TOption | null {
  return typeof value === "string" && (options as readonly string[]).includes(value)
    ? (value as TOption)
    : null;
}

/**
 * Project settings as host commands: the settings menu's option items are
 * placements of these with per-option subjects, and future palette or
 * keybinding surfaces project the same table entries. Invalid subjects are
 * no-ops — a settings command never partially applies.
 */
const projectHostCommands: readonly HostCommandDefinition[] = [
  {
    id: "projects.open",
    title: "Open project",
    when: { not: { key: "project.open" } },
    run: async ({ subject }) => {
      const recentId = readSubjectValue(subject, "recentId");
      if (typeof recentId !== "string") return;
      const recent = (await recentProjectsService.getRecents()).find(
        (candidate) => candidate.id === recentId,
      );
      if (!recent) return;
      const permitted = await fileSystemService.verifyPermission(
        recent.handle,
        true,
      );
      if (!permitted) return;
      await useProjectStore.getState().loadProject(recent.handle);
    },
  },
  {
    id: "projects.create",
    title: "Create project",
    when: { not: { key: "project.open" } },
    run: () => {
      projectPageActions.requestCreate();
    },
  },
  {
    id: "project.set-layout",
    title: "Set layout",
    when: { key: "project.open" },
    run: ({ subject }) => {
      const layoutMode = pickOption(
        readSubjectValue(subject, "layoutMode"),
        LAYOUT_MODES,
      );
      if (!layoutMode) return;
      void useProjectStore.getState().updateConfig({ layoutMode });
    },
  },
  {
    id: "project.set-fps",
    title: "Set project FPS",
    when: { key: "project.open" },
    run: ({ subject }) => {
      const fps = readSubjectValue(subject, "fps");
      if (typeof fps !== "number" || !Number.isInteger(fps) || fps <= 0) {
        return;
      }
      void useProjectStore.getState().updateConfig({ fps });
    },
  },
  {
    id: "project.set-aspect-ratio",
    title: "Set aspect ratio",
    when: { key: "project.open" },
    run: ({ subject }) => {
      const aspectRatio = pickOption(
        readSubjectValue(subject, "aspectRatio"),
        ASPECT_RATIOS,
      );
      if (!aspectRatio) return;
      void useProjectStore.getState().updateConfig({ aspectRatio });
    },
  },
  {
    id: "project.set-output-resolution",
    title: "Set output resolution",
    when: { key: "project.open" },
    run: ({ subject }) => {
      const outputResolution = readSubjectValue(subject, "outputResolution");
      if (!isProjectOutputResolution(outputResolution)) return;
      void useProjectStore.getState().updateConfig({ outputResolution });
    },
  },
  {
    id: "project.set-fit-mode",
    title: "Set fit mode",
    when: { key: "project.open" },
    run: ({ subject }) => {
      const fitMode = pickOption(
        readSubjectValue(subject, "fitMode"),
        FIT_MODES,
      );
      if (!fitMode) return;
      void useProjectStore.getState().updateConfig({ fitMode });
    },
  },
  {
    id: "project.set-asset-browser-display",
    title: "Set asset browser display",
    when: { key: "project.open" },
    run: ({ subject }) => {
      const assetBrowserDisplay = pickOption(
        readSubjectValue(subject, "assetBrowserDisplay"),
        ASSET_BROWSER_DISPLAYS,
      );
      if (!assetBrowserDisplay) return;
      void useProjectStore.getState().updateConfig({ assetBrowserDisplay });
    },
  },
];

export function installProjectHostCommands(
  registry: HostCommandTable = hostCommandTable,
): ShellDisposable {
  const registrations = projectHostCommands.map((definition) =>
    registry.registerHostCommand(definition),
  );
  let disposed = false;
  return Object.freeze({
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const registration of [...registrations].reverse()) {
        registration.dispose();
      }
    },
  });
}
