import type { Asset, ExtractedAudioClipMetadata } from "../../../types/Asset";
import type {
  ClipTransform,
  StandardTimelineClip,
  TimelineSelection,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { useProjectStore } from "../../project/useProjectStore";
import { ensureAssetSourceLoaded } from "../../userAssets/publicApi";
import { useAssetStore } from "../../userAssets/useAssetStore";
import { mediaProcessingService } from "../../userAssets/services/MediaProcessingService";
import {
  getEntryForTransform,
  isTransformCompatible,
} from "../../transformations/catalogue/TransformationRegistry";

export type AudioExtractableTimelineClip = StandardTimelineClip & {
  type: "audio" | "video";
  assetId: string;
};

function isAudioCompatibleTransform(transform: ClipTransform): boolean {
  const entry = getEntryForTransform(transform);
  if (!entry) {
    return transform.type === "speed" || transform.type === "volume";
  }
  return isTransformCompatible(entry, "audio");
}

export function buildExtractedAudioClipMetadata(
  clip: AudioExtractableTimelineClip,
): ExtractedAudioClipMetadata {
  return {
    sourceAssetId: clip.assetId,
    sourceClipType: clip.type,
    timelineDuration: clip.timelineDuration,
    croppedSourceDuration: clip.croppedSourceDuration,
    offset: clip.offset,
    transformedOffset: clip.transformedOffset,
    transformations: structuredClone(
      (clip.transformations ?? []).filter(isAudioCompatibleTransform),
    ),
  };
}

export function createTimelineSelectionForClipAudioExtraction(
  clip: AudioExtractableTimelineClip,
  track: TimelineTrack,
  fps: number,
): TimelineSelection {
  return {
    start: clip.start,
    end: clip.start + clip.timelineDuration,
    clips: [structuredClone(clip)],
    tracks: [structuredClone(track)],
    includedTrackIds: [track.id],
    fps: Math.max(1, Math.round(fps)),
  };
}

function cloneSourceAudioAssetFile(file: File): File {
  return new File([file], file.name, {
    type: file.type,
    lastModified: Date.now(),
  });
}

async function extractSourceAssetAudioFile(
  clip: AudioExtractableTimelineClip,
): Promise<File | null> {
  console.info("[ClipAudioExtraction] Starting extraction", {
    clipId: clip.id,
    clipType: clip.type,
    assetId: clip.assetId,
    clipName: clip.name,
    timelineDuration: clip.timelineDuration,
    croppedSourceDuration: clip.croppedSourceDuration,
    offset: clip.offset,
    transformedOffset: clip.transformedOffset,
  });

  const sourceAsset = await ensureAssetSourceLoaded(clip.assetId);
  if (!sourceAsset) {
    throw new Error("The source asset for this clip could not be found.");
  }

  console.info("[ClipAudioExtraction] Resolved source asset", {
    clipId: clip.id,
    assetId: sourceAsset.id,
    assetName: sourceAsset.name,
    assetType: sourceAsset.type,
    sourcePath: sourceAsset.sourcePath,
    src: sourceAsset.src,
    hasAudio: sourceAsset.hasAudio,
    fileLoaded: !!sourceAsset.file,
  });

  const sourceFile = sourceAsset.file;
  if (!sourceFile) {
    throw new Error("The source asset file could not be loaded.");
  }

  console.info("[ClipAudioExtraction] Loaded source file", {
    clipId: clip.id,
    assetId: sourceAsset.id,
    fileName: sourceFile.name,
    fileType: sourceFile.type,
    fileSize: sourceFile.size,
  });

  if (sourceAsset.type === "audio") {
    console.info("[ClipAudioExtraction] Source asset is already audio; duplicating file directly.", {
      clipId: clip.id,
      assetId: sourceAsset.id,
      fileName: sourceFile.name,
    });
    return cloneSourceAudioAssetFile(sourceFile);
  }

  console.info("[ClipAudioExtraction] Source asset is video; extracting primary audio track.", {
    clipId: clip.id,
    assetId: sourceAsset.id,
    fileName: sourceFile.name,
  });
  const extractedAudio =
    await mediaProcessingService.extractPrimaryAudioTrack(sourceFile);
  if (!extractedAudio) {
    console.warn("[ClipAudioExtraction] No audio track found on source asset", {
      clipId: clip.id,
      assetId: sourceAsset.id,
      assetName: sourceAsset.name,
      assetType: sourceAsset.type,
      hasAudio: sourceAsset.hasAudio,
      fileName: sourceFile.name,
      fileType: sourceFile.type,
    });
  } else {
    console.info("[ClipAudioExtraction] Extracted audio file", {
      clipId: clip.id,
      assetId: sourceAsset.id,
      extractedName: extractedAudio.name,
      extractedType: extractedAudio.type,
      extractedSize: extractedAudio.size,
    });
  }

  return extractedAudio;
}

export async function extractTimelineClipAudioAsset(
  clip: AudioExtractableTimelineClip,
  track: TimelineTrack,
): Promise<Asset | null> {
  const projectFps = Math.max(1, useProjectStore.getState().config.fps);
  const timelineSelection = createTimelineSelectionForClipAudioExtraction(
    clip,
    track,
    projectFps,
  );
  const extractedAudio = await extractSourceAssetAudioFile(clip);

  if (!extractedAudio) {
    return null;
  }

  return useAssetStore.getState().addLocalAsset(
    extractedAudio,
    {
      source: "extracted",
      timelineSelection,
      extractedAudioClip: buildExtractedAudioClipMetadata(clip),
    },
    undefined,
    {
      allowDuplicateHash: true,
    },
  );
}
