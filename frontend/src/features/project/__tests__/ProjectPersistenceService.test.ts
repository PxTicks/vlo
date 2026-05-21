import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  projectPersistenceService,
} from "../services/ProjectPersistenceService";
import { fileSystemService } from "../services/FileSystemService";
import { PROJECT_MANIFEST_SCHEMA_VERSION } from "../constants";
import { isSafeProjectRelativePath } from "../schemas/projectPersistenceSchemas";

vi.mock("../services/FileSystemService", () => ({
  fileSystemService: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
  },
}));

describe("ProjectPersistenceService", () => {
  let files: Map<string, string>;

  const manifest = {
    documentType: "vlo.project",
    schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
    id: "project-1",
    title: "Split Project",
    created_at: 1000,
    last_modified: 1000,
    config: {},
    files: {
      timeline: "timeline.json",
      assets: "assets.json",
      assetMetadataDir: "asset-metadata",
    },
  };

  const timeline = {
    documentType: "vlo.timeline",
    schemaVersion: 1,
    updated_at: 1000,
    tracks: [
      {
        id: "track-1",
        label: "Track 1",
        isVisible: true,
        isMuted: false,
        isLocked: false,
      },
    ],
    clips: [],
  };

  const assetIndex = {
    documentType: "vlo.assets",
    schemaVersion: 1,
    updated_at: 1000,
    assets: {},
    assetFamilies: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    projectPersistenceService.resetCaches();
    files = new Map<string, string>();

    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return { text: async () => content };
    });

    (fileSystemService.writeFile as Mock).mockImplementation(
      async (path: string, content: string) => {
        files.set(path, content);
      },
    );

    (fileSystemService.deleteFile as Mock).mockImplementation(async (path: string) => {
      files.delete(path);
    });
  });

  it("loads a split v3 project without rewriting files", async () => {
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(".vloproject/timeline.json", JSON.stringify(timeline));
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    const loaded = await projectPersistenceService.loadOrMigrateProject();

    expect(loaded.manifest?.id).toBe("project-1");
    expect(loaded.timeline?.tracks).toHaveLength(1);
    expect(loaded.assetIndex?.assets).toEqual({});
    expect(loaded.migrated).toBe(false);
    expect(fileSystemService.writeFile).not.toHaveBeenCalled();
  });

  it("preserves position path data when loading a split project", async () => {
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(
      ".vloproject/timeline.json",
      JSON.stringify({
        ...timeline,
        clips: [
          {
            id: "clip-1",
            trackId: "track-1",
            type: "video",
            name: "Path Clip",
            sourceDuration: 100,
            transformedDuration: 100,
            transformedOffset: 0,
            timelineDuration: 100,
            croppedSourceDuration: 100,
            offset: 0,
            start: 0,
            transformations: [
              {
                id: "position_1",
                type: "position",
                isEnabled: true,
                parameters: {
                  x: 12,
                  y: 34,
                  path: {
                    type: "path2d",
                    curve: "centripetal_catmull_rom",
                    controlPoints: [
                      { x: 0, y: 0 },
                      { x: 100, y: 50 },
                    ],
                    timing: {
                      type: "spline",
                      points: [
                        { time: 0, value: 0 },
                        { time: 1, value: 1 },
                      ],
                    },
                  },
                },
              },
            ],
          },
        ],
      }),
    );
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    const loaded = await projectPersistenceService.loadOrMigrateProject();
    const loadedPath =
      loaded.timeline?.clips[0]?.transformations[0]?.parameters?.path;

    expect(loadedPath).toEqual({
      type: "path2d",
      curve: "centripetal_catmull_rom",
      controlPoints: [
        { x: 0, y: 0 },
        { x: 100, y: 50 },
      ],
      timing: {
        type: "spline",
        points: [
          { time: 0, value: 0 },
          { time: 1, value: 1 },
        ],
      },
    });
    expect(fileSystemService.writeFile).not.toHaveBeenCalled();
  });

  it("loads composite clips from a split timeline document", async () => {
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(
      ".vloproject/timeline.json",
      JSON.stringify({
        ...timeline,
        clips: [
          {
            id: "composite-1",
            trackId: "track-1",
            type: "composite",
            name: "Composite",
            sourceDuration: 100,
            transformedDuration: 100,
            transformedOffset: 0,
            timelineDuration: 100,
            croppedSourceDuration: 100,
            offset: 0,
            start: 0,
            transformations: [],
            content: {
              durationTicks: 100,
              clips: [
                {
                  id: "nested-clip",
                  trackId: "track-1",
                  type: "video",
                  name: "Nested",
                  assetId: "asset-1",
                  sourceDuration: 100,
                  transformedDuration: 100,
                  transformedOffset: 0,
                  timelineDuration: 100,
                  croppedSourceDuration: 100,
                  offset: 0,
                  start: 0,
                  transformations: [],
                },
              ],
            },
            proxyAssetId: "proxy-1",
            proxyContentHash: "hash-1",
          },
        ],
      }),
    );
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    const loaded = await projectPersistenceService.loadOrMigrateProject();

    expect(loaded.timeline?.clips[0]?.type).toBe("composite");
    expect(fileSystemService.writeFile).not.toHaveBeenCalled();
  });

  it("sidecars composite proxy timeline metadata when persisting assets", async () => {
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    await projectPersistenceService.persistAssetEntry({
      id: "proxy-1",
      hash: "hash-proxy-1",
      name: "composite.mp4",
      type: "video",
      src: "composite.mp4",
      createdAt: 1,
      creationMetadata: {
        source: "composite",
        compositeClipId: "clip-composite-1",
        contentHash: "content-hash-1",
        timelineSelection: {
          start: 0,
          end: 100,
          clips: [],
        },
      },
    });

    const persistedAssets = JSON.parse(
      files.get(".vloproject/assets.json") ?? "{}",
    );
    const persistedProxy = persistedAssets.assets["proxy-1"];
    expect(persistedProxy.creationMetadata).toEqual({
      source: "composite",
      compositeClipId: "clip-composite-1",
      contentHash: "content-hash-1",
    });
    expect(persistedProxy.metadataRef).toBe("asset-metadata/proxy-1.json");

    const sidecar = JSON.parse(
      files.get(".vloproject/asset-metadata/proxy-1.json") ?? "{}",
    );
    expect(sidecar.creationMetadata.timelineSelection).toEqual({
      start: 0,
      end: 100,
      clips: [],
    });
  });

  it("rejects an invalid v3 manifest without overwriting files", async () => {
    files.set(
      ".vloproject/project.json",
      JSON.stringify({
        documentType: "vlo.project",
        schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
      }),
    );

    await expect(
      projectPersistenceService.loadOrMigrateProject(),
    ).rejects.toThrow();
    expect(fileSystemService.writeFile).not.toHaveBeenCalled();
  });

  it("migrates legacy projects into split files and sidecars heavy metadata", async () => {
    const legacyProject = {
      id: "legacy-project",
      title: "Legacy Project",
      schemaVersion: 2,
      created_at: 1000,
      config: { fps: 24 },
      timeline: {
        tracks: timeline.tracks,
        clips: [],
      },
      assets: {
        "asset-1": {
          id: "asset-1",
          hash: "hash-1",
          name: "render.mp4",
          type: "video",
          src: "render.mp4",
          createdAt: 1,
          creationMetadata: {
            source: "generated",
            workflowName: "Workflow",
            inputs: [],
            comfyuiPrompt: {
              "1": {
                class_type: "SaveImage",
                inputs: {},
              },
            },
          },
        },
      },
    };
    files.set(".vloproject/project.json", JSON.stringify(legacyProject));

    const loaded = await projectPersistenceService.loadOrMigrateProject();
    const writtenPaths = (fileSystemService.writeFile as Mock).mock.calls.map(
      ([path]) => path,
    );

    expect(loaded.migrated).toBe(true);
    expect(writtenPaths).toEqual([
      ".vloproject/project.legacy-v2.json",
      ".vloproject/asset-metadata/asset-1.json",
      ".vloproject/assets.json",
      ".vloproject/timeline.json",
      ".vloproject/project.json",
    ]);

    const migratedAssets = JSON.parse(files.get(".vloproject/assets.json")!);
    expect(migratedAssets.assets["asset-1"].metadataRef).toBe(
      "asset-metadata/asset-1.json",
    );
    expect(
      migratedAssets.assets["asset-1"].creationMetadata.comfyuiPrompt,
    ).toBeUndefined();

    const sidecar = JSON.parse(
      files.get(".vloproject/asset-metadata/asset-1.json")!,
    );
    expect(sidecar.creationMetadata.comfyuiPrompt).toBeDefined();

    const migratedManifest = JSON.parse(files.get(".vloproject/project.json")!);
    expect(migratedManifest.documentType).toBe("vlo.project");
    expect(migratedManifest.migratedFromSchemaVersion).toBe(2);
  });

  it("returns null for missing asset metadata sidecars", async () => {
    const document = await projectPersistenceService.readAssetMetadata(
      "asset-1",
      "asset-metadata/asset-1.json",
    );

    expect(document).toBeNull();
  });

  it("validates persisted project-relative paths", () => {
    expect(isSafeProjectRelativePath("clip.mp4")).toBe(true);
    expect(isSafeProjectRelativePath(".vloproject/thumbnails/clip.webp")).toBe(
      true,
    );
    expect(isSafeProjectRelativePath("../clip.mp4")).toBe(false);
    expect(isSafeProjectRelativePath("/tmp/clip.mp4")).toBe(false);
    expect(isSafeProjectRelativePath("blob:clip")).toBe(false);
  });
});
