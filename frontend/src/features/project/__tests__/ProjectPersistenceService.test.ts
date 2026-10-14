import { makeTimelineSelection } from "../../../testUtils/timelineSelection";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  prepareAssetForPersistence,
  projectPersistenceService,
  ProjectSchemaVersionError,
} from "../services/ProjectPersistenceService";
import { fileSystemService } from "../services/FileSystemService";
import {
  ASSET_METADATA_DOCUMENT_SCHEMA_VERSION,
  COMPOSITE_LIBRARY_DOCUMENT_SCHEMA_VERSION,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  TIMELINE_DOCUMENT_SCHEMA_VERSION,
} from "../constants";
import { isSafeProjectRelativePath } from "../schemas/projectPersistenceSchemas";
import {
  ADJUSTMENT_DEPTH_ALL,
  ADJUSTMENT_RETIMING_RIPPLE,
} from "../../../types/TimelineTypes";
import type { CreationMetadata } from "../../../types/Asset";

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
    schemaVersion: TIMELINE_DOCUMENT_SCHEMA_VERSION,
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

  it("round-trips an unknown extension entity without interpreting its payload", async () => {
    const extensionPayload = {
      extensionId: "example.unavailable",
      typeId: "procedural-shape",
      schemaVersion: 4,
      data: {
        path: [
          { x: 0, y: 0 },
          { x: 0.5, y: 1 },
        ],
        fill: null,
        flags: [true, false],
      },
      assetReferences: ["asset-extension-texture"],
      futureMetadata: { preserve: "verbatim" },
    };
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(
      ".vloproject/timeline.json",
      JSON.stringify({
        ...timeline,
        clips: [
          {
            id: "extension-clip-1",
            trackId: "track-1",
            type: "extension",
            name: "Unavailable procedural shape",
            sourceDuration: null,
            transformedDuration: 120,
            transformedOffset: 0,
            timelineDuration: 120,
            croppedSourceDuration: 120,
            offset: 0,
            start: 15,
            transformations: [],
            extensionPayload,
          },
        ],
      }),
    );
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    const loaded = await projectPersistenceService.loadOrMigrateProject();

    expect(loaded.timeline?.clips[0]).toMatchObject({
      id: "extension-clip-1",
      type: "extension",
      extensionPayload,
    });

    await projectPersistenceService.updateTimeline((draft) => {
      const clip = draft.clips[0];
      if (clip) clip.start = 30;
    });
    const persisted = JSON.parse(
      files.get(".vloproject/timeline.json") ?? "{}",
    );

    expect(persisted.clips[0].start).toBe(30);
    expect(persisted.clips[0].extensionPayload).toEqual(extensionPayload);
  });

  it("round-trips namespaced extension transformation parameters", async () => {
    const extensionTransform = {
      id: "film-grade-1",
      type: "filter",
      filterName: "example.color-grade/film-grade",
      isEnabled: true,
      parameters: { gamma: 1.2, contrast: 1.1, saturation: 0.9 },
    };
    const executableExtensionTransform = {
      id: "offset-x-1",
      type: "example.motion/offset-x",
      isEnabled: true,
      parameters: { amount: 24 },
    };
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(
      ".vloproject/timeline.json",
      JSON.stringify({
        ...timeline,
        clips: [
          {
            id: "video-graded",
            trackId: "track-1",
            type: "video",
            name: "Graded video",
            assetId: "asset-1",
            sourceDuration: 120,
            transformedDuration: 120,
            transformedOffset: 0,
            timelineDuration: 120,
            croppedSourceDuration: 120,
            offset: 0,
            start: 0,
            transformations: [
              extensionTransform,
              executableExtensionTransform,
            ],
          },
        ],
      }),
    );
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    const loaded = await projectPersistenceService.loadOrMigrateProject();
    expect(loaded.timeline?.clips[0]?.transformations[0]).toEqual(
      extensionTransform,
    );
    expect(loaded.timeline?.clips[0]?.transformations[1]).toEqual(
      executableExtensionTransform,
    );

    await projectPersistenceService.updateTimeline((draft) => {
      draft.clips[0]!.transformations[0]!.parameters.gamma = 1.4;
    });
    const persisted = JSON.parse(
      files.get(".vloproject/timeline.json") ?? "{}",
    );
    expect(persisted.clips[0].transformations[0]).toEqual({
      ...extensionTransform,
      parameters: { ...extensionTransform.parameters, gamma: 1.4 },
    });
    expect(persisted.clips[0].transformations[1]).toEqual(
      executableExtensionTransform,
    );
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
            bakedAssetId: "proxy-1",
            bakedContentHash: "hash-1",
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
        timelineSelection: makeTimelineSelection({
          start: 0,
          end: 100,
          clips: [],
        }),
      },
    });

    const persistedAssets = JSON.parse(
      files.get(".vloproject/assets.json") ?? "{}",
    );
    const persistedProxy = persistedAssets.assets["proxy-1"];
    expect(persistedProxy.creationMetadata).toEqual({
      source: "composite",
      compositeClipId: "clip-composite-1",
      timelineSelectionStart: 0,
      contentHash: "content-hash-1",
    });
    expect(persistedProxy.metadataRef).toBe("asset-metadata/proxy-1.json");

    const sidecar = JSON.parse(
      files.get(".vloproject/asset-metadata/proxy-1.json") ?? "{}",
    );
    expect(sidecar.creationMetadata.timelineSelection).toEqual(makeTimelineSelection({
      start: 0,
      end: 100,
      clips: [],
    }));
  });

  it("compacts a legacy index entry on the next unrelated asset edit", async () => {
    // The shape a pre-strip project left on disk: the full selection inline in
    // the index AND in the sidecar. Renaming the asset is enough to shed the
    // index copy, which is how existing projects shrink without a migration.
    const selection = makeTimelineSelection({
      start: 42,
      end: 142,
      clips: [
        {
          id: "legacy-clip",
          trackId: "track-1",
          type: "video" as const,
          name: "Legacy",
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
    });
    const fullMetadata: CreationMetadata = {
      source: "generated",
      workflowName: "Workflow",
      inputs: [
        {
          nodeId: "3", kind: "timelineSelection", timelineSelection: selection,
          miniEditorEdit: { assetId: null, timelineSelection: selection,
            spec: { cropStartTicks: 0, cropEndTicks: 100, ranges: [] } },
        },
      ],
      comfyuiWorkflow: { nodes: [] },
    };

    files.set(
      ".vloproject/assets.json",
      JSON.stringify({
        ...assetIndex,
        assets: {
          "legacy-1": {
            id: "legacy-1",
            hash: "hash-legacy",
            name: "legacy.mp4",
            type: "video",
            src: "legacy.mp4",
            createdAt: 1,
            creationMetadata: fullMetadata,
            metadataRef: "asset-metadata/legacy-1.json",
          },
        },
      }),
    );
    files.set(
      ".vloproject/asset-metadata/legacy-1.json",
      JSON.stringify({
        documentType: "vlo.assetMetadata",
        schemaVersion: ASSET_METADATA_DOCUMENT_SCHEMA_VERSION,
        assetId: "legacy-1",
        updated_at: 1,
        creationMetadata: fullMetadata,
      }),
    );

    await projectPersistenceService.persistAssetEntry({
      id: "legacy-1",
      hash: "hash-legacy",
      name: "renamed.mp4",
      type: "video",
      src: "legacy.mp4",
      createdAt: 1,
      metadataRef: "asset-metadata/legacy-1.json",
      metadataLoaded: false,
      creationMetadata: fullMetadata,
    });

    const persisted = JSON.parse(files.get(".vloproject/assets.json") ?? "{}");
    const entry = persisted.assets["legacy-1"];
    expect(entry.name).toBe("renamed.mp4");
    expect(entry.creationMetadata.inputs).toEqual([
      { nodeId: "3", kind: "timelineSelection", timelineSelectionStart: 42 },
    ]);
    expect(JSON.stringify(entry)).not.toContain("legacy-clip");
    expect(entry.metadataRef).toBe("asset-metadata/legacy-1.json");

    // The sidecar is the payload's only remaining home, so it must be intact.
    const sidecar = JSON.parse(
      files.get(".vloproject/asset-metadata/legacy-1.json") ?? "{}",
    );
    expect(sidecar.creationMetadata.inputs[0].timelineSelection).toEqual(
      selection,
    );
    expect(sidecar.creationMetadata.inputs[0].miniEditorEdit).toEqual({
      assetId: null, timelineSelection: selection,
      spec: { cropStartTicks: 0, cropEndTicks: 100, ranges: [] },
    });
    expect(sidecar.creationMetadata.comfyuiWorkflow).toEqual({ nodes: [] });
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

  it("rejects a newer project manifest schema with an informative error", async () => {
    files.set(
      ".vloproject/project.json",
      JSON.stringify({
        ...manifest,
        schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION + 1,
      }),
    );

    const loadPromise = projectPersistenceService.loadOrMigrateProject();

    await expect(loadPromise).rejects.toThrow(ProjectSchemaVersionError);
    await expect(loadPromise).rejects.toThrow(
      `Project metadata uses schema version ${PROJECT_MANIFEST_SCHEMA_VERSION + 1}, but this build supports up to version ${PROJECT_MANIFEST_SCHEMA_VERSION}.`,
    );
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
      ".vloproject/composites.json",
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

  it("migrates a v1 timeline document forward to the current version", async () => {
    const v1Timeline = {
      documentType: "vlo.timeline",
      schemaVersion: 1,
      updated_at: 1000,
      tracks: timeline.tracks,
      clips: [],
    };
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(".vloproject/timeline.json", JSON.stringify(v1Timeline));
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    const loaded = await projectPersistenceService.loadOrMigrateProject();

    expect(loaded.timeline?.schemaVersion).toBe(TIMELINE_DOCUMENT_SCHEMA_VERSION);
    expect(loaded.timeline?.tracks).toEqual(timeline.tracks);

    const rewrittenTimeline = JSON.parse(
      files.get(".vloproject/timeline.json")!,
    );
    expect(rewrittenTimeline.schemaVersion).toBe(
      TIMELINE_DOCUMENT_SCHEMA_VERSION,
    );
    // v2 has no top-level `groups` field; the migration must not reintroduce it.
    expect(rewrittenTimeline.groups).toBeUndefined();
  });

  it("rejects a newer timeline schema with an informative error", async () => {
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(
      ".vloproject/timeline.json",
      JSON.stringify({
        ...timeline,
        schemaVersion: TIMELINE_DOCUMENT_SCHEMA_VERSION + 1,
      }),
    );
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    const loadPromise = projectPersistenceService.loadOrMigrateProject();

    await expect(loadPromise).rejects.toThrow(ProjectSchemaVersionError);
    await expect(loadPromise).rejects.toThrow(
      `Timeline data uses schema version ${TIMELINE_DOCUMENT_SCHEMA_VERSION + 1}, but this build supports up to version ${TIMELINE_DOCUMENT_SCHEMA_VERSION}.`,
    );
    expect(fileSystemService.writeFile).not.toHaveBeenCalled();
  });

  it("silently drops a stray `groups` field from a stale dev-branch v2 document", async () => {
    // The never-shipped scaffolding branch wrote v2 docs with a top-level
    // groups field. We tolerate that implicitly through Zod's strip-on-parse
    // default — no migration step, no version bump. The field disappears
    // from the in-memory document; the on-disk doc is rewritten without it
    // on the next persistence flush.
    const staleDevTimeline = {
      documentType: "vlo.timeline",
      schemaVersion: TIMELINE_DOCUMENT_SCHEMA_VERSION,
      updated_at: 1000,
      tracks: timeline.tracks,
      clips: [],
      groups: [
        {
          id: "scaffolding-group",
          label: "Scaffolding",
          trackIds: ["track-1"],
          start: 0,
          timelineDuration: 500,
          transformations: [],
          isVisible: true,
        },
      ],
    };
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(".vloproject/timeline.json", JSON.stringify(staleDevTimeline));
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    const loaded = await projectPersistenceService.loadOrMigrateProject();

    expect(loaded.timeline?.schemaVersion).toBe(TIMELINE_DOCUMENT_SCHEMA_VERSION);
    expect(loaded.timeline?.tracks).toEqual(timeline.tracks);
    // groups stripped from the loaded document.
    expect((loaded.timeline as Record<string, unknown> | undefined)?.groups)
      .toBeUndefined();
    // Stale-dev docs aren't a formal migration: no automatic rewrite happens
    // until the user mutates the timeline.
    expect(loaded.migrated).toBe(false);
    expect(fileSystemService.writeFile).not.toHaveBeenCalled();
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

  it("round-trips an adjustment clip with depth and adjustment-type track", async () => {
    const adjustmentTimeline = {
      ...timeline,
      tracks: [
        ...timeline.tracks,
        {
          id: "track-adj",
          type: "adjustment",
          label: "Adjustment Lane",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
      clips: [
        {
          id: "adj-1",
          type: "adjustment",
          trackId: "track-adj",
          name: "Color",
          sourceDuration: 200,
          transformedDuration: 200,
          transformedOffset: 0,
          timelineDuration: 200,
          croppedSourceDuration: 200,
          offset: 0,
          start: 50,
          transformations: [],
          depth: 2,
          retimingMode: ADJUSTMENT_RETIMING_RIPPLE,
        },
      ],
    };
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(".vloproject/timeline.json", JSON.stringify(adjustmentTimeline));
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    const loaded = await projectPersistenceService.loadOrMigrateProject();

    expect(loaded.timeline?.tracks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "track-adj", type: "adjustment" }),
      ]),
    );
    expect(loaded.timeline?.clips).toEqual([
      expect.objectContaining({
        id: "adj-1",
        type: "adjustment",
        depth: 2,
        retimingMode: ADJUSTMENT_RETIMING_RIPPLE,
        trackId: "track-adj",
        sourceDuration: 200,
      }),
    ]);
    expect(loaded.migrated).toBe(false);
    expect(fileSystemService.writeFile).not.toHaveBeenCalled();
  });

  it('round-trips an adjustment clip with the "all" depth sentinel', async () => {
    const adjustmentTimeline = {
      ...timeline,
      tracks: [
        ...timeline.tracks,
        {
          id: "track-adj",
          type: "adjustment",
          label: "Adjustment Lane",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
      clips: [
        {
          id: "adj-1",
          type: "adjustment",
          trackId: "track-adj",
          name: "Color",
          sourceDuration: 200,
          transformedDuration: 200,
          transformedOffset: 0,
          timelineDuration: 200,
          croppedSourceDuration: 200,
          offset: 0,
          start: 50,
          transformations: [],
          depth: ADJUSTMENT_DEPTH_ALL,
        },
      ],
    };
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(".vloproject/timeline.json", JSON.stringify(adjustmentTimeline));
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    const loaded = await projectPersistenceService.loadOrMigrateProject();

    expect(loaded.timeline?.clips).toEqual([
      expect.objectContaining({
        id: "adj-1",
        type: "adjustment",
        depth: ADJUSTMENT_DEPTH_ALL,
      }),
    ]);
    expect(loaded.migrated).toBe(false);
    expect(fileSystemService.writeFile).not.toHaveBeenCalled();
  });

  it("migrates v2 timeline documents forward to the current timeline schema", async () => {
    const v2Timeline = {
      ...timeline,
      schemaVersion: 2,
      tracks: [
        ...timeline.tracks,
        {
          id: "track-adj",
          type: "adjustment",
          label: "Adjustment Lane",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
      clips: [
        {
          id: "adj-1",
          type: "adjustment",
          trackId: "track-adj",
          name: "Color",
          sourceDuration: 200,
          transformedDuration: 200,
          transformedOffset: 0,
          timelineDuration: 200,
          croppedSourceDuration: 200,
          offset: 0,
          start: 50,
          transformations: [],
          depth: 2,
        },
      ],
    };
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(".vloproject/timeline.json", JSON.stringify(v2Timeline));
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    const loaded = await projectPersistenceService.loadOrMigrateProject();

    expect(loaded.timeline?.schemaVersion).toBe(TIMELINE_DOCUMENT_SCHEMA_VERSION);
    expect(JSON.parse(files.get(".vloproject/timeline.json") ?? "{}").schemaVersion)
      .toBe(TIMELINE_DOCUMENT_SCHEMA_VERSION);
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/timeline.json",
      expect.any(String),
    );
  });

  it("normalizes legacy adjustment clips with null sourceDuration before validation", async () => {
    const legacyTimeline = {
      ...timeline,
      tracks: [
        ...timeline.tracks,
        {
          id: "track-adj",
          type: "adjustment",
          label: "Adjustment Lane",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
      clips: [
        {
          id: "adj-1",
          type: "adjustment",
          trackId: "track-adj",
          name: "Legacy Color",
          sourceDuration: null,
          transformedDuration: 200,
          transformedOffset: 0,
          timelineDuration: 200,
          croppedSourceDuration: 200,
          offset: 0,
          start: 50,
          transformations: [],
          depth: 2,
        },
      ],
    };
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(".vloproject/timeline.json", JSON.stringify(legacyTimeline));
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    const loaded = await projectPersistenceService.loadOrMigrateProject();

    expect(loaded.timeline?.clips).toEqual([
      expect.objectContaining({
        id: "adj-1",
        type: "adjustment",
        sourceDuration: 200,
      }),
    ]);
    expect(loaded.migrated).toBe(false);
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/timeline.json",
      expect.any(String),
    );
    expect(
      JSON.parse(files.get(".vloproject/timeline.json") ?? "{}").clips?.[0]
        ?.sourceDuration,
    ).toBe(200);
  });

  it("rejects an adjustment clip missing the required depth field", async () => {
    const invalidTimeline = {
      ...timeline,
      tracks: [
        ...timeline.tracks,
        {
          id: "track-adj",
          type: "adjustment",
          label: "Adjustment Lane",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
      clips: [
        {
          id: "adj-1",
          type: "adjustment",
          trackId: "track-adj",
          name: "Broken",
          sourceDuration: 200,
          transformedDuration: 200,
          transformedOffset: 0,
          timelineDuration: 200,
          croppedSourceDuration: 200,
          offset: 0,
          start: 0,
          transformations: [],
          // depth deliberately omitted
        },
      ],
    };
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(".vloproject/timeline.json", JSON.stringify(invalidTimeline));
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    await expect(
      projectPersistenceService.loadOrMigrateProject(),
    ).rejects.toThrow(/depth/i);
  });

  it("prepares inline, sidecar, and existing metadata references", () => {
    expect(() =>
      prepareAssetForPersistence({
        id: "missing",
        hash: "hash",
        name: "Missing",
        type: "image",
        src: "blob:runtime",
        createdAt: 1,
      }),
    ).toThrow(/missing a persisted source path/);

    const inline = prepareAssetForPersistence({
      id: "inline",
      hash: "hash",
      name: "Inline",
      type: "image",
      src: "runtime",
      thumbnail: "http://remote/thumbnail.png",
      thumbnailPath: "thumb.png",
      proxySrc: "blob:proxy",
      proxyPath: "proxy.mp4",
      createdAt: 1,
      creationMetadata: { source: "uploaded" },
      metadataRef: "asset-metadata/existing.json",
    });
    expect(inline.entry).toMatchObject({
      src: "runtime",
      thumbnail: "thumb.png",
      proxySrc: "proxy.mp4",
      creationMetadata: { source: "uploaded" },
      metadataRef: "asset-metadata/existing.json",
    });
    expect(inline.sidecarMetadata).toBeUndefined();

    const generated = prepareAssetForPersistence({
      id: "generated",
      hash: "hash",
      name: "Generated",
      type: "video",
      src: "https://runtime/video.mp4",
      sourcePath: "video.mp4",
      createdAt: 1,
      creationMetadata: {
        source: "generated",
        workflowName: "Workflow",
        inputs: [],
        replayState: { version: 2 },
      },
    });
    expect(generated.entry.creationMetadata?.source).toBe("generated");
    expect(
      (generated.entry.creationMetadata as { replayState?: unknown })
        .replayState,
    ).toBeUndefined();
    expect(generated.sidecarMetadata).toBeDefined();
    // Replay state alone is not a replayable workflow, so no marker.
    expect(
      (generated.entry.creationMetadata as { replayPayloadInSidecar?: boolean })
        .replayPayloadInSidecar,
    ).toBeUndefined();

    const inEditor = prepareAssetForPersistence({
      id: "in-editor",
      hash: "hash",
      name: "In editor",
      type: "video",
      src: "https://runtime/in-editor.mp4",
      sourcePath: "in-editor.mp4",
      createdAt: 1,
      creationMetadata: {
        source: "generated",
        workflowName: "ComfyUI (in-editor)",
        inputs: [],
        generatedInEditor: true,
        comfyuiPrompt: { "1": { class_type: "KSampler", inputs: {} } },
        comfyuiWorkflow: { nodes: [] },
      },
    });
    expect(inEditor.entry.creationMetadata).toMatchObject({
      workflowName: "ComfyUI (in-editor)",
      generatedInEditor: true,
      replayPayloadInSidecar: true,
    });
    expect(
      (inEditor.entry.creationMetadata as { comfyuiWorkflow?: unknown })
        .comfyuiWorkflow,
    ).toBeUndefined();
    expect(inEditor.sidecarMetadata).toMatchObject({
      comfyuiPrompt: { "1": { class_type: "KSampler", inputs: {} } },
      comfyuiWorkflow: { nodes: [] },
    });

    const lightweightComposite = prepareAssetForPersistence({
      id: "composite",
      hash: "hash",
      name: "Composite",
      type: "video",
      src: "composite.mp4",
      createdAt: 1,
      creationMetadata: { source: "composite" },
    });
    expect(lightweightComposite.sidecarMetadata).toBeUndefined();
  });

  it("strips selection bodies out of the asset index", () => {
    const selection = makeTimelineSelection({
      start: 42,
      end: 142,
      clips: Array.from({ length: 8 }, (_, index) => ({
        id: `clip-${index}`,
        trackId: "track-1",
        type: "video" as const,
        name: `Clip ${index}`,
        assetId: "asset-1",
        sourceDuration: 100,
        transformedDuration: 100,
        transformedOffset: 0,
        timelineDuration: 100,
        croppedSourceDuration: 100,
        offset: 0,
        start: index * 100,
        transformations: [],
      })),
    });

    const generated = prepareAssetForPersistence({
      id: "generated-selection",
      hash: "hash",
      name: "Generated",
      type: "video",
      src: "generated.mp4",
      createdAt: 1,
      creationMetadata: {
        source: "generated",
        workflowName: "Workflow",
        inputs: [
          { nodeId: "3", kind: "timelineSelection", timelineSelection: selection },
          { nodeId: "4", kind: "draggedAsset", parentAssetId: "asset-2" },
        ],
      },
    });

    // The selection body is the single largest thing in a generated entry, so
    // the index keeps only its start and defers the rest to the sidecar.
    expect(generated.entry.creationMetadata).toMatchObject({
      source: "generated",
      inputs: [
        { nodeId: "3", kind: "timelineSelection", timelineSelectionStart: 42 },
        { nodeId: "4", kind: "draggedAsset", parentAssetId: "asset-2" },
      ],
    });
    expect(JSON.stringify(generated.entry)).not.toContain("clip-0");
    expect(generated.sidecarMetadata).toMatchObject({
      inputs: [
        { nodeId: "3", timelineSelection: selection },
        { nodeId: "4", kind: "draggedAsset" },
      ],
    });
    expect(generated.entry.metadataRef).toBe(
      "asset-metadata/generated-selection.json",
    );

    const extracted = prepareAssetForPersistence({
      id: "extracted-selection",
      hash: "hash",
      name: "Extracted",
      type: "audio",
      src: "extracted.wav",
      createdAt: 1,
      creationMetadata: {
        source: "extracted",
        timelineSelection: selection,
        extractedAudioClip: {
          sourceAssetId: "asset-1",
          sourceClipType: "video",
          timelineDuration: 100,
          croppedSourceDuration: 100,
          offset: 0,
          transformedOffset: 0,
          transformations: [],
        },
      },
    });

    expect(extracted.entry.creationMetadata).toMatchObject({
      source: "extracted",
      timelineSelectionStart: 42,
      extractedAudioClip: { sourceAssetId: "asset-1" },
    });
    expect(JSON.stringify(extracted.entry)).not.toContain("clip-0");
    expect(extracted.sidecarMetadata).toMatchObject({
      timelineSelection: selection,
    });
  });

  it("compacts an unhydrated asset's index copy without touching its sidecar", () => {
    // A project written before selections were stripped holds the full body in
    // both places. Re-persisting for an unrelated edit (a rename, a favourite)
    // has to shed the index copy, which is how such projects shrink — but the
    // sidecar is the only surviving home for the payload, so it stays as-is.
    const unhydrated = prepareAssetForPersistence({
      id: "generated-selection",
      hash: "hash",
      name: "Generated",
      type: "video",
      src: "generated.mp4",
      createdAt: 1,
      metadataRef: "asset-metadata/generated-selection.json",
      metadataLoaded: false,
      creationMetadata: {
        source: "generated",
        workflowName: "Workflow",
        inputs: [
          {
            nodeId: "3",
            kind: "timelineSelection",
            timelineSelection: makeTimelineSelection({
              start: 42,
              end: 142,
              clips: [
                {
                  id: "legacy-clip",
                  trackId: "track-1",
                  type: "video",
                  name: "Legacy",
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
            }),
          },
        ],
        replayPayloadInSidecar: true,
      },
    });

    expect(unhydrated.entry.creationMetadata).toMatchObject({
      inputs: [
        { nodeId: "3", kind: "timelineSelection", timelineSelectionStart: 42 },
      ],
    });
    expect(JSON.stringify(unhydrated.entry)).not.toContain("legacy-clip");
    expect(unhydrated.sidecarMetadata).toBeUndefined();
    expect(unhydrated.entry.metadataRef).toBe(
      "asset-metadata/generated-selection.json",
    );
  });

  it("updates cached manifest and timeline documents", async () => {
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(".vloproject/timeline.json", JSON.stringify(timeline));

    const updatedManifest = await projectPersistenceService.updateManifest(
      (draft) => {
        draft.title = "Updated";
      },
    );
    expect(updatedManifest.title).toBe("Updated");
    expect(updatedManifest.lastSavedWithVloVersion).toBeDefined();

    const updatedTimeline = await projectPersistenceService.updateTimeline(
      (draft) => {
        draft.tracks[0]!.label = "Updated Track";
      },
    );
    expect(updatedTimeline.tracks[0]?.label).toBe("Updated Track");

    await projectPersistenceService.applyTimelinePatches(
      [{ op: "replace", path: ["tracks", 0, "label"], value: "Patched" }],
      { tracks: timeline.tracks, clips: [] },
    );
    const patched = await projectPersistenceService.readTimeline();
    expect(patched.tracks[0]?.label).toBe("Patched");
    expect(
      JSON.parse(files.get(".vloproject/timeline.json") as string).tracks[0]
        .label,
    ).toBe("Patched");
  });

  it("falls back to a full timeline snapshot when patches fail", async () => {
    files.set(".vloproject/timeline.json", JSON.stringify(timeline));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fallback = {
      tracks: [{ ...timeline.tracks[0], label: "Fallback" }],
      clips: [],
    };
    await projectPersistenceService.applyTimelinePatches(
      [{ op: "replace", path: ["missing", 0], value: "bad" }],
      fallback,
    );
    const result = await projectPersistenceService.readTimeline();
    expect(result.tracks[0]?.label).toBe("Fallback");
    expect(warning).toHaveBeenCalled();
  });

  it("creates missing asset/composite documents and updates them", async () => {
    const assets = await projectPersistenceService.updateAssetIndex((draft) => {
      draft.assetFamilies.family = {
        id: "family",
        compatibility: {
          assetType: "image",
          durationMs: null,
          fpsMilli: null,
        },
        createdAt: 1,
        updatedAt: 1,
      };
    });
    expect(assets.assetFamilies.family).toBeDefined();

    const emptyComposites =
      await projectPersistenceService.readCompositeLibrary();
    expect(emptyComposites.composites).toEqual({});
    const updatedComposites =
      await projectPersistenceService.updateCompositeLibrary((draft) => {
        draft.composites.example = {
          id: "example",
          name: "Example",
          createdAt: 1,
          updatedAt: 1,
          content: {
            durationTicks: 1,
            clips: [],
            tracks: [],
          },
        };
      });
    expect(updatedComposites.composites.example).toBeDefined();
  });

  it("migrates v1 composite libraries without losing the legacy bake pointer", async () => {
    files.set(
      ".vloproject/composites.json",
      JSON.stringify({
        documentType: "vlo.composites",
        schemaVersion: 1,
        updated_at: 25,
        composites: {
          legacy: {
            id: "legacy",
            name: "Legacy composite",
            content: { durationTicks: 100, clips: [] },
            bakedAssetId: "legacy-bake",
            createdAt: 10,
            updatedAt: 20,
          },
        },
      }),
    );

    const migrated = await projectPersistenceService.readCompositeLibrary();

    expect(migrated).toMatchObject({
      schemaVersion: COMPOSITE_LIBRARY_DOCUMENT_SCHEMA_VERSION,
      composites: {
        legacy: {
          revision: 1,
          bakedAssetId: "legacy-bake",
          bake: {
            status: "ready",
            assetId: "legacy-bake",
            readyRevision: 1,
            updatedAt: 20,
          },
        },
      },
    });
    const persisted = JSON.parse(
      files.get(".vloproject/composites.json") ?? "{}",
    );
    expect(persisted.schemaVersion).toBe(
      COMPOSITE_LIBRARY_DOCUMENT_SCHEMA_VERSION,
    );
    expect(persisted.composites.legacy.content).toEqual({
      durationTicks: 100,
      clips: [],
    });
  });

  it("rejects composite libraries from a newer schema", async () => {
    files.set(
      ".vloproject/composites.json",
      JSON.stringify({
        documentType: "vlo.composites",
        schemaVersion: COMPOSITE_LIBRARY_DOCUMENT_SCHEMA_VERSION + 1,
        updated_at: 1,
        composites: {},
      }),
    );

    await expect(
      projectPersistenceService.readCompositeLibrary(),
    ).rejects.toThrow(ProjectSchemaVersionError);
  });

  it("propagates non-missing asset/composite read failures", async () => {
    (fileSystemService.readFile as Mock).mockRejectedValueOnce(
      new Error("Permission denied"),
    );
    await expect(
      projectPersistenceService.updateAssetIndex(() => undefined),
    ).rejects.toThrow(/Permission denied/);

    projectPersistenceService.resetCaches();
    (fileSystemService.readFile as Mock).mockRejectedValueOnce(
      new Error("Permission denied"),
    );
    await expect(
      projectPersistenceService.readCompositeLibrary(),
    ).rejects.toThrow(/Permission denied/);
  });

  it("writes, caches, validates, and deletes asset metadata", async () => {
    const metadata = {
      source: "generated" as const,
      workflowName: "Workflow",
      inputs: [],
    };
    const ref = await projectPersistenceService.writeAssetMetadata(
      "asset-1",
      metadata,
    );
    expect(ref).toBe("asset-metadata/asset-1.json");
    expect(
      await projectPersistenceService.readAssetMetadata("asset-1", ref),
    ).toMatchObject({ assetId: "asset-1" });

    projectPersistenceService.resetCaches();
    files.set(
      ".vloproject/asset-metadata/wrong.json",
      JSON.stringify({
        documentType: "vlo.assetMetadata",
        schemaVersion: 1,
        assetId: "other",
        updated_at: 1,
        creationMetadata: metadata,
      }),
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      projectPersistenceService.readAssetMetadata(
        "wrong",
        "asset-metadata/wrong.json",
      ),
    ).resolves.toBeNull();
    expect(warning).toHaveBeenCalled();

    await projectPersistenceService.deleteAssetMetadata("asset-1", ref);
    expect(files.has(".vloproject/asset-metadata/asset-1.json")).toBe(false);
    await expect(
      projectPersistenceService.deleteAssetMetadata("missing"),
    ).resolves.toBeUndefined();
  });

  it("persists multiple assets and initializes a complete project", async () => {
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));
    await projectPersistenceService.persistAssetEntries([
      {
        id: "one",
        hash: "one",
        name: "One",
        type: "image",
        src: "one.png",
        createdAt: 1,
      },
      {
        id: "two",
        hash: "two",
        name: "Two",
        type: "image",
        src: "two.png",
        createdAt: 2,
      },
    ]);
    const persisted = JSON.parse(files.get(".vloproject/assets.json")!);
    expect(Object.keys(persisted.assets)).toEqual(["one", "two"]);

    projectPersistenceService.resetCaches();
    const initialized = await projectPersistenceService.initializeProjectDocuments({
      id: "new-project",
      title: "New Project",
      createdAt: 1,
      config: {},
    });
    expect(initialized.id).toBe("new-project");
    expect(files.has(".vloproject/composites.json")).toBe(true);
    expect(
      JSON.parse(files.get(".vloproject/timeline.json")!).tracks,
    ).toHaveLength(1);
    await projectPersistenceService.flushAll();
  });

  it("returns an empty load result for missing and incomplete legacy projects", async () => {
    await expect(projectPersistenceService.loadOrMigrateProject()).resolves.toEqual({
      manifest: null,
      timeline: null,
      assetIndex: null,
      compositeLibrary: null,
      migrated: false,
    });

    files.set(
      ".vloproject/project.json",
      JSON.stringify({ schemaVersion: 2, config: {} }),
    );
    await expect(projectPersistenceService.loadOrMigrateProject()).resolves.toEqual({
      manifest: null,
      timeline: null,
      assetIndex: null,
      compositeLibrary: null,
      migrated: false,
    });
  });

  describe("open subtimeline session", () => {
    const sessionPath = ".vloproject/composite-session.json";
    const videoClip = {
      id: "inner-clip",
      trackId: "inner-track",
      type: "video" as const,
      name: "Inner",
      assetId: "asset-1",
      start: 0,
      timelineDuration: 96000,
      sourceDuration: 96000,
      croppedSourceDuration: 96000,
      transformedDuration: 96000,
      transformedOffset: 0,
      offset: 0,
      transformations: [],
    };
    const session = {
      stack: [
        {
          previousSnapshot: {
            tracks: timeline.tracks,
            clips: [],
            transitions: [],
          },
          ownerCompositeAssetId: "composite-1",
          ownerClipId: "composite-clip",
          name: "Intro",
          insertStartTick: 48000,
          initialContentSnapshot: "{}",
        },
      ],
      current: {
        tracks: [{ ...timeline.tracks[0], id: "inner-track" }],
        clips: [videoClip],
        transitions: [],
      },
    };

    it("treats a missing document as being on the main timeline", async () => {
      const document = await projectPersistenceService.readCompositeSession();
      expect(document).toMatchObject({
        documentType: "vlo.composite-session",
        session: null,
      });
      expect(fileSystemService.writeFile).not.toHaveBeenCalled();
    });

    it("round-trips an open session through a cold reload", async () => {
      await projectPersistenceService.writeCompositeSession(session);
      expect(JSON.parse(files.get(sessionPath)!).session).toEqual(session);

      // A cold reload reads the file rather than the in-memory cache.
      projectPersistenceService.resetCaches();
      const reloaded = await projectPersistenceService.readCompositeSession();
      expect(reloaded.session).toEqual(session);
    });

    it("hands out copies so callers cannot corrupt the cached session", async () => {
      await projectPersistenceService.writeCompositeSession(session);
      const first = await projectPersistenceService.readCompositeSession();
      first.session!.current.clips.length = 0;
      first.session!.stack[0].name = "mutated";

      const second = await projectPersistenceService.readCompositeSession();
      expect(second.session).toEqual(session);
    });

    it("clears the session when returning to the main timeline", async () => {
      await projectPersistenceService.writeCompositeSession(session);
      await projectPersistenceService.writeCompositeSession(null);

      projectPersistenceService.resetCaches();
      expect(
        (await projectPersistenceService.readCompositeSession()).session,
      ).toBeNull();
    });

    it("keeps the last of several rapid writes", async () => {
      const renamed = {
        ...session,
        stack: [{ ...session.stack[0], name: "Renamed" }],
      };
      await Promise.all([
        projectPersistenceService.writeCompositeSession(session),
        projectPersistenceService.writeCompositeSession(null),
        projectPersistenceService.writeCompositeSession(renamed),
      ]);

      projectPersistenceService.resetCaches();
      expect(
        (await projectPersistenceService.readCompositeSession()).session,
      ).toEqual(renamed);
    });

    it("refuses to write a session that would not load back", async () => {
      await expect(
        projectPersistenceService.writeCompositeSession({
          ...session,
          stack: [],
        }),
      ).rejects.toThrow();
      expect(files.has(sessionPath)).toBe(false);
    });

    it("rejects newer, corrupt and unreadable documents instead of discarding them", async () => {
      files.set(
        sessionPath,
        JSON.stringify({
          documentType: "vlo.composite-session",
          schemaVersion: 99,
          updated_at: 1,
          session: null,
        }),
      );
      await expect(
        projectPersistenceService.readCompositeSession(),
      ).rejects.toBeInstanceOf(ProjectSchemaVersionError);

      files.set(sessionPath, "{ not json");
      await expect(
        projectPersistenceService.readCompositeSession(),
      ).rejects.toThrow(SyntaxError);

      files.set(
        sessionPath,
        JSON.stringify({
          documentType: "vlo.composite-session",
          schemaVersion: 1,
          updated_at: 1,
          session: { stack: [], current: session.current },
        }),
      );
      await expect(
        projectPersistenceService.readCompositeSession(),
      ).rejects.toThrow();
      // A bad document stays on disk for recovery rather than being reset.
      expect(files.has(sessionPath)).toBe(true);

      (fileSystemService.readFile as Mock).mockRejectedValueOnce(
        new Error("Permission denied"),
      );
      await expect(
        projectPersistenceService.readCompositeSession(),
      ).rejects.toThrow(/Permission denied/);
    });
  });

  describe("generation panel document", () => {
    const panelPath = ".vloproject/generation-panel.json";
    const panel = {
      workflowId: "vlo_ltx2_5.json",
      inputs: {
        prompt: "a lighthouse at dusk",
        seed: 42,
        loras: [{ name: "detail", strength: 0.6 }],
        audio: null,
      },
    };

    it("starts empty and round-trips the panel through a cold reload", async () => {
      expect(
        (await projectPersistenceService.readGenerationPanel()).panel,
      ).toBeNull();

      await projectPersistenceService.writeGenerationPanel(panel);
      projectPersistenceService.resetCaches();
      expect(
        (await projectPersistenceService.readGenerationPanel()).panel,
      ).toEqual(panel);

      await projectPersistenceService.writeGenerationPanel(null);
      projectPersistenceService.resetCaches();
      expect(
        (await projectPersistenceService.readGenerationPanel()).panel,
      ).toBeNull();
    });

    it("rejects newer and unreadable panel documents", async () => {
      files.set(
        panelPath,
        JSON.stringify({
          documentType: "vlo.generation-panel",
          schemaVersion: 2,
          updated_at: 1,
          panel: null,
        }),
      );
      await expect(
        projectPersistenceService.readGenerationPanel(),
      ).rejects.toBeInstanceOf(ProjectSchemaVersionError);

      (fileSystemService.readFile as Mock).mockRejectedValueOnce(
        new Error("Permission denied"),
      );
      await expect(
        projectPersistenceService.readGenerationPanel(),
      ).rejects.toThrow(/Permission denied/);
    });
  });

  describe("extension storage document", () => {
    const storagePath = ".vloproject/extension-storage.json";

    it("replaces one namespace while retaining every other", async () => {
      files.set(
        storagePath,
        JSON.stringify({
          documentType: "vlo.extension-storage",
          schemaVersion: 1,
          updated_at: 1,
          // An extension that is no longer installed keeps its data.
          storage: { "example.uninstalled": { keep: true } },
        }),
      );

      await projectPersistenceService.updateExtensionStorageNamespace(
        "example.a",
        { count: 1, nested: { list: [1, "two"] } },
      );
      await projectPersistenceService.updateExtensionStorageNamespace(
        "example.b",
        { enabled: false },
      );
      await projectPersistenceService.updateExtensionStorageNamespace(
        "example.a",
        undefined,
      );

      projectPersistenceService.resetCaches();
      const reloaded = await projectPersistenceService.readExtensionStorage();
      expect(reloaded.storage).toEqual({
        "example.uninstalled": { keep: true },
        "example.b": { enabled: false },
      });
    });

    it("creates the document on first write and isolates returned copies", async () => {
      const record = { values: [1, 2] };
      const written =
        await projectPersistenceService.updateExtensionStorageNamespace(
          "example.a",
          record,
        );
      record.values.push(3);
      written.storage["example.a"].values = [];

      expect(
        (await projectPersistenceService.readExtensionStorage()).storage,
      ).toEqual({ "example.a": { values: [1, 2] } });
      expect(JSON.parse(files.get(storagePath)!).storage).toEqual({
        "example.a": { values: [1, 2] },
      });
    });

    it("rejects newer storage documents", async () => {
      files.set(
        storagePath,
        JSON.stringify({
          documentType: "vlo.extension-storage",
          schemaVersion: 5,
          updated_at: 1,
          storage: {},
        }),
      );
      await expect(
        projectPersistenceService.updateExtensionStorageNamespace("example.a", {}),
      ).rejects.toBeInstanceOf(ProjectSchemaVersionError);
    });
  });
});
