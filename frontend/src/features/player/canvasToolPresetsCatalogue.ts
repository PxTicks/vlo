import { hostOptionCatalog } from "../../core/shell/optionCatalog";

export const CANVAS_BRUSH_PRESETS_CATALOGUE = "canvas.brush-presets";

export interface CanvasBrushPresetValue {
  readonly radius: number;
  readonly color: string;
  readonly opacity: number;
}

export function isCanvasBrushPresetValue(
  value: unknown,
): value is CanvasBrushPresetValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as {
    radius?: unknown;
    color?: unknown;
    opacity?: unknown;
  };
  return (
    typeof candidate.radius === "number" &&
    Number.isFinite(candidate.radius) &&
    candidate.radius > 0 &&
    typeof candidate.color === "string" &&
    /^#[0-9a-fA-F]{6}$/.test(candidate.color) &&
    typeof candidate.opacity === "number" &&
    Number.isFinite(candidate.opacity) &&
    candidate.opacity >= 0 &&
    candidate.opacity <= 1
  );
}

let declared = false;

export function declareCanvasBrushPresets(): void {
  if (declared) return;
  declared = true;
  hostOptionCatalog.declare({
    id: CANVAS_BRUSH_PRESETS_CATALOGUE,
    validateValue: isCanvasBrushPresetValue,
    valueSchema: {
      radius: "positive number in project pixels",
      color: "six-digit CSS hex colour",
      opacity: "number from 0 to 1",
    },
  });
  hostOptionCatalog.registerHostOption(CANVAS_BRUSH_PRESETS_CATALOGUE, {
    id: "marker",
    label: "Marker",
    value: { radius: 18, color: "#ff3366", opacity: 0.8 },
    order: 0,
  });
}
