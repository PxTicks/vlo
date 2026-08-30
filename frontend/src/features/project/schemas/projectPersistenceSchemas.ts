import { z } from "zod";
import type {
  Asset,
  AssetFamily,
  AssetFamilyCompatibility,
  AssetType,
  CreationMetadata,
} from "../../../types/Asset";
import type {
  CompositeAsset,
  TimelineClip,
  TimelineTrack,
  TrackType,
  Transition,
} from "../../../types/TimelineTypes";
import {
  ADJUSTMENT_DEPTH_ALL,
  ADJUSTMENT_RETIMING_RIPPLE,
  ADJUSTMENT_RETIMING_STATIC,
} from "../../../types/TimelineTypes";
import {
  ASSET_INDEX_DOCUMENT_SCHEMA_VERSION,
  ASSET_METADATA_DOCUMENT_SCHEMA_VERSION,
  COMPOSITE_LIBRARY_DOCUMENT_SCHEMA_VERSION,
  EXTENSION_STORAGE_DOCUMENT_SCHEMA_VERSION,
  GENERATION_PANEL_DOCUMENT_SCHEMA_VERSION,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  TIMELINE_DOCUMENT_SCHEMA_VERSION,
} from "../constants";
import type { ProjectDocumentConfig } from "../types/ProjectDocument";
import {
  extensionPayloadSchema,
  jsonValueSchema,
} from "../../extensions/persistence/publicApi";

const PROJECT_FILE_NAMES = {
  timeline: "timeline.json",
  assets: "assets.json",
  composites: "composites.json",
  assetMetadataDir: "asset-metadata",
  extensionStorage: "extension-storage.json",
  generationPanel: "generation-panel.json",
} as const;

export const HEAVY_ASSET_METADATA_INLINE_THRESHOLD_BYTES = 16 * 1024;

export function isSafeProjectRelativePath(value: string): boolean {
  if (!value.trim()) return false;
  if (value.startsWith("/") || value.startsWith("~/")) return false;
  if (value.includes("\\") || value.includes(":")) return false;

  return value
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function assertSafeProjectRelativePath(value: string): string {
  if (!isSafeProjectRelativePath(value)) {
    throw new Error(`Unsafe project-relative path: ${value}`);
  }
  return value;
}

export function isSafePathSegment(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".."
  );
}

export function assertSafePathSegment(value: string): string {
  if (!isSafePathSegment(value)) {
    throw new Error(`Unsafe path segment: ${value}`);
  }
  return value;
}

export const projectRelativePathSchema = z
  .string()
  .refine(isSafeProjectRelativePath, "Expected a safe project-relative path");

const assetTypeSchema = z.enum(["video", "image", "audio", "lut"]) satisfies z.ZodType<AssetType>;

const trackTypeSchema = z.enum([
  "visual",
  "audio",
  "prompt",
  "effects",
  "mask",
  "adjustment",
]) satisfies z.ZodType<TrackType>;

export const projectDocumentConfigSchema = z
  .object({
    aspectRatio: z.enum(["16:9", "4:3", "1:1", "3:4", "9:16"]).optional(),
    // Deliberately wider than `ProjectOutputResolution`: the manifest is
    // parsed with `.parse()`, so pinning the rungs here would make a project
    // written by a newer vlo (with a rung this build lacks) fail to open
    // rather than degrade. The loader narrows to a supported rung instead.
    outputResolution: z.number().positive().optional(),
    fps: z.number().positive().optional(),
    fitMode: z.enum(["contain", "cover"]).optional(),
    layoutMode: z.enum(["full-height", "compact"]).optional(),
    assetBrowserDisplay: z.enum(["grouped", "ungrouped"]).optional(),
  }) satisfies z.ZodType<ProjectDocumentConfig>;

const timelineTrackSchema = z
  .object({
    id: z.string(),
    type: trackTypeSchema.optional(),
    label: z.string(),
    isVisible: z.boolean(),
    isMuted: z.boolean(),
    isLocked: z.boolean(),
  })
  .passthrough() as unknown as z.ZodType<TimelineTrack>;

const transitionSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    outgoingClipId: z.string(),
    incomingClipId: z.string(),
    schemaVersion: z.number().int().positive().optional(),
    parameters: z.record(z.string(), z.unknown()),
  })
  .passthrough() as unknown as z.ZodType<Transition>;

const clipTransformSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    isEnabled: z.boolean(),
    parameters: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const timelineClipSchema = z
  .object({
    id: z.string(),
    type: z.enum([
      "video",
      "image",
      "audio",
      "text",
      "shape",
      "extension",
      "mask",
      "composite",
      "adjustment",
    ]),
    trackId: z.string(),
    name: z.string(),
    sourceDuration: z.number().nullable(),
    transformedDuration: z.number(),
    transformedOffset: z.number(),
    timelineDuration: z.number(),
    croppedSourceDuration: z.number(),
    offset: z.number(),
    start: z.number(),
    transformations: z.array(clipTransformSchema),
    extensionPayload: extensionPayloadSchema.optional(),
    compositeId: z.string().optional(),
    compositeRevision: z.number().int().positive().optional(),
    // Adjustment-clip extras (sit on the same passthrough; required when
    // type === "adjustment", enforced by the superRefine below).
    depth: z
      .union([
        z.number().int().min(1),
        z.literal(ADJUSTMENT_DEPTH_ALL),
      ])
      .optional(),
    retimingMode: z
      .enum([ADJUSTMENT_RETIMING_STATIC, ADJUSTMENT_RETIMING_RIPPLE])
      .optional(),
  })
  .passthrough()
  .superRefine((clip, ctx) => {
    if (clip.type === "extension" && clip.extensionPayload === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Extension clips require a versioned extensionPayload.",
        path: ["extensionPayload"],
      });
    }
    if (clip.type === "adjustment") {
      if (
        typeof clip.depth !== "number" &&
        clip.depth !== ADJUSTMENT_DEPTH_ALL
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Adjustment clips require an integer depth ≥ 1 or "all".',
          path: ["depth"],
        });
      }
      if (typeof clip.sourceDuration !== "number") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Adjustment clips require a numeric sourceDuration.",
          path: ["sourceDuration"],
        });
      }
    }
  }) as unknown as z.ZodType<TimelineClip>;

const assetFamilyCompatibilitySchema = z
  .object({
    assetType: assetTypeSchema,
    durationMs: z.number().nullable(),
    fpsMilli: z.number().nullable(),
  })
  .passthrough() satisfies z.ZodType<AssetFamilyCompatibility>;

