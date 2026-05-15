import { isRecord } from "./parsers";
import { getWorkflowClassTypeLookupKeys } from "../utils/workflowClassTypes";

export function normalizeNodeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveClassInfo(
  objectInfo: Record<string, unknown> | null | undefined,
  classType: string | undefined,
): Record<string, unknown> | null {
  if (!objectInfo || !classType) return null;

  for (const key of getWorkflowClassTypeLookupKeys(classType)) {
    const classInfo = objectInfo[key];
    if (isRecord(classInfo)) {
      return classInfo;
    }
  }

  return null;
}

export function resolveObjectInfoDisplayName(
  objectInfo: Record<string, unknown> | null | undefined,
  classType: string | undefined,
): string | null {
  const classInfo = resolveClassInfo(objectInfo, classType);
  return normalizeNodeName(classInfo?.display_name);
}

export function resolveNodeDisplayTitle(options: {
  workflowTitle?: unknown;
  graphTitle?: unknown;
  ruleTitle?: unknown;
  classType?: string | undefined;
  objectInfo?: Record<string, unknown> | null | undefined;
  fallback?: unknown;
}): string | null {
  return (
    normalizeNodeName(options.workflowTitle) ??
    normalizeNodeName(options.graphTitle) ??
    normalizeNodeName(options.ruleTitle) ??
    resolveObjectInfoDisplayName(options.objectInfo, options.classType) ??
    normalizeNodeName(options.classType) ??
    normalizeNodeName(options.fallback)
  );
}
