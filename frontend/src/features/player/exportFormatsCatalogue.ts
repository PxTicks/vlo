import {
  hostOptionCatalog,
  type CatalogueOptionEntry,
} from "../../core/shell/optionCatalog";
import type { OutputVideoFormat } from "../renderer/services/TextureOutputEncoder";

export const EXPORT_FORMATS_CATALOGUE = "export.formats";
export const DEFAULT_EXPORT_FORMAT_ID = "mp4";

export interface ExportFormatValue {
  readonly format: OutputVideoFormat;
  readonly extension: "mp4" | "webm";
  readonly mimeType: "video/mp4" | "video/webm";
  readonly keyFrameInterval?: number;
}

function isExportFormatValue(value: unknown): value is ExportFormatValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as {
    format?: unknown;
    extension?: unknown;
    mimeType?: unknown;
    keyFrameInterval?: unknown;
  };
  const mp4 =
    candidate.format === "mp4" &&
    candidate.extension === "mp4" &&
    candidate.mimeType === "video/mp4";
  const webm =
    candidate.format === "webm" &&
    candidate.extension === "webm" &&
    candidate.mimeType === "video/webm";
  return (
    (mp4 || webm) &&
    (candidate.keyFrameInterval === undefined ||
      (typeof candidate.keyFrameInterval === "number" &&
        Number.isFinite(candidate.keyFrameInterval) &&
        candidate.keyFrameInterval > 0))
  );
}

let declared = false;

export function declareExportFormats(): void {
  if (declared) return;
  declared = true;
  hostOptionCatalog.declare({
    id: EXPORT_FORMATS_CATALOGUE,
    validateValue: isExportFormatValue,
    valueSchema: {
      format: "'mp4' | 'webm'",
      extension: "'mp4' | 'webm' (must match format)",
      mimeType: "'video/mp4' | 'video/webm' (must match format)",
      keyFrameInterval: "positive number | omitted",
    },
  });
  hostOptionCatalog.registerHostOption(EXPORT_FORMATS_CATALOGUE, {
    id: "mp4",
    label: "MP4 (H.264/AAC)",
    value: {
      format: "mp4",
      extension: "mp4",
      mimeType: "video/mp4",
    },
    order: 0,
  });
  hostOptionCatalog.registerHostOption(EXPORT_FORMATS_CATALOGUE, {
    id: "webm",
    label: "WebM (VP9/Opus)",
    value: {
      format: "webm",
      extension: "webm",
      mimeType: "video/webm",
    },
    order: 1,
  });
}

export function readExportFormatValue(
  option: CatalogueOptionEntry | undefined,
): ExportFormatValue | null {
  return option && isExportFormatValue(option.value) ? option.value : null;
}

