import { useRef, useState } from "react";
import { Alert, Box, Button, Typography } from "@mui/material";
import { Download, FileUpload } from "@mui/icons-material";
import {
  bakeColorGradeCube,
  DEFAULT_COLOR_CURVES,
  DEFAULT_COLOR_GRADE_LUT,
  DEFAULT_COLOR_GRADE_PRIMARIES,
  DEFAULT_COLOR_QUALIFIER,
  expandCubeLutTo3d,
  parseCubeLut,
  serializeCubeLut,
  type ColorGradeReferenceParameters,
  type CubeLut,
} from "../../../core/color";
import type { CustomControlRenderProps } from "../../panelUI";
import { AssetDropSlot } from "../../panelUI";
import {
  addLocalAsset,
  ensureAssetFileLoaded,
  useAsset,
} from "../../userAssets";

function readLutAssetId(values: Readonly<Record<string, unknown>>): string | null {
  return typeof values.lutAssetId === "string" && values.lutAssetId.length > 0
    ? values.lutAssetId
    : null;
}

function numeric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Rebuilds reference parameters from raw panel values. Keyframed scalars are
 * stored as spline objects and fall back to their defaults here — the export
 * captures the grade's static values, not one animation instant.
 */
function readReferenceParameters(
  values: Readonly<Record<string, unknown>>,
): ColorGradeReferenceParameters {
  const parameters: Record<string, unknown> = {
    ...DEFAULT_COLOR_GRADE_PRIMARIES,
    ...DEFAULT_COLOR_QUALIFIER,
    ...DEFAULT_COLOR_CURVES,
    ...DEFAULT_COLOR_GRADE_LUT,
  };
  for (const [name, fallback] of Object.entries(parameters)) {
    const value = values[name];
    if (typeof fallback === "number") {
      parameters[name] = numeric(value, fallback);
    } else if (typeof fallback === "boolean") {
      parameters[name] = typeof value === "boolean" ? value : fallback;
    } else if (Array.isArray(fallback)) {
      parameters[name] = Array.isArray(value) ? value : fallback;
    }
  }
  return parameters as unknown as ColorGradeReferenceParameters;
}

async function loadCubeLutFromAsset(assetId: string): Promise<CubeLut | null> {
  const file = await ensureAssetFileLoaded(assetId);
  if (!file) return null;
  return expandCubeLutTo3d(parseCubeLut(await file.text()));
}

function downloadCubeFile(contents: string, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([contents], { type: "text/plain" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function LutControl({
  values,
  onCommitMany,
  disabled,
}: CustomControlRenderProps) {
  const lutAssetId = readLutAssetId(values);
  const asset = useAsset(lutAssetId);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [message, setMessage] = useState<{
    severity: "error" | "info";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const commitLutAsset = (assetId: string | null): void => {
    setMessage(null);
    onCommitMany({ lutAssetId: assetId });
  };

  const importLutFile = async (file: File): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      // Validate before ingesting so a broken file never becomes an asset.
      parseCubeLut(await file.text());
      const created = await addLocalAsset(file);
      if (created) {
        commitLutAsset(created.id);
      } else {
        setMessage({
          severity: "info",
          text: "This LUT is already in the library — drop it from the LUT tab of the asset browser.",
        });
      }
    } catch (error) {
      setMessage({
        severity: "error",
        text:
          error instanceof Error ? error.message : "Could not read LUT file",
      });
    } finally {
      setBusy(false);
    }
  };

  const exportGrade = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const lut = lutAssetId ? await loadCubeLutFromAsset(lutAssetId) : null;
      const baked = bakeColorGradeCube(readReferenceParameters(values), {
        lut,
        title: "vlo color grade",
      });
      downloadCubeFile(serializeCubeLut(baked), "grade.cube");
    } catch (error) {
      setMessage({
        severity: "error",
        text:
          error instanceof Error ? error.message : "Could not export grade",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.5 }}>
        <AssetDropSlot
          id="color-grade-lut"
          accept={["lut"]}
          label="Creative LUT (.cube)"
          value={asset ? { type: "lut", name: asset.name } : null}
          onClear={disabled ? undefined : () => commitLutAsset(null)}
          onDrop={disabled ? undefined : (dropped) => commitLutAsset(dropped.id)}
          onExternalDrop={disabled ? undefined : importLutFile}
          onSelect={disabled ? undefined : () => fileInputRef.current?.click()}
        />
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, pt: 2.5 }}>
          <Button
            size="small"
            startIcon={<FileUpload />}
            disabled={disabled || busy}
            onClick={() => fileInputRef.current?.click()}
          >
            Browse…
          </Button>
          <Button
            size="small"
            startIcon={<Download />}
            disabled={disabled || busy}
            onClick={() => void exportGrade()}
          >
            Export .cube
          </Button>
        </Box>
      </Box>
      <input
        ref={fileInputRef}
        type="file"
        accept=".cube"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importLutFile(file);
        }}
      />
      {message ? (
        <Alert severity={message.severity} sx={{ mt: 1, py: 0 }}>
          {message.text}
        </Alert>
      ) : null}
      {lutAssetId && !asset ? (
        <Typography variant="caption" sx={{ color: "warning.main" }}>
          The referenced LUT asset is missing from this project.
        </Typography>
      ) : null}
    </Box>
  );
}
