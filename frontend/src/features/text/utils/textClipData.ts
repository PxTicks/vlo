import type {
  TextAlignment,
  TextClipData,
} from "../../../types/TimelineTypes";
import {
  DEFAULT_TEXT_ALIGNMENT,
  DEFAULT_TEXT_CONTENT,
  DEFAULT_TEXT_FILL,
  DEFAULT_TEXT_FONT_FAMILY,
  DEFAULT_TEXT_FONT_SIZE,
} from "../constants";

const VALID_TEXT_ALIGNMENTS = new Set<TextAlignment>([
  "left",
  "center",
  "right",
]);
const MAX_TEXT_NAME_LENGTH = 40;

function normalizeTextAlignment(value: unknown): TextAlignment {
  return VALID_TEXT_ALIGNMENTS.has(value as TextAlignment)
    ? (value as TextAlignment)
    : DEFAULT_TEXT_ALIGNMENT;
}

function normalizeFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TEXT_FONT_SIZE;
  }

  return Math.max(8, Math.min(400, Math.round(value)));
}

function normalizeColor(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value
    : DEFAULT_TEXT_FILL;
}

export function resolveTextClipData(
  value?: Partial<TextClipData> | null,
): TextClipData {
  return {
    content:
      typeof value?.content === "string"
        ? value.content
        : DEFAULT_TEXT_CONTENT,
    fontFamily:
      typeof value?.fontFamily === "string" && value.fontFamily.trim()
        ? value.fontFamily
        : DEFAULT_TEXT_FONT_FAMILY,
    fontSize: normalizeFontSize(value?.fontSize),
    fill: normalizeColor(value?.fill),
    align: normalizeTextAlignment(value?.align),
  };
}

export function deriveTextClipName(content: string): string {
  const firstNonEmptyLine = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstNonEmptyLine) {
    return "Text";
  }

  if (firstNonEmptyLine.length <= MAX_TEXT_NAME_LENGTH) {
    return firstNonEmptyLine;
  }

  return `${firstNonEmptyLine.slice(0, MAX_TEXT_NAME_LENGTH - 3).trimEnd()}...`;
}
