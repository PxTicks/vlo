import type { TimelineSelection } from "../../../types/TimelineTypes";

const MASK_DEBUG_GLOBAL_KEY = "__VLO_MASK_DEBUG__";
const MAX_MASK_DEBUG_ARTIFACTS = 50;

export interface MaskDebugArtifact {
  id: number;
  category: string;
  createdAt: number;
  file: File;
  fileName: string;
  fileSize: number;
  fileType: string;
  objectUrl: string | null;
  metadata: Record<string, unknown>;
}

interface MaskDebugStore {
  nextId: number;
  artifacts: MaskDebugArtifact[];
}

interface MaskDebugGlobal {
  [MASK_DEBUG_GLOBAL_KEY]?: MaskDebugStore;
}

function getMaskDebugGlobal(): MaskDebugGlobal {
  return globalThis as MaskDebugGlobal;
}

function getMaskDebugStore(): MaskDebugStore {
  const debugGlobal = getMaskDebugGlobal();
  if (!debugGlobal[MASK_DEBUG_GLOBAL_KEY]) {
    debugGlobal[MASK_DEBUG_GLOBAL_KEY] = {
      nextId: 1,
      artifacts: [],
    };
  }
  return debugGlobal[MASK_DEBUG_GLOBAL_KEY];
}

function createObjectUrl(file: File): string | null {
  if (
    typeof globalThis.URL?.createObjectURL !== "function"
  ) {
    return null;
  }

  try {
    return globalThis.URL.createObjectURL(file);
  } catch {
    return null;
  }
}

function revokeObjectUrl(objectUrl: string | null): void {
  if (!objectUrl || typeof globalThis.URL?.revokeObjectURL !== "function") {
    return;
  }

  try {
    globalThis.URL.revokeObjectURL(objectUrl);
  } catch {
    // Best-effort debug cleanup only.
  }
}

export function summarizeSelectionForMaskDebug(
  selection: TimelineSelection,
): Record<string, unknown> {
  return {
    selectionStart: selection.start,
    selectionEnd: selection.end ?? null,
    selectionFps: selection.fps ?? null,
    selectionFrameStep: selection.frameStep ?? null,
    selectionClipIds: (selection.clips ?? []).map((clip) => clip.id),
  };
}

export function recordMaskDebugArtifact(options: {
  category: string;
  file: File | null | undefined;
  metadata?: Record<string, unknown>;
}): MaskDebugArtifact | null {
  if (!options.file) {
    return null;
  }

  const store = getMaskDebugStore();
  const artifact: MaskDebugArtifact = {
    id: store.nextId,
    category: options.category,
    createdAt: Date.now(),
    file: options.file,
    fileName: options.file.name,
    fileSize: options.file.size,
    fileType: options.file.type,
    objectUrl: createObjectUrl(options.file),
    metadata: options.metadata ?? {},
  };
  store.nextId += 1;
  store.artifacts.push(artifact);

  while (store.artifacts.length > MAX_MASK_DEBUG_ARTIFACTS) {
    const removed = store.artifacts.shift();
    if (removed) {
      revokeObjectUrl(removed.objectUrl);
    }
  }

  console.info("[Generation][MaskDebug] saved mask artifact", {
    id: artifact.id,
    category: artifact.category,
    fileName: artifact.fileName,
    fileSize: artifact.fileSize,
    fileType: artifact.fileType,
    objectUrl: artifact.objectUrl,
    metadata: artifact.metadata,
    globalKey: `globalThis.${MASK_DEBUG_GLOBAL_KEY}.artifacts`,
  });

  return artifact;
}
