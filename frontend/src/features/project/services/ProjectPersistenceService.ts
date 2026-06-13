import {
  applyPatches,
  enablePatches,
  produce,
  type Draft,
  type Patch,
} from "../../../lib/immerLite";
import type { Asset, CreationMetadata } from "../../../types/Asset";
import type { TimelineTrack } from "../../../types/TimelineTypes";
import {
  ASSET_INDEX_DOCUMENT_SCHEMA_VERSION,
  ASSET_METADATA_DOCUMENT_SCHEMA_VERSION,
  COMPOSITE_LIBRARY_DOCUMENT_SCHEMA_VERSION,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  TIMELINE_DOCUMENT_SCHEMA_VERSION,
  VLO_APP_VERSION,
} from "../constants";
import type {
  ProjectDocumentConfig,
  TimelineSnapshot,
} from "../types/ProjectDocument";
import {
  HEAVY_ASSET_METADATA_INLINE_THRESHOLD_BYTES,
  PROJECT_PERSISTENCE_FILE_NAMES,
  assertSafePathSegment,
  assetIndexDocumentSchema,
  assetMetadataDocumentSchema,
  compositeLibraryDocumentSchema,
  legacyProjectDocumentSchema,
  projectManifestDocumentSchema,
  timelineDocumentSchema,
  timelineDocumentSchemaV2,
  timelineDocumentSchemaV1,
  type AssetIndexDocument,
  type AssetMetadataDocument,
  type CompositeLibraryDocument,
  type LegacyProjectDocument,
  type PersistedAssetIndexEntry,
  type ProjectManifestDocument,
  type TimelineDocument,
} from "../schemas/projectPersistenceSchemas";
import { fileSystemService } from "./FileSystemService";
import type { z } from "zod";

enablePatches();

type ManifestMutator = (draft: Draft<ProjectManifestDocument>) => void;
type TimelineMutator = (draft: Draft<TimelineDocument>) => void;
type AssetIndexMutator = (draft: Draft<AssetIndexDocument>) => void;
type CompositeLibraryMutator = (draft: Draft<CompositeLibraryDocument>) => void;

interface NewerSchemaVersionCheck {
  path: string;
  documentType: string;
  documentLabel: string;
  supportedSchemaVersion: number;
}

const PROJECT_DIR = ".vloproject";
const MANIFEST_PATH = `${PROJECT_DIR}/project.json`;
const LEGACY_BACKUP_PATH = `${PROJECT_DIR}/project.legacy-v2.json`;
const TIMELINE_PATH = `${PROJECT_DIR}/${PROJECT_PERSISTENCE_FILE_NAMES.timeline}`;
const ASSET_INDEX_PATH = `${PROJECT_DIR}/${PROJECT_PERSISTENCE_FILE_NAMES.assets}`;
const COMPOSITE_LIBRARY_PATH = `${PROJECT_DIR}/${PROJECT_PERSISTENCE_FILE_NAMES.composites}`;
const ASSET_METADATA_DIR = PROJECT_PERSISTENCE_FILE_NAMES.assetMetadataDir;
const MANIFEST_NEWER_SCHEMA_CHECK: NewerSchemaVersionCheck = {
  path: MANIFEST_PATH,
  documentType: "vlo.project",
  documentLabel: "Project metadata",
  supportedSchemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
};
const TIMELINE_NEWER_SCHEMA_CHECK: NewerSchemaVersionCheck = {
  path: TIMELINE_PATH,
  documentType: "vlo.timeline",
  documentLabel: "Timeline data",
  supportedSchemaVersion: TIMELINE_DOCUMENT_SCHEMA_VERSION,
};
const ASSET_INDEX_NEWER_SCHEMA_CHECK: NewerSchemaVersionCheck = {
  path: ASSET_INDEX_PATH,
  documentType: "vlo.assets",
  documentLabel: "Asset index data",
  supportedSchemaVersion: ASSET_INDEX_DOCUMENT_SCHEMA_VERSION,
};
const COMPOSITE_LIBRARY_NEWER_SCHEMA_CHECK: NewerSchemaVersionCheck = {
  path: COMPOSITE_LIBRARY_PATH,
  documentType: "vlo.composites",
  documentLabel: "Composite library data",
  supportedSchemaVersion: COMPOSITE_LIBRARY_DOCUMENT_SCHEMA_VERSION,
};

