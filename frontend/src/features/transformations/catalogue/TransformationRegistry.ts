/**
 * TransformationRegistry
 *
 * The unified registry that aggregates all transformation definitions.
 * Each transformation is fully self-contained in its own file/folder.
 *
 * This file serves as the:
 * 1. Catalogue of available transformations (Registry)
 * 2. Lookup mechanism for definitions (Helpers)
 * 3. Runtime system configuration (TransformationSystem)
 */

import type {
  TransformationDefinition,
  StateApplicator,
  TransformState,
  TransformContext,
} from "./types";
import type { LayoutGroup } from "./ui/UITypes";
import type { ClipTransform } from "../../../types/TimelineTypes";
import type { GenericFilterTransform } from "../types";

// Import self-contained transformation definitions
import { layoutDefinition, layoutApplicator } from "./layout/layoutDefinition";
import { speedDefinition } from "./time/speed";
import { volumeDefinition } from "./audio/volume";
import { hslFilterDefinition } from "./filters/hslAdjustment";
import { colorAdjustmentDefinition } from "./filters/colorAdjustment";
import { blurFilterDefinition } from "./filters/blur";
import { bloomFilterDefinition } from "./filters/bloom";
import { bulgePinchFilterDefinition } from "./filters/bulgePinch";
import { crtFilterDefinition } from "./filters/crt";
import { glowFilterDefinition } from "./filters/glow";
import { crossHatchFilterDefinition } from "./filters/crossHatch";
import { dotFilterDefinition } from "./filters/dot";
import { glitchFilterDefinition } from "./filters/glitch";
import { godrayFilterDefinition } from "./filters/godray";
import { asciiFilterDefinition } from "./filters/ascii";
import { oldFilmFilterDefinition } from "./filters/oldFilm";
import { reflectionFilterDefinition } from "./filters/reflection";
import { rgbSplitFilterDefinition } from "./filters/rgbSplit";
import { pixelateFilterDefinition } from "./filters/pixelate";
import { shockwaveFilterDefinition } from "./filters/shockwave";
import { twistFilterDefinition } from "./filters/twist";
import { zoomBlurFilterDefinition } from "./filters/zoomBlur";
import { featherDefinition } from "./mask/feather";
import { maskGrowDefinition } from "./mask/grow";
import { filterApplicator } from "./filterFactory";
import { featherApplicator } from "./mask/featherApplicator";
import { colorMatrixDefinition } from "./filters/colorMatrix";

// =============================================================================
// REGISTRY
// =============================================================================

/**
 * The complete list of all registered transformations.
 * `isDefault` is set here centrally — definitions don't carry this flag.
 * Order matters: default (layout) groups should come first.
 */
