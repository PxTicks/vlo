import type {
  ExtensionAssetIngestInput,
  ExtensionEntityAssetSnapshot,
} from "@vlo/extension-sdk";
import { parseCubeLut } from "../../../core/color";
import {
  addLocalAsset,
  toExtensionAssetSnapshot,
  waitForAssetPersistence,
} from "../../userAssets/api";

const MAX_EXTENSION_LUT_BYTES = 16 * 1024 * 1024;
const INGEST_ASSET_TYPES = new Set(["video", "image", "audio", "lut"]);

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/**
 * Host implementation shared by the extension facade and host-owned package
 * materialization. Keeping one path makes the public ingest contract exercise
 * the same validation, deduplication, and persistence behaviour as look packs.
 */
export async function ingestExtensionAsset(
  input: ExtensionAssetIngestInput,
  signal?: AbortSignal,
): Promise<ExtensionEntityAssetSnapshot> {
  abortIfNeeded(signal);
  const name = input.name.trim();
  if (!name || name.includes("/") || name.includes("\\")) {
    throw new Error("Asset ingest name must be a plain filename.");
  }
  if (!(input.blob instanceof Blob)) {
    throw new TypeError("Asset ingest requires a Blob.");
  }
  if (!INGEST_ASSET_TYPES.has(input.type)) {
    throw new Error(`Unsupported asset ingest type '${String(input.type)}'.`);
  }
  if (input.type === "lut") {
    if (!name.toLowerCase().endsWith(".cube")) {
      throw new Error("A LUT asset name must end in .cube.");
    }
    if (input.blob.size > MAX_EXTENSION_LUT_BYTES) {
      throw new Error("A LUT asset cannot exceed 16 MiB.");
    }
    parseCubeLut(await input.blob.text());
    abortIfNeeded(signal);
  } else if (!input.blob.type.startsWith(`${input.type}/`)) {
    throw new Error(
      `Asset ingest Blob type must match the declared '${input.type}' type.`,
    );
  }

  const file = new File([input.blob], name, { type: input.blob.type });
  const asset = await addLocalAsset(
    file,
    { source: "uploaded" },
    undefined,
    {
      expectedType: input.type,
      reuseExistingHash: true,
    },
  );
  abortIfNeeded(signal);
  if (!asset) {
    throw new Error(`Asset '${name}' could not be ingested into the project.`);
  }
  if (asset.type !== input.type) {
    throw new Error(
      `Asset ingest invariant failed: '${name}' was returned as '${asset.type}'.`,
    );
  }
  await waitForAssetPersistence(asset.id);
  abortIfNeeded(signal);
  return toExtensionAssetSnapshot(asset);
}
