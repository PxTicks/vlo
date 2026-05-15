const LEGACY_TO_CANONICAL_WORKFLOW_CLASS_TYPES = {
  VLOMemoryLoadAudio: "vloMemoryLoadAudio",
  VLOMemoryLoadImage: "vloMemoryLoadImage",
  VLOMemoryLoadVideo: "vloMemoryLoadVideo",
} as const;

const CANONICAL_WORKFLOW_CLASS_TYPE_ALIASES: Record<string, readonly string[]> = {
  vloMemoryLoadAudio: ["vloMemoryLoadAudio", "VLOMemoryLoadAudio"],
  vloMemoryLoadImage: ["vloMemoryLoadImage", "VLOMemoryLoadImage"],
  vloMemoryLoadVideo: ["vloMemoryLoadVideo", "VLOMemoryLoadVideo"],
};

function normalizeWorkflowClassType(
  classType: string | null | undefined,
): string | null {
  if (typeof classType !== "string") {
    return null;
  }

  const trimmed = classType.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function canonicalizeWorkflowClassType(
  classType: string | null | undefined,
): string | null {
  const normalized = normalizeWorkflowClassType(classType);
  if (!normalized) {
    return null;
  }

  return LEGACY_TO_CANONICAL_WORKFLOW_CLASS_TYPES[
    normalized as keyof typeof LEGACY_TO_CANONICAL_WORKFLOW_CLASS_TYPES
  ] ?? normalized;
}

export function getWorkflowClassTypeLookupKeys(
  classType: string | null | undefined,
): string[] {
  const normalized = normalizeWorkflowClassType(classType);
  if (!normalized) {
    return [];
  }

  const canonical = canonicalizeWorkflowClassType(normalized);
  if (!canonical) {
    return [];
  }

  const keys: string[] = [];
  const aliases = CANONICAL_WORKFLOW_CLASS_TYPE_ALIASES[canonical] ?? [canonical];

  for (const key of [normalized, ...aliases]) {
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }

  return keys;
}

export function isMemoryLoaderClassType(
  classType: string | null | undefined,
): boolean {
  const canonical = canonicalizeWorkflowClassType(classType);
  return (
    canonical === "vloMemoryLoadAudio" ||
    canonical === "vloMemoryLoadImage" ||
    canonical === "vloMemoryLoadVideo"
  );
}