export const TransformationRegistry: TransformationDefinition[] = [
  // Layout definition (handles position, scale, rotation) — always visible for visual clips
  { ...layoutDefinition, isDefault: true },

  // Volume definition — always visible for audio clips
  { ...volumeDefinition, isDefault: true },

  // Dynamic groups (addable)
  { ...speedDefinition, isDefault: false },

  // Filters
  { ...hslFilterDefinition, isDefault: false },
  { ...colorAdjustmentDefinition, isDefault: false },
  { ...blurFilterDefinition, isDefault: false },
  { ...bloomFilterDefinition, isDefault: false },
  { ...bulgePinchFilterDefinition, isDefault: false },
  { ...crtFilterDefinition, isDefault: false },
  { ...glowFilterDefinition, isDefault: false },
  { ...crossHatchFilterDefinition, isDefault: false },
  { ...dotFilterDefinition, isDefault: false },
  { ...glitchFilterDefinition, isDefault: false },
  { ...godrayFilterDefinition, isDefault: false },
  { ...asciiFilterDefinition, isDefault: false },
  { ...oldFilmFilterDefinition, isDefault: false },
  { ...reflectionFilterDefinition, isDefault: false },
  { ...rgbSplitFilterDefinition, isDefault: false },
  { ...pixelateFilterDefinition, isDefault: false },
  { ...shockwaveFilterDefinition, isDefault: false },
  { ...twistFilterDefinition, isDefault: false },
  { ...zoomBlurFilterDefinition, isDefault: false },
  { ...colorMatrixDefinition, isDefault: false, hidden: true },

  // Mask-only transforms
  { ...maskGrowDefinition, isDefault: false },
  { ...featherDefinition, isDefault: false },
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get the registry entry for a given ClipTransform.
 * Handles both regular transformations and filter types.
 */
export function getEntryForTransform(
  t: ClipTransform,
): TransformationDefinition | undefined {
  if (t.type === "filter") {
    const filterTransform = t as GenericFilterTransform;
    return TransformationRegistry.find(
      (entry) =>
        entry.type === "filter" &&
        entry.filterName === filterTransform.filterName,
    );
  }

  return TransformationRegistry.find(
    (entry) => entry.type === t.type || entry.handledTypes?.includes(t.type),
  );
}

/**
 * Get a registry entry by type (for non-filter transformations).
 */
export function getEntryByType(
  type: string,
): TransformationDefinition | undefined {
  return TransformationRegistry.find(
    (entry) =>
      (entry.type === type && !entry.filterName) ||
      entry.handledTypes?.includes(type),
  );
}

/**
 * Get a registry entry by filter name.
 */
export function getEntryByFilterName(
  filterName: string,
): TransformationDefinition | undefined {
  return TransformationRegistry.find(
    (entry) => entry.type === "filter" && entry.filterName === filterName,
  );
}

/**
 * Get the layout definition that contains all default transform UI groups.
 */
export function getLayoutDefinition(): TransformationDefinition {
  return TransformationRegistry.find((entry) => entry.isDefault)!;
}

/**
 * Get all addable transformation entries (for the "+ Add" menu).
 */
export function getAddableTransforms(): TransformationDefinition[] {
  return TransformationRegistry.filter(
    (entry) => !entry.isDefault && !entry.hidden,
  );
}

/**
 * Check if a transformation type is a default transform.
 * Default transforms always appear first and cannot be reordered/removed.
 */
export function isDefaultTransform(type: string): boolean {
  // Check if any default transformation definition handles this type
  const defaultDefinitions = TransformationRegistry.filter(
    (entry) => entry.isDefault,
  );
  return defaultDefinitions.some(
    (def) => def.type === type || def.handledTypes?.includes(type),
  );
}

/**
 * Get the LayoutGroups for a transformation.
 * For layout types, finds the specific group matching the transform type.
 * For other types, returns all groups from the UI config.
 */
export function getLayoutGroupsForTransform(
  t: ClipTransform,
): LayoutGroup[] | undefined {
  const entry = getEntryForTransform(t);
  if (!entry) return undefined;

  // If the entry explicitly handles this type (e.g. layout handles position), return the specific group wrapped in an array
  if (entry.handledTypes?.includes(t.type)) {
    const group = entry.uiConfig.groups.find((g) => g.id === t.type);
    return group ? [group] : undefined;
  }

  return entry.uiConfig.groups;
}

/**
 * Get the display label for a transformation.
 */
export function getLabelForTransform(t: ClipTransform): string {
  const entry = getEntryForTransform(t);

  // For handled sub-types, capitalize the type name
  if (entry?.handledTypes?.includes(t.type)) {
    return t.type.charAt(0).toUpperCase() + t.type.slice(1);
  }

  return entry?.label ?? t.type;
}

/**
 * Get all default transformation definitions.
 */
export function getDefaultTransforms(): TransformationDefinition[] {
  return TransformationRegistry.filter((entry) => entry.isDefault);
}

/**
 * Check if a transformation definition is compatible with a clip type.
 * @param definition - The transformation definition
 * @param clipType - The clip type ("video" | "image" | "audio" | "text" | "shape")
 * @param hasAudio - For video clips, whether the video has audio
 */
export function isTransformCompatible(
  definition: TransformationDefinition,
  clipType: string,
  hasAudio?: boolean,
): boolean {
  const compatibleClips = definition.compatibleClips;

  // If no compatibility specified, assume compatible with all
  if (!compatibleClips) return true;

  // Audio-only clips: only audio transformations
  if (clipType === "audio") {
    return compatibleClips === "audio";
  }

  // Video clips: visual + audio (if hasAudio is true)
  if (clipType === "video") {
    if (compatibleClips === "visual") return true;
    if (compatibleClips === "audio") {
      // Audio transformations available if video has audio
      return hasAudio ?? true; // Default to true if not specified
    }
    if (compatibleClips === "mask") return false;
    return true;
  }

  // Mask-only transformations: only available when editing a mask (clipType "shape")
  if (compatibleClips === "mask") {
    return clipType === "shape";
  }

  // Image, text, shape: only visual transformations
  return compatibleClips === "visual" || !compatibleClips;
}

// =============================================================================
// RUNTIME HANDLERS & SYSTEM
// =============================================================================

export const TransformationSystem = {
  // Ordered list of applicators to run each frame.
  // If a new transformation requires a global state pass (e.g. physics), add its applicator here.
  applicators: [
    layoutApplicator,
    filterApplicator,
    featherApplicator,
  ] as StateApplicator[],

  getDefaults: (): Partial<TransformState> => ({
    filters: [],
  }),
};

/**
 * Dispatches a generic transform to its specific handler by looking up
 * the definition in the Registry.
 */
export function dispatchTransform(
  state: TransformState,
  transform: ClipTransform,
  context: TransformContext,
) {
  // 1. Ask the Registry for the correct definition
  const entry = getEntryForTransform(transform);

  if (entry && entry.handler) {
    // 2. Execute the handler defined in the Registry entry
    // The handler inside 'layoutDefinition' must be capable of handling
    // position/scale/rotation types (see Step 4 below).
    entry.handler(state, transform, context);
  } else {
    console.warn(
      `[TransformationRegistry] No handler found for type: ${transform.type}`,
    );
  }
}
