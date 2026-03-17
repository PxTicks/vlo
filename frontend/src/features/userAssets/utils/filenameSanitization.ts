const INVALID_FILE_NAME_CHARACTERS = /[<>:"/\\|?*]/g;
const CONTROL_OR_FORMAT_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;
const WHITESPACE_SEQUENCE = /\s+/g;
const LEADING_OR_TRAILING_DOTS_AND_SPACES = /^[.\s]+|[.\s]+$/g;
const TRAILING_DOTS_AND_SPACES = /[.\s]+$/g;
const WINDOWS_RESERVED_FILE_STEMS = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);
const MAX_SAFE_FILENAME_LENGTH = 180;

interface FilenameParts {
  stem: string;
  extension: string;
}

interface SanitizeFilenamePartOptions {
  trimLeadingDots: boolean;
}

function splitFilename(name: string): FilenameParts {
  const trimmedName = name.trim();
  const lastDotIndex = trimmedName.lastIndexOf(".");

  if (lastDotIndex <= 0) {
    return { stem: trimmedName, extension: "" };
  }

  return {
    stem: trimmedName.slice(0, lastDotIndex),
    extension: trimmedName.slice(lastDotIndex + 1),
  };
}

function sanitizeFilenamePart(
  value: string,
  options: SanitizeFilenamePartOptions,
): string {
  let sanitized = value
    .normalize("NFKC")
    .replace(CONTROL_OR_FORMAT_CHARACTERS, "")
    .replace(INVALID_FILE_NAME_CHARACTERS, "_")
    .replace(WHITESPACE_SEQUENCE, " ")
    .trim();

  sanitized = options.trimLeadingDots
    ? sanitized.replace(LEADING_OR_TRAILING_DOTS_AND_SPACES, "")
    : sanitized.replace(TRAILING_DOTS_AND_SPACES, "");

  return sanitized;
}

function truncateFilenameStem(stem: string, extension: string): string {
  const extensionBudget = extension ? extension.length + 1 : 0;
  const maxStemLength = Math.max(
    1,
    MAX_SAFE_FILENAME_LENGTH - extensionBudget,
  );

  if (stem.length <= maxStemLength) {
    return stem;
  }

  return stem.slice(0, maxStemLength).replace(TRAILING_DOTS_AND_SPACES, "");
}

export function sanitizeFilename(name: string): string {
  const { stem: rawStem, extension: rawExtension } = splitFilename(name);
  let stem = sanitizeFilenamePart(rawStem, {
    trimLeadingDots: true,
  });
  const extension = sanitizeFilenamePart(rawExtension, {
    trimLeadingDots: false,
  });

  if (!stem) {
    stem = "unnamed_file";
  }

  if (WINDOWS_RESERVED_FILE_STEMS.has(stem.toUpperCase())) {
    stem = `${stem}_file`;
  }

  stem = truncateFilenameStem(stem, extension);
  if (!stem) {
    stem = "unnamed_file";
  }

  return extension ? `${stem}.${extension}` : stem;
}
