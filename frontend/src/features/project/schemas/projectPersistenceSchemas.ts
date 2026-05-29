import { z } from "zod";
import type {
  Asset,
  AssetFamily,
  AssetFamilyCompatibility,
  AssetType,
  CreationMetadata,
} from "../../../types/Asset";
import type {
  TimelineClip,
  TimelineTrack,
  TrackType,
} from "../../../types/TimelineTypes";
import {
  ASSET_INDEX_DOCUMENT_SCHEMA_VERSION,
  ASSET_METADATA_DOCUMENT_SCHEMA_VERSION,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  TIMELINE_DOCUMENT_SCHEMA_VERSION,
} from "../constants";
import type { ProjectDocumentConfig } from "../types/ProjectDocument";

const PROJECT_FILE_NAMES = {
  timeline: "timeline.json",
  assets: "assets.json",
  assetMetadataDir: "asset-metadata",
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

const assetTypeSchema = z.enum(["video", "image", "audio"]) satisfies z.ZodType<AssetType>;

const trackTypeSchema = z.enum([
  "visual",
  "audio",
  "prompt",
  "effects",
  "mask",
]) satisfies z.ZodType<TrackType>;

export const projectDocumentConfigSchema = z
  .object({
    aspectRatio: z.enum(["16:9", "4:3", "1:1", "3:4", "9:16"]).optional(),
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
      "mask",
      "composite",
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
  })
  .passthrough() as unknown as z.ZodType<TimelineClip>;

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
    assetMetadataDir: z.literal(PROJECT_FILE_NAMES.assetMetadataDir),
  }),
});

export const timelineDocumentSchema = z.object({
  documentType: z.literal("vlo.timeline"),
  schemaVersion: z.literal(TIMELINE_DOCUMENT_SCHEMA_VERSION),
  updated_at: z.number(),
  tracks: z.array(timelineTrackSchema),
  clips: z.array(timelineClipSchema),
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

export const legacyTimelineSnapshotSchema = z
  .object({
    tracks: z.array(timelineTrackSchema).optional(),
    clips: z.array(timelineClipSchema).optional(),
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
export type LegacyProjectDocument = z.infer<typeof legacyProjectDocumentSchema>;

export const PROJECT_PERSISTENCE_FILE_NAMES = PROJECT_FILE_NAMES;