export interface LoadedProjectPersistenceDocuments {
  manifest: ProjectManifestDocument | null;
  timeline: TimelineDocument | null;
  assetIndex: AssetIndexDocument | null;
  compositeLibrary: CompositeLibraryDocument | null;
  migrated: boolean;
}

export interface InitializeProjectDocumentsInput {
  id: string;
  title: string;
  createdAt: number;
  config: ProjectDocumentConfig;
  timeline?: TimelineSnapshot;
  assetIndex?: AssetIndexDocument;
  compositeLibrary?: CompositeLibraryDocument;
}

export interface PreparedPersistedAsset {
  entry: PersistedAssetIndexEntry;
  sidecarMetadata?: CreationMetadata;
}

export class ProjectSchemaVersionError extends Error {
  readonly documentPath: string;
  readonly documentType: string;
  readonly documentLabel: string;
  readonly foundSchemaVersion: number;
  readonly supportedSchemaVersion: number;

  constructor(
    documentPath: string,
    documentType: string,
    documentLabel: string,
    foundSchemaVersion: number,
    supportedSchemaVersion: number,
  ) {
    super(
      `This project was created with a newer version of VLO and can't be opened here yet. ` +
        `${documentLabel} uses schema version ${foundSchemaVersion}, but this build supports up to version ${supportedSchemaVersion}.`,
    );
    this.name = "ProjectSchemaVersionError";
    this.documentPath = documentPath;
    this.documentType = documentType;
    this.documentLabel = documentLabel;
    this.foundSchemaVersion = foundSchemaVersion;
    this.supportedSchemaVersion = supportedSchemaVersion;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfNewerSchemaVersion(
  raw: unknown,
  check: NewerSchemaVersionCheck,
): void {
  if (!isRecord(raw) || raw.documentType !== check.documentType) {
    return;
  }

  if (
    typeof raw.schemaVersion === "number" &&
    raw.schemaVersion > check.supportedSchemaVersion
  ) {
    throw new ProjectSchemaVersionError(
      check.path,
      check.documentType,
      check.documentLabel,
      raw.schemaVersion,
      check.supportedSchemaVersion,
    );
  }
}

export async function writeJson<T>(
  path: string,
  value: T,
  schema: z.ZodType<T>,
): Promise<void> {
  const parsed = schema.parse(value);
  await fileSystemService.writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

function isNotFoundError(error: unknown): boolean {
  return (
    (error as DOMException | undefined)?.name === "NotFoundError" ||
    (error instanceof Error && /not found|missing/i.test(error.message))
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeAdjustmentSourceDurationInTimelineDocument(
  raw: unknown,
): { value: unknown; changed: boolean } {
  if (!isRecord(raw) || !Array.isArray(raw.clips)) {
    return { value: raw, changed: false };
  }

  let changed = false;
  const next = clone(raw);
  if (!isRecord(next) || !Array.isArray(next.clips)) {
    return { value: raw, changed: false };
  }

  next.clips = next.clips.map((clip) => {
    if (!isRecord(clip) || clip.type !== "adjustment") {
      return clip;
    }

    if (typeof clip.sourceDuration === "number") {
      return clip;
    }

    changed = true;
    return {
      ...clip,
      sourceDuration:
        typeof clip.timelineDuration === "number" ? clip.timelineDuration : 0,
    };
  });

  return { value: next, changed };
}

function createDefaultTrack(): TimelineTrack {
  return {
    id: `track_${crypto.randomUUID()}`,
    label: "Track 1",
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function createDefaultTimelineSnapshot(): TimelineSnapshot {
  return {
    tracks: [createDefaultTrack()],
    clips: [],
  };
}

function createTimelineDocument(snapshot: TimelineSnapshot): TimelineDocument {
  return {
    documentType: "vlo.timeline",
    schemaVersion: TIMELINE_DOCUMENT_SCHEMA_VERSION,
    updated_at: Date.now(),
    tracks: clone(snapshot.tracks),
    clips: clone(snapshot.clips),
  };
}

function createAssetIndexDocument(
  overrides: Partial<Pick<AssetIndexDocument, "assets" | "assetFamilies">> = {},
): AssetIndexDocument {
  return {
    documentType: "vlo.assets",
    schemaVersion: ASSET_INDEX_DOCUMENT_SCHEMA_VERSION,
    updated_at: Date.now(),
    assets: overrides.assets ?? {},
    assetFamilies: overrides.assetFamilies ?? {},
  };
}

function createCompositeLibraryDocument(
  overrides: Partial<Pick<CompositeLibraryDocument, "composites">> = {},
): CompositeLibraryDocument {
  return {
    documentType: "vlo.composites",
    schemaVersion: COMPOSITE_LIBRARY_DOCUMENT_SCHEMA_VERSION,
    updated_at: Date.now(),
    composites: overrides.composites ?? {},
  };
}

function createManifestDocument(
  input: InitializeProjectDocumentsInput & {
    migratedFromSchemaVersion?: number;
    createdWithVloVersion?: string;
    lastSavedWithVloVersion?: string;
  },
): ProjectManifestDocument {
  return {
    documentType: "vlo.project",
    schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
    id: input.id,
    title: input.title,
    created_at: input.createdAt,
    last_modified: Date.now(),
    createdWithVloVersion: input.createdWithVloVersion ?? VLO_APP_VERSION,
    lastSavedWithVloVersion: input.lastSavedWithVloVersion ?? VLO_APP_VERSION,
    migratedFromSchemaVersion: input.migratedFromSchemaVersion,
    config: clone(input.config),
    files: {
      timeline: PROJECT_PERSISTENCE_FILE_NAMES.timeline,
      assets: PROJECT_PERSISTENCE_FILE_NAMES.assets,
      composites: PROJECT_PERSISTENCE_FILE_NAMES.composites,
      assetMetadataDir: PROJECT_PERSISTENCE_FILE_NAMES.assetMetadataDir,
    },
  };
}

function isProjectManifestCandidate(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProjectManifestDocument>;
  return (
    candidate.documentType === "vlo.project" &&
    candidate.schemaVersion === PROJECT_MANIFEST_SCHEMA_VERSION
  );
}

function hasLegacyCoreProjectData(
  document: LegacyProjectDocument,
): document is LegacyProjectDocument & {
  id: string;
  title: string;
  created_at: number;
} {
  return (
    typeof document.id === "string" &&
    typeof document.title === "string" &&
    typeof document.created_at === "number"
  );
}

function stringifyByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function shouldSplitCreationMetadata(
  metadata: CreationMetadata | undefined,
): metadata is CreationMetadata {
  if (!metadata) {
    return false;
  }

  if (metadata.source === "composite") {
    return Boolean(metadata.timelineSelection);
  }

  if (metadata.source !== "generated") {
    return false;
  }

  const generated = metadata as Extract<CreationMetadata, { source: "generated" }>;
  return (
    Boolean(
      generated.replayState ||
        generated.comfyuiPrompt ||
        generated.comfyuiWorkflow,
    ) ||
    stringifyByteLength(metadata) > HEAVY_ASSET_METADATA_INLINE_THRESHOLD_BYTES
  );
}

function toLightweightCreationMetadata(
  metadata: CreationMetadata,
): CreationMetadata {
  if (metadata.source === "composite") {
    return {
      source: "composite",
      ...(metadata.compositeAssetId
        ? { compositeAssetId: metadata.compositeAssetId }
        : {}),
      ...(metadata.compositeClipId
        ? { compositeClipId: metadata.compositeClipId }
        : {}),
      ...(metadata.contentHash ? { contentHash: metadata.contentHash } : {}),
    };
  }

  if (metadata.source !== "generated") {
    return metadata;
  }

  const lightweight = { ...metadata };
  delete lightweight.replayState;
  delete lightweight.comfyuiPrompt;
  delete lightweight.comfyuiWorkflow;

  return lightweight as CreationMetadata;
}

function assetMetadataRef(assetId: string): string {
  return `${ASSET_METADATA_DIR}/${assertSafePathSegment(assetId)}.json`;
}

function assetMetadataPath(assetId: string, metadataRef?: string): string {
  const ref = metadataRef ?? assetMetadataRef(assetId);
  if (!ref.startsWith(`${ASSET_METADATA_DIR}/`)) {
    throw new Error(`Unexpected asset metadata ref: ${ref}`);
  }
  return `${PROJECT_DIR}/${ref}`;
}

function toPersistedPath(
  runtimeUrl: string | undefined,
  persistedPath: string | undefined,
): string | undefined {
  if (persistedPath) {
    return persistedPath;
  }
  if (
    runtimeUrl &&
    !runtimeUrl.startsWith("blob:") &&
    !runtimeUrl.startsWith("http://") &&
    !runtimeUrl.startsWith("https://")
  ) {
    return runtimeUrl;
  }
  return undefined;
}

export function prepareAssetForPersistence(
  asset: Asset,
): PreparedPersistedAsset {
  const src = toPersistedPath(asset.src, asset.sourcePath);
  if (!src) {
    throw new Error(`Asset '${asset.id}' is missing a persisted source path`);
  }

  const entry: PersistedAssetIndexEntry = {
    id: asset.id,
    hash: asset.hash,
    familyId: asset.familyId,
    name: asset.name,
    type: asset.type,
    favourite: asset.favourite,
    src,
    thumbnail: toPersistedPath(asset.thumbnail, asset.thumbnailPath),
    proxySrc: toPersistedPath(asset.proxySrc, asset.proxyPath),
    duration: asset.duration,
    fps: asset.fps,
    hasAudio: asset.hasAudio,
    createdAt: asset.createdAt,
  };

  if (shouldSplitCreationMetadata(asset.creationMetadata)) {
    entry.creationMetadata = toLightweightCreationMetadata(asset.creationMetadata);
    entry.metadataRef = assetMetadataRef(asset.id);
    return {
      entry,
      sidecarMetadata: asset.creationMetadata,
    };
  }

  if (asset.creationMetadata) {
    entry.creationMetadata = asset.creationMetadata;
  }

  if (asset.metadataRef) {
    entry.metadataRef = asset.metadataRef;
  }

  return { entry };
}

export class ProjectPersistenceService {
  private queues = new Map<string, Promise<void>>();
  private manifestCache: ProjectManifestDocument | null = null;
  private timelineCache: TimelineDocument | null = null;
  private assetIndexCache: AssetIndexDocument | null = null;
  private compositeLibraryCache: CompositeLibraryDocument | null = null;
  private assetMetadataCache = new Map<string, AssetMetadataDocument | null>();

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    this.queues.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async persistManifest(
    document: ProjectManifestDocument,
  ): Promise<ProjectManifestDocument> {
    await writeJson(MANIFEST_PATH, document, projectManifestDocumentSchema);
    this.manifestCache = document;
    return clone(document);
  }

  private async persistTimeline(
    document: TimelineDocument,
  ): Promise<TimelineDocument> {
    await writeJson(TIMELINE_PATH, document, timelineDocumentSchema);
    this.timelineCache = document;
    return clone(document);
  }

  private async persistAssetIndex(
    document: AssetIndexDocument,
  ): Promise<AssetIndexDocument> {
    await writeJson(ASSET_INDEX_PATH, document, assetIndexDocumentSchema);
    this.assetIndexCache = document;
    return clone(document);
  }

  private async persistCompositeLibrary(
    document: CompositeLibraryDocument,
  ): Promise<CompositeLibraryDocument> {
    await writeJson(
      COMPOSITE_LIBRARY_PATH,
      document,
      compositeLibraryDocumentSchema,
    );
    this.compositeLibraryCache = document;
    return clone(document);
  }

  async readManifest(): Promise<ProjectManifestDocument> {
    if (this.manifestCache) {
      return clone(this.manifestCache);
    }

    const file = await fileSystemService.readFile(MANIFEST_PATH);
    const raw = JSON.parse(await file.text()) as unknown;
    throwIfNewerSchemaVersion(raw, MANIFEST_NEWER_SCHEMA_CHECK);
    const manifest = projectManifestDocumentSchema.parse(raw);
    this.manifestCache = manifest;
    return clone(manifest);
  }

  async updateManifest(
    mutator: ManifestMutator,
  ): Promise<ProjectManifestDocument> {
    return this.enqueue(MANIFEST_PATH, async () => {
      const current = await this.readManifest();
      const next = produce(current, (draft) => {
        mutator(draft);
        draft.last_modified = Date.now();
        draft.lastSavedWithVloVersion = VLO_APP_VERSION;
      });
      return this.persistManifest(next);
    });
  }

  async readTimeline(): Promise<TimelineDocument> {
    if (this.timelineCache) {
      return clone(this.timelineCache);
    }

    const file = await fileSystemService.readFile(TIMELINE_PATH);
    const raw = JSON.parse(await file.text()) as unknown;
    throwIfNewerSchemaVersion(raw, TIMELINE_NEWER_SCHEMA_CHECK);
    const normalizedCurrent = normalizeAdjustmentSourceDurationInTimelineDocument(
      raw,
    );

    // Zod's strip-on-parse default means a stale dev-branch v2 document that
    // still carries the never-shipped top-level `groups` field parses cleanly
    // here — the field is silently dropped from the in-memory doc and won't
    // be written back on the next persistence flush.
    const currentParsed = timelineDocumentSchema.safeParse(
      normalizedCurrent.value,
    );
    if (currentParsed.success) {
      if (normalizedCurrent.changed) {
        return this.persistTimeline(currentParsed.data);
      }
      this.timelineCache = currentParsed.data;
      return clone(currentParsed.data);
    }

    const v2Parsed = timelineDocumentSchemaV2.safeParse(normalizedCurrent.value);
    if (v2Parsed.success) {
      const migrated: TimelineDocument = {
        documentType: "vlo.timeline",
        schemaVersion: TIMELINE_DOCUMENT_SCHEMA_VERSION,
        updated_at: v2Parsed.data.updated_at,
        tracks: v2Parsed.data.tracks,
        clips: v2Parsed.data.clips,
      };

      return this.persistTimeline(migrated);
    }

    // Fall back to v1 and migrate forward.
    const normalizedLegacy =
      normalizeAdjustmentSourceDurationInTimelineDocument(raw);
    const v1Parsed = timelineDocumentSchemaV1.safeParse(normalizedLegacy.value);
    if (!v1Parsed.success) {
      throw currentParsed.error;
    }

    const migrated: TimelineDocument = {
      documentType: "vlo.timeline",
      schemaVersion: TIMELINE_DOCUMENT_SCHEMA_VERSION,
      updated_at: v1Parsed.data.updated_at,
      tracks: v1Parsed.data.tracks,
      clips: v1Parsed.data.clips,
    };

    return this.persistTimeline(migrated);
  }

  async updateTimeline(
    mutator: TimelineMutator,
  ): Promise<TimelineDocument> {
    return this.enqueue(TIMELINE_PATH, async () => {
      const current = await this.readTimeline();
      const next = produce(current, (draft) => {
        mutator(draft);
        draft.updated_at = Date.now();
      });
      return this.persistTimeline(next);
    });
  }

  async applyTimelinePatches(
    patches: Patch[],
    fallbackSnapshot: TimelineSnapshot,
  ): Promise<TimelineDocument> {
    return this.enqueue(TIMELINE_PATH, async () => {
      const current = await this.readTimeline();

      let next: TimelineDocument;
      try {
        next = applyPatches(current, patches) as TimelineDocument;
        next.updated_at = Date.now();
      } catch (error) {
        console.warn(
          "[ProjectPersistenceService] Failed to apply timeline patches; writing fallback snapshot.",
          error,
        );
        next = createTimelineDocument(fallbackSnapshot);
      }

      return this.persistTimeline(next);
    });
  }

  async readAssetIndex(): Promise<AssetIndexDocument> {
    if (this.assetIndexCache) {
      return clone(this.assetIndexCache);
    }

    const file = await fileSystemService.readFile(ASSET_INDEX_PATH);
    const raw = JSON.parse(await file.text()) as unknown;
    throwIfNewerSchemaVersion(raw, ASSET_INDEX_NEWER_SCHEMA_CHECK);
    const assetIndex = assetIndexDocumentSchema.parse(raw);
    this.assetIndexCache = assetIndex;
    return clone(assetIndex);
  }

  async updateAssetIndex(
    mutator: AssetIndexMutator,
  ): Promise<AssetIndexDocument> {
    return this.enqueue(ASSET_INDEX_PATH, async () => {
      let current: AssetIndexDocument;
      try {
        current = await this.readAssetIndex();
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
        current = createAssetIndexDocument();
      }

      const next = produce(current, (draft) => {
        mutator(draft);
        draft.updated_at = Date.now();
      });
      return this.persistAssetIndex(next);
    });
  }

  async readCompositeLibrary(): Promise<CompositeLibraryDocument> {
    if (this.compositeLibraryCache) {
      return clone(this.compositeLibraryCache);
    }

    try {
      const file = await fileSystemService.readFile(COMPOSITE_LIBRARY_PATH);
      const raw = JSON.parse(await file.text()) as unknown;
      throwIfNewerSchemaVersion(raw, COMPOSITE_LIBRARY_NEWER_SCHEMA_CHECK);
      const compositeLibrary = compositeLibraryDocumentSchema.parse(raw);
      this.compositeLibraryCache = compositeLibrary;
      return clone(compositeLibrary);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      const empty = createCompositeLibraryDocument();
      this.compositeLibraryCache = empty;
      return clone(empty);
    }
  }

  async updateCompositeLibrary(
    mutator: CompositeLibraryMutator,
  ): Promise<CompositeLibraryDocument> {
    return this.enqueue(COMPOSITE_LIBRARY_PATH, async () => {
      const current = await this.readCompositeLibrary();
      const next = produce(current, (draft) => {
        mutator(draft);
        draft.updated_at = Date.now();
      });
      return this.persistCompositeLibrary(next);
    });
  }

  async readAssetMetadata(
    assetId: string,
    metadataRef?: string,
  ): Promise<AssetMetadataDocument | null> {
    const path = assetMetadataPath(assetId, metadataRef);
    const cached = this.assetMetadataCache.get(path);
    if (cached !== undefined) {
      return cached ? clone(cached) : null;
    }

    try {
      const file = await fileSystemService.readFile(path);
      const raw = JSON.parse(await file.text()) as unknown;
      throwIfNewerSchemaVersion(raw, {
        path,
        documentType: "vlo.assetMetadata",
        documentLabel: `Asset metadata for '${assetId}'`,
        supportedSchemaVersion: ASSET_METADATA_DOCUMENT_SCHEMA_VERSION,
      });
      const document = assetMetadataDocumentSchema.parse(raw);
      if (document.assetId !== assetId) {
        throw new Error(
          `Asset metadata '${path}' belongs to '${document.assetId}', not '${assetId}'`,
        );
      }
      this.assetMetadataCache.set(path, document);
      return clone(document);
    } catch (error) {
      if (error instanceof ProjectSchemaVersionError) {
        throw error;
      }

      console.warn(
        `[ProjectPersistenceService] Could not read asset metadata '${path}'.`,
        error,
      );
      this.assetMetadataCache.set(path, null);
      return null;
    }
  }

  async writeAssetMetadata(
    assetId: string,
    metadata: CreationMetadata,
  ): Promise<string> {
    const ref = assetMetadataRef(assetId);
    const path = assetMetadataPath(assetId, ref);
    await this.enqueue(path, async () => {
      const document: AssetMetadataDocument = {
        documentType: "vlo.assetMetadata",
        schemaVersion: ASSET_METADATA_DOCUMENT_SCHEMA_VERSION,
        assetId,
        updated_at: Date.now(),
        creationMetadata: clone(metadata),
      };
      await writeJson(path, document, assetMetadataDocumentSchema);
      this.assetMetadataCache.set(path, document);
    });
    return ref;
  }

  async deleteAssetMetadata(
    assetId: string,
    metadataRef?: string,
  ): Promise<void> {
    const path = assetMetadataPath(assetId, metadataRef);
    await this.enqueue(path, async () => {
      try {
        await fileSystemService.deleteFile(path);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      } finally {
        this.assetMetadataCache.delete(path);
      }
    });
  }

  async persistAssetEntry(asset: Asset): Promise<PersistedAssetIndexEntry> {
    const prepared = prepareAssetForPersistence(asset);
    if (prepared.sidecarMetadata) {
      prepared.entry.metadataRef = await this.writeAssetMetadata(
        asset.id,
        prepared.sidecarMetadata,
      );
    }

    await this.updateAssetIndex((draft) => {
      draft.assets[asset.id] = prepared.entry;
    });

    return clone(prepared.entry);
  }

  async persistAssetEntries(assets: readonly Asset[]): Promise<void> {
    const preparedEntries: PersistedAssetIndexEntry[] = [];

    for (const asset of assets) {
      const prepared = prepareAssetForPersistence(asset);
      if (prepared.sidecarMetadata) {
        prepared.entry.metadataRef = await this.writeAssetMetadata(
          asset.id,
          prepared.sidecarMetadata,
        );
      }
      preparedEntries.push(prepared.entry);
    }

    await this.updateAssetIndex((draft) => {
      for (const entry of preparedEntries) {
        draft.assets[entry.id] = entry;
      }
    });
  }

  async initializeProjectDocuments(
    input: InitializeProjectDocumentsInput,
  ): Promise<ProjectManifestDocument> {
    const assetIndex = input.assetIndex ?? createAssetIndexDocument();
    const compositeLibrary =
      input.compositeLibrary ?? createCompositeLibraryDocument();
    const timeline = createTimelineDocument(
      input.timeline ?? createDefaultTimelineSnapshot(),
    );
    const manifest = createManifestDocument(input);

    await this.persistAssetIndex(assetIndex);
    await this.persistCompositeLibrary(compositeLibrary);
    await this.persistTimeline(timeline);
    return this.persistManifest(manifest);
  }

  async loadOrMigrateProject(): Promise<LoadedProjectPersistenceDocuments> {
    this.resetCaches();

    let rawText: string;
    try {
      const file = await fileSystemService.readFile(MANIFEST_PATH);
      rawText = await file.text();
    } catch (error) {
      if (isNotFoundError(error)) {
        return {
          manifest: null,
          timeline: null,
          assetIndex: null,
          compositeLibrary: null,
          migrated: false,
        };
      }
      throw error;
    }

    const rawDocument = JSON.parse(rawText) as unknown;
    throwIfNewerSchemaVersion(rawDocument, MANIFEST_NEWER_SCHEMA_CHECK);
    if (isProjectManifestCandidate(rawDocument)) {
      const manifest = projectManifestDocumentSchema.parse(rawDocument);
      this.manifestCache = manifest;
      const timeline = await this.readTimeline();
      const assetIndex = await this.readAssetIndex();
      const compositeLibrary = await this.readCompositeLibrary();
      return {
        manifest: clone(manifest),
        timeline,
        assetIndex,
        compositeLibrary,
        migrated: false,
      };
    }

    const legacy = legacyProjectDocumentSchema.parse(rawDocument);
    if (!hasLegacyCoreProjectData(legacy)) {
      return {
        manifest: null,
        timeline: null,
        assetIndex: null,
        compositeLibrary: null,
        migrated: false,
      };
    }

    return this.migrateLegacyProject(legacy, rawText);
  }

  private async migrateLegacyProject(
    legacy: LegacyProjectDocument & {
      id: string;
      title: string;
      created_at: number;
    },
    rawText: string,
  ): Promise<LoadedProjectPersistenceDocuments> {
    let hasBackup = false;
    try {
      await fileSystemService.readFile(LEGACY_BACKUP_PATH);
      hasBackup = true;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    if (!hasBackup) {
      await fileSystemService.writeFile(LEGACY_BACKUP_PATH, rawText);
    }

    const assets: Record<string, PersistedAssetIndexEntry> = {};
    for (const asset of Object.values(legacy.assets ?? {})) {
      const prepared = prepareAssetForPersistence(asset);
      if (prepared.sidecarMetadata) {
        prepared.entry.metadataRef = await this.writeAssetMetadata(
          asset.id,
          prepared.sidecarMetadata,
        );
      }
      assets[asset.id] = prepared.entry;
    }

    const assetIndex = createAssetIndexDocument({
      assets,
      assetFamilies: clone(legacy.assetFamilies ?? {}),
    });
    const compositeLibrary = createCompositeLibraryDocument();

    const timeline = createTimelineDocument({
      tracks:
        legacy.timeline?.tracks && legacy.timeline.tracks.length > 0
          ? clone(legacy.timeline.tracks)
          : createDefaultTimelineSnapshot().tracks,
      clips: clone(legacy.timeline?.clips ?? []),
    });

    const manifest = createManifestDocument({
      id: legacy.id,
      title: legacy.title,
      createdAt: legacy.created_at,
      config: clone(legacy.config ?? {}),
      timeline: {
        tracks: timeline.tracks,
        clips: timeline.clips,
      },
      migratedFromSchemaVersion: legacy.schemaVersion,
      createdWithVloVersion: legacy.createdWithVloVersion,
      lastSavedWithVloVersion: legacy.lastSavedWithVloVersion,
    });

    await this.persistAssetIndex(assetIndex);
    await this.persistCompositeLibrary(compositeLibrary);
    await this.persistTimeline(timeline);
    await this.persistManifest(manifest);

    return {
      manifest: clone(manifest),
      timeline: clone(timeline),
      assetIndex: clone(assetIndex),
      compositeLibrary: clone(compositeLibrary),
      migrated: true,
    };
  }

  resetCaches(): void {
    this.manifestCache = null;
    this.timelineCache = null;
    this.assetIndexCache = null;
    this.compositeLibraryCache = null;
    this.assetMetadataCache.clear();
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }
}

export const projectPersistenceService = new ProjectPersistenceService();

export type {
  AssetIndexDocument,
  AssetMetadataDocument,
  CompositeLibraryDocument,
  PersistedAssetIndexEntry,
  ProjectManifestDocument,
  TimelineDocument,
};
export type { Patch };