const assetFamilySchema = z
  .object({
    id: z.string(),
    representativeAssetId: z.string().optional(),
    autoMatchKeys: z.array(z.string()).optional(),
    compatibility: assetFamilyCompatibilitySchema,
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .passthrough() satisfies z.ZodType<AssetFamily>;

const creationMetadataSchema = z.custom<CreationMetadata>(
  (value) => Boolean(value && typeof value === "object" && !Array.isArray(value)),
  "Expected creation metadata object",
);

export const projectManifestDocumentSchema = z.object({
  documentType: z.literal("vlo.project"),
  schemaVersion: z.literal(PROJECT_MANIFEST_SCHEMA_VERSION),
  id: z.string(),
  title: z.string(),
  created_at: z.number(),
  last_modified: z.number(),
  createdWithVloVersion: z.string().optional(),
  lastSavedWithVloVersion: z.string().optional(),
  migratedFromSchemaVersion: z.number().optional(),
  config: projectDocumentConfigSchema,
  files: z.object({
    timeline: z.literal(PROJECT_FILE_NAMES.timeline),
    assets: z.literal(PROJECT_FILE_NAMES.assets),
    composites: z.literal(PROJECT_FILE_NAMES.composites).optional(),
    assetMetadataDir: z.literal(PROJECT_FILE_NAMES.assetMetadataDir),
  }),
});

export const timelineDocumentSchema = z.object({
  documentType: z.literal("vlo.timeline"),
  schemaVersion: z.literal(TIMELINE_DOCUMENT_SCHEMA_VERSION),
  updated_at: z.number(),
  tracks: z.array(timelineTrackSchema),
  clips: z.array(timelineClipSchema),
  transitions: z.array(transitionSchema).default([]),
});

export const timelineDocumentSchemaV2 = z.object({
  documentType: z.literal("vlo.timeline"),
  schemaVersion: z.literal(2),
  updated_at: z.number(),
  tracks: z.array(timelineTrackSchema),
  clips: z.array(timelineClipSchema),
  transitions: z.array(transitionSchema).optional(),
});

/**
 * v1 timeline documents predate render groups and adjustment clips. The
 * persistence service reads with this schema as a fallback and rewrites the
 * document at the current version.
 *
 * Note on the scaffolding interlude: an unshipped branch experimented with a
 * top-level `groups: TimelineGroup[]` field under schemaVersion 2 before the
 * adjustment-clip design replaced it. That shape was never blessed as a
 * production schema; stale dev-branch docs are tolerated implicitly through
 * Zod's strip-on-parse default — the current reader simply drops the unknown
 * `groups` key when reading.
 */
export const timelineDocumentSchemaV1 = z.object({
  documentType: z.literal("vlo.timeline"),
  schemaVersion: z.literal(1),
  updated_at: z.number(),
  tracks: z.array(timelineTrackSchema),
  clips: z.array(timelineClipSchema),
  transitions: z.array(transitionSchema).optional(),
});

export const persistedAssetIndexEntrySchema = z
  .object({
    id: z.string(),
    hash: z.string(),
    familyId: z.string().optional(),
    name: z.string(),
    type: assetTypeSchema,
    favourite: z.boolean().optional(),
    src: projectRelativePathSchema,
    thumbnail: projectRelativePathSchema.optional(),
    proxySrc: projectRelativePathSchema.optional(),
    duration: z.number().optional(),
    fps: z.number().optional(),
    hasAudio: z.boolean().optional(),
    createdAt: z.number(),
    creationMetadata: creationMetadataSchema.optional(),
    metadataRef: projectRelativePathSchema.optional(),
  })
  .passthrough();

export const assetIndexDocumentSchema = z.object({
  documentType: z.literal("vlo.assets"),
  schemaVersion: z.literal(ASSET_INDEX_DOCUMENT_SCHEMA_VERSION),
  updated_at: z.number(),
  assets: z.record(z.string(), persistedAssetIndexEntrySchema),
  assetFamilies: z.record(z.string(), assetFamilySchema),
});

export const assetMetadataDocumentSchema = z.object({
  documentType: z.literal("vlo.assetMetadata"),
  schemaVersion: z.literal(ASSET_METADATA_DOCUMENT_SCHEMA_VERSION),
  assetId: z.string(),
  updated_at: z.number(),
  creationMetadata: creationMetadataSchema,
});

const compositeContentSchema = z
  .object({
    clips: z.array(timelineClipSchema),
    tracks: z.array(timelineTrackSchema).optional(),
    transitions: z.array(transitionSchema).optional(),
    includedTrackIds: z.array(z.string()).optional(),
    fps: z.number().positive().optional(),
    frameStep: z.number().positive().optional(),
    frameOffset: z.number().positive().optional(),
    durationTicks: z.number(),
  })
  .passthrough();

const compositeAssetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    content: compositeContentSchema,
    revision: z.number().int().positive().optional(),
    bake: z
      .object({
        status: z.enum(["none", "queued", "rendering", "ready", "failed"]),
        requestedKey: z.string().optional(),
        readyKey: z.string().optional(),
        readyRevision: z.number().int().positive().optional(),
        assetId: z.string().optional(),
        error: z.string().optional(),
        updatedAt: z.number().optional(),
      })
      .optional(),
    bakedAssetId: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .passthrough() as unknown as z.ZodType<CompositeAsset>;

export const compositeLibraryDocumentSchema = z.object({
  documentType: z.literal("vlo.composites"),
  schemaVersion: z.literal(COMPOSITE_LIBRARY_DOCUMENT_SCHEMA_VERSION),
  updated_at: z.number(),
  composites: z.record(z.string(), compositeAssetSchema),
});

/**
 * Extension project storage (extension-shell-surfaces plan §4): one namespace
 * of JSON key/values per extension ID. Retention over reconstruction — the
 * document round-trips namespaces of uninstalled extensions untouched.
 */
export const extensionStorageDocumentSchema = z.object({
  documentType: z.literal("vlo.extension-storage"),
  schemaVersion: z.literal(EXTENSION_STORAGE_DOCUMENT_SCHEMA_VERSION),
  updated_at: z.number(),
  storage: z.record(z.string(), z.record(z.string(), jsonValueSchema)),
});

export type ExtensionStorageDocument = z.infer<
  typeof extensionStorageDocumentSchema
>;

/**
 * The generation panel's last active state for this project: which workflow
 * was loaded and what its inputs held. The payload itself is opaque here —
 * the generation feature owns and validates its shape — so this layer only
 * guarantees that what round-trips is JSON.
 */
export const generationPanelDocumentSchema = z.object({
  documentType: z.literal("vlo.generation-panel"),
  schemaVersion: z.literal(GENERATION_PANEL_DOCUMENT_SCHEMA_VERSION),
  updated_at: z.number(),
  panel: jsonValueSchema.nullable(),
});

export type GenerationPanelDocument = z.infer<
  typeof generationPanelDocumentSchema
>;

/** v1 composites only carried their canonical content and legacy bake pointer. */
export const compositeLibraryDocumentSchemaV1 = z.object({
  documentType: z.literal("vlo.composites"),
  schemaVersion: z.literal(1),
  updated_at: z.number(),
  composites: z.record(z.string(), compositeAssetSchema),
});

export const legacyTimelineSnapshotSchema = z
  .object({
    tracks: z.array(timelineTrackSchema).optional(),
    clips: z.array(timelineClipSchema).optional(),
    transitions: z.array(transitionSchema).optional(),
  })
  .passthrough();

export const legacyProjectDocumentSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    version: z.string().optional(),
    schemaVersion: z.number().optional(),
    createdWithVloVersion: z.string().optional(),
    lastSavedWithVloVersion: z.string().optional(),
    created_at: z.number().optional(),
    last_modified: z.number().optional(),
    config: projectDocumentConfigSchema.optional(),
    assets: z
      .record(
        z.string(),
        z.custom<Asset>(
          (value) =>
            Boolean(value && typeof value === "object" && !Array.isArray(value)),
          "Expected asset object",
        ),
      )
      .optional(),
    assetFamilies: z.record(z.string(), assetFamilySchema).optional(),
    timeline: legacyTimelineSnapshotSchema.optional(),
  })
  .passthrough();

export type ProjectManifestDocument = z.infer<
  typeof projectManifestDocumentSchema
>;
export type TimelineDocument = z.infer<typeof timelineDocumentSchema>;
export type PersistedAssetIndexEntry = z.infer<
  typeof persistedAssetIndexEntrySchema
>;
export type AssetIndexDocument = z.infer<typeof assetIndexDocumentSchema>;
export type AssetMetadataDocument = z.infer<typeof assetMetadataDocumentSchema>;
export type CompositeLibraryDocument = z.infer<
  typeof compositeLibraryDocumentSchema
>;
export type LegacyProjectDocument = z.infer<typeof legacyProjectDocumentSchema>;

export const PROJECT_PERSISTENCE_FILE_NAMES = PROJECT_FILE_NAMES;
