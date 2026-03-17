export function normalizeWorkflowFilename(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const segments = trimmed.split("/").filter(Boolean);
  const filename = segments.at(-1)?.trim() ?? trimmed;
  if (!filename) return null;

  return /\.json$/i.test(filename) ? filename : `${filename}.json`;
}

export function isSafeWorkflowFilename(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !trimmed.includes("/") && !trimmed.includes("\\") && !trimmed.includes("..");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isTemporaryWorkflowDuplicateFilename(
  candidate: string,
  original: string,
): boolean {
  const normalizedCandidate = normalizeWorkflowFilename(candidate);
  const normalizedOriginal = normalizeWorkflowFilename(original);
  if (!normalizedCandidate || !normalizedOriginal) return false;

  const originalStem = normalizedOriginal.replace(/\.json$/i, "");
  const duplicatePattern = new RegExp(
    `^${escapeRegExp(originalStem)} \\(\\d+\\)\\.json$`,
    "i",
  );

  return duplicatePattern.test(normalizedCandidate);
}
