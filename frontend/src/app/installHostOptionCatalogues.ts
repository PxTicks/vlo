import {
  declareCanvasBrushPresets,
  declareExportFormats,
} from "../features/player/publicApi";
import { declareAnimationOptionCatalogues } from "../features/transformations/publicApi";
import { declareLibrarySortModes } from "../features/userAssets/publicApi";

/** Composition-root installation before any frontend extension activates. */
export function installHostOptionCatalogues(): void {
  declareAnimationOptionCatalogues();
  declareCanvasBrushPresets();
  declareExportFormats();
  declareLibrarySortModes();
}
