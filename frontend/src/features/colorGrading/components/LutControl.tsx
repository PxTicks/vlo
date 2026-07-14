import {
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Alert,
  Box,
  Button,
  MenuItem,
  Select,
  Typography,
} from "@mui/material";
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
  ensureAssetFileLoaded,
  useAsset,
} from "../../userAssets";
import { ingestExtensionAsset } from "../../extensions/assets/publicApi";
import { extensionLutRegistry } from "../../extensions/registry/publicApi";

const LOOK_PACK_FETCH_TIMEOUT_MS = 15_000;

function subscribeExtensionLuts(listener: () => void): () => void {
  return extensionLutRegistry.subscribe(listener);
}

function getExtensionLutRevision(): number {
  return extensionLutRegistry.getRevision();
}

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

async function fetchLookPackLut(resourceUrl: string): Promise<Blob> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    LOOK_PACK_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(resourceUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error("The look-pack resource is no longer available.");
    }
    return await response.blob();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The look-pack resource took too long to load.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
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
  const extensionLutRevision = useSyncExternalStore(
    subscribeExtensionLuts,
    getExtensionLutRevision,
    getExtensionLutRevision,
  );
  const extensionLuts = useMemo(
    () => extensionLutRegistry.list(),
    // `extensionLutRevision` is the registry's change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extensionLutRevision],
  );

  const commitLutAsset = (assetId: string | null): void => {
    setMessage(null);
    onCommitMany({ lutAssetId: assetId });
  };

  const materializeLutFile = async (file: File): Promise<string> => {
    const created = await ingestExtensionAsset({
      name: file.name,
      type: "lut",
      blob: file,
    });
    return created.id;
  };

  const importLutFile = async (file: File): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const assetId = await materializeLutFile(file);
      commitLutAsset(assetId);
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

  const applyExtensionLut = async (contributionId: string): Promise<void> => {
    const contribution = extensionLuts.find(
      (candidate) => candidate.id === contributionId,
    );
    if (!contribution) return;

    setBusy(true);
    setMessage(null);
    try {
      const blob = await fetchLookPackLut(
        contribution.definition.resourceUrl,
      );
      const filename = `${contribution.ownerId}.${contribution.localId}.cube`;
      const assetId = await materializeLutFile(
        new File([blob], filename, { type: "text/plain" }),
      );
      commitLutAsset(assetId);
      setMessage({
        severity: "info",
        text: `Applied ${contribution.definition.label}. The LUT is now stored in this project.`,
      });
    } catch (error) {
      setMessage({
        severity: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not apply look-pack LUT",
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
      {extensionLuts.length > 0 ? (
        <Select
          size="small"
          displayEmpty
          fullWidth
          value=""
          disabled={disabled || busy}
          aria-label="Look pack LUT"
          onChange={(event) => void applyExtensionLut(event.target.value)}
          sx={{ mb: 1 }}
        >
          <MenuItem value="" disabled>
            Apply from look packs…
          </MenuItem>
          {extensionLuts.map((contribution) => (
            <MenuItem key={contribution.id} value={contribution.id}>
              {contribution.definition.label} — {contribution.ownerId}
            </MenuItem>
          ))}
        </Select>
      ) : null}
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
