import type {
  TextAlignment,
  TextClipData,
  TextRun,
} from "../../../types/TimelineTypes";
import {
  DEFAULT_TEXT_ALIGNMENT,
  DEFAULT_TEXT_CONTENT,
  DEFAULT_TEXT_FILL,
  DEFAULT_TEXT_FONT_FAMILY,
  DEFAULT_TEXT_FONT_SIZE,
  DEFAULT_TEXT_STROKE_COLOR,
  DEFAULT_TEXT_STROKE_WIDTH,
  MAX_TEXT_STROKE_WIDTH,
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

function normalizeStrokeColor(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value
    : DEFAULT_TEXT_STROKE_COLOR;
}

function normalizeStrokeWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TEXT_STROKE_WIDTH;
  }

  return Math.max(0, Math.min(MAX_TEXT_STROKE_WIDTH, Math.round(value)));
}

function normalizeRuns(value: unknown): TextRun[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const runs: TextRun[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Partial<TextRun>;
    if (typeof candidate.text !== "string" || candidate.text.length === 0) {
      continue;
    }
    const run: TextRun = { text: candidate.text };
    if (candidate.bold === true) {
      run.bold = true;
    }
    if (candidate.italic === true) {
      run.italic = true;
    }
    runs.push(run);
  }

  return runs.length > 0 ? mergeAdjacentRuns(runs) : undefined;
}

export function mergeAdjacentRuns(runs: TextRun[]): TextRun[] {
  const merged: TextRun[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      Boolean(last.bold) === Boolean(run.bold) &&
      Boolean(last.italic) === Boolean(run.italic)
    ) {
      last.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

export function runsToPlainText(runs: TextRun[]): string {
  return runs.map((run) => run.text).join("");
}

export function hasRichFormatting(runs: TextRun[] | undefined): boolean {
  if (!runs) {
    return false;
  }
  return runs.some((run) => run.bold === true || run.italic === true);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/gu, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    return "&gt;";
  });
}

export function runsToHtml(runs: TextRun[]): string {
  return runs
    .map((run) => {
      let html = escapeHtml(run.text).replace(/\n/gu, "<br/>");
      if (run.italic === true) {
        html = `<i>${html}</i>`;
      }
      if (run.bold === true) {
        html = `<b>${html}</b>`;
      }
      return html;
    })
    .join("");
}

export function plainTextToRuns(content: string): TextRun[] {
  return content.length > 0 ? [{ text: content }] : [];
}

export function resolveTextClipData(
  value?: Partial<TextClipData> | null,
): TextClipData {
  const runs = normalizeRuns(value?.runs);
  const resolvedContent =
    typeof value?.content === "string"
      ? value.content
      : runs !== undefined
        ? runsToPlainText(runs)
        : DEFAULT_TEXT_CONTENT;

  return {
    content: resolvedContent,
    ...(runs !== undefined ? { runs } : {}),
    fontFamily:
      typeof value?.fontFamily === "string" && value.fontFamily.trim()
        ? value.fontFamily
        : DEFAULT_TEXT_FONT_FAMILY,
    fontSize: normalizeFontSize(value?.fontSize),
    fill: normalizeColor(value?.fill),
    align: normalizeTextAlignment(value?.align),
    strokeColor: normalizeStrokeColor(value?.strokeColor),
    strokeWidth: normalizeStrokeWidth(value?.strokeWidth),
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
