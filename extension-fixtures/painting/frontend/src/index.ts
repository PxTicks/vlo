import type {
  ExtensionCanvasToolSession,
  ExtensionModule,
  ExtensionPoint2D,
  VloExtensionApi,
} from "@vlo/extension-sdk";

const BRUSH_LIBRARY_KEY = "brush-library";
const BRUSH_CATALOGUE = "canvas.brush-presets";
const MAX_SUBSTROKE_POINTS = 64;

interface BrushPreset {
  readonly radius: number;
  readonly color: string;
  readonly opacity: number;
}

interface StrokeBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface StrokePayload {
  readonly assetId: string;
  readonly points: readonly ExtensionPoint2D[];
  readonly radius: number;
  readonly color: string;
  readonly opacity: number;
  readonly bounds: StrokeBounds;
}

interface FixtureGraphics {
  clear(): FixtureGraphics;
  moveTo(x: number, y: number): FixtureGraphics;
  lineTo(x: number, y: number): FixtureGraphics;
  circle(x: number, y: number, radius: number): FixtureGraphics;
  fill(options: { color: string; alpha: number }): FixtureGraphics;
  stroke(options: {
    color: string;
    alpha: number;
    width: number;
    cap?: "round";
    join?: "round";
  }): FixtureGraphics;
}

interface OverlayContainer {
  addChild(child: object): void;
}

const DEFAULT_PRESET: BrushPreset = {
  radius: 18,
  color: "#ff3366",
  opacity: 0.8,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePreset(value: unknown): BrushPreset {
  if (!isRecord(value)) throw new Error("Brush preset must be an object.");
  if (
    typeof value.radius !== "number" ||
    !Number.isFinite(value.radius) ||
    value.radius <= 0 ||
    typeof value.color !== "string" ||
    !/^#[0-9a-fA-F]{6}$/.test(value.color) ||
    typeof value.opacity !== "number" ||
    value.opacity < 0 ||
    value.opacity > 1
  ) {
    throw new Error("Brush preset has invalid radius, color, or opacity.");
  }
  return {
    radius: value.radius,
    color: value.color,
    opacity: value.opacity,
  };
}

function parseStroke(value: unknown): StrokePayload {
  if (!isRecord(value) || !Array.isArray(value.points)) {
    throw new Error("Paint stroke payload is invalid.");
  }
  const preset = parsePreset(value);
  if (typeof value.assetId !== "string" || !isRecord(value.bounds)) {
    throw new Error("Paint stroke asset or bounds are invalid.");
  }
  const points = value.points.map((point) => {
    if (
      !isRecord(point) ||
      typeof point.x !== "number" ||
      !Number.isFinite(point.x) ||
      typeof point.y !== "number" ||
      !Number.isFinite(point.y)
    ) {
      throw new Error("Paint stroke points must be finite.");
    }
    return { x: point.x, y: point.y };
  });
  const bounds = value.bounds;
  if (
    typeof bounds.x !== "number" ||
    typeof bounds.y !== "number" ||
    typeof bounds.width !== "number" ||
    typeof bounds.height !== "number" ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new Error("Paint stroke bounds must be finite and non-empty.");
  }
  return {
    assetId: value.assetId,
    points,
    ...preset,
    bounds: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    },
  };
}

function getStrokeBounds(
  points: readonly ExtensionPoint2D[],
  radius: number,
): StrokeBounds {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs) - radius;
  const minY = Math.min(...ys) - radius;
  const maxX = Math.max(...xs) + radius;
  const maxY = Math.max(...ys) + radius;
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

export function splitStrokePoints(
  points: readonly ExtensionPoint2D[],
  maxPoints: number = MAX_SUBSTROKE_POINTS,
): readonly (readonly ExtensionPoint2D[])[] {
  if (!Number.isInteger(maxPoints) || maxPoints < 2) {
    throw new RangeError("Sub-strokes require at least two points per chunk.");
  }
  if (points.length <= maxPoints) return [points];
  const chunks: ExtensionPoint2D[][] = [];
  let start = 0;
  while (start < points.length) {
    const end = Math.min(points.length, start + maxPoints);
    chunks.push(points.slice(start, end));
    if (end === points.length) break;
    // Share an endpoint so round-capped chunks remain visually continuous.
    start = end - 1;
  }
  return chunks;
}

function drawStroke(
  graphics: FixtureGraphics,
  points: readonly ExtensionPoint2D[],
  preset: BrushPreset,
): void {
  graphics.clear();
  const first = points[0];
  if (!first) return;
  if (points.length === 1) {
    graphics
      .circle(first.x, first.y, preset.radius)
      .fill({ color: preset.color, alpha: preset.opacity });
    return;
  }
  graphics.moveTo(first.x, first.y);
  for (const point of points.slice(1)) graphics.lineTo(point.x, point.y);
  graphics.stroke({
    color: preset.color,
    alpha: preset.opacity,
    width: preset.radius * 2,
    cap: "round",
    join: "round",
  });
}

async function rasterizeStroke(
  points: readonly ExtensionPoint2D[],
  preset: BrushPreset,
  bounds: StrokeBounds,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(bounds.width));
  canvas.height = Math.max(1, Math.ceil(bounds.height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser cannot rasterize this stroke.");
  context.strokeStyle = preset.color;
  context.fillStyle = preset.color;
  context.globalAlpha = preset.opacity;
  context.lineWidth = preset.radius * 2;
  context.lineCap = "round";
  context.lineJoin = "round";
  const first = points[0];
  if (!first) throw new Error("Cannot rasterize an empty stroke.");
  context.beginPath();
  context.moveTo(first.x - bounds.x, first.y - bounds.y);
  for (const point of points.slice(1)) {
    context.lineTo(point.x - bounds.x, point.y - bounds.y);
  }
  if (points.length === 1) {
    context.arc(
      first.x - bounds.x,
      first.y - bounds.y,
      preset.radius,
      0,
      Math.PI * 2,
    );
    context.fill();
  } else {
    context.stroke();
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed."))),
      "image/png",
    );
  });
}

export function commitPaintedResult(
  api: VloExtensionApi,
  clipId: string,
  assetId: string,
  points: readonly ExtensionPoint2D[],
  preset: BrushPreset,
  coalesceKey: string,
  endCoalescing: boolean,
) {
  if (points.length === 0) throw new Error("Cannot commit an empty stroke.");
  const clip = api.timeline.listClips().find((candidate) => candidate.id === clipId);
  if (!clip) throw new Error(`Clip '${clipId}' is no longer available.`);
  const project = api.timeline.getProject();
  const bounds = getStrokeBounds(points, preset.radius);
  return api.timeline.transaction(
    "Paint stroke",
    (transaction) => {
      transaction.addClipMask(clipId, {
        maskType: "brush",
        name: "Extension paint stroke",
        parameters: {
          baseWidth: project.width,
          baseHeight: project.height,
        },
        assetId,
        paintedBounds: {
          x: bounds.x,
          y: bounds.y,
          width: Math.ceil(bounds.width),
          height: Math.ceil(bounds.height),
        },
      });
      transaction.createEntity({
        name: "Paint stroke",
        trackId: clip.trackId,
        startTicks: clip.startTicks,
        durationTicks: clip.durationTicks,
        payload: {
          extensionId: "example.painting",
          typeId: "stroke",
          schemaVersion: 1,
          data: {
            assetId,
            points: points.map((point) => ({ x: point.x, y: point.y })),
            radius: preset.radius,
            color: preset.color,
            opacity: preset.opacity,
            bounds: {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
            },
          },
        },
      });
    },
    {
      coalesce: {
        key: coalesceKey,
        phase: endCoalescing ? "end" : "continue",
      },
    },
  );
}

export const activate: ExtensionModule["activate"] = async (context) => {
  const Graphics = context.api.runtime.pixi.Graphics as {
    new (): FixtureGraphics;
  };
  context.api.entityProviders.register({
    id: "stroke",
    apiVersion: 1,
    kind: "trusted-pixi",
    label: "Paint stroke",
    timelineColor: "#ff3366",
    schemaVersion: 1,
    defaultPayload: {
      assetId: "missing",
      points: [{ x: 0, y: 0 }],
      ...DEFAULT_PRESET,
      bounds: { x: -18, y: -18, width: 36, height: 36 },
    },
    validate: (data) => {
      parseStroke(data);
    },
    getAssetReferences: (data) => [parseStroke(data).assetId],
    getRenderSignature: ({ data }) => JSON.stringify(data),
    createRenderable: () => {
      const graphics = new Graphics();
      return {
        object: graphics as object,
        update: ({ data }) => {
          const stroke = parseStroke(data);
          drawStroke(graphics, stroke.points, stroke);
        },
      };
    },
  });

  context.api.ui.catalogues.addOption({
    id: "soft-coral",
    apiVersion: 1,
    catalogueId: BRUSH_CATALOGUE,
    label: "Soft Coral",
    value: { radius: 24, color: "#ff6b81", opacity: 0.55 },
    order: 100,
  });
  const contributedPreset = context.api.ui.catalogues
    .list(BRUSH_CATALOGUE)
    .find((option) => option.id === "example.painting/soft-coral");
  const preset = contributedPreset
    ? parsePreset(contributedPreset.value)
    : DEFAULT_PRESET;
  if (context.api.storage.project) {
    await context.api.storage.project.set(BRUSH_LIBRARY_KEY, {
      schemaVersion: 1,
      presets: [
        {
          radius: preset.radius,
          color: preset.color,
          opacity: preset.opacity,
        },
      ],
    });
  }

  let session: ExtensionCanvasToolSession | null = null;
  let overlay: FixtureGraphics | null = null;
  let points: ExtensionPoint2D[] = [];
  let interactionId = "";
  const tool = context.api.ui.canvasTools.register({
    id: "brush",
    apiVersion: 1,
    label: "Paint brush",
    cursor: "crosshair",
    when: { key: "project.open" },
    activate: (nextSession) => {
      session = nextSession;
      overlay = new Graphics();
      (nextSession.overlay as OverlayContainer).addChild(overlay as object);
    },
    deactivate: () => {
      session = null;
      overlay = null;
      points = [];
      interactionId = "";
    },
    onPointer: (event) => {
      if (!session?.targetClipId || !overlay) return;
      if (event.kind === "down") {
        points = [event.projectPoint];
        interactionId = crypto.randomUUID();
        drawStroke(overlay, points, preset);
        session.requestRender();
        return;
      }
      if (event.kind === "move" && points.length > 0 && event.buttons !== 0) {
        points.push(event.projectPoint);
        drawStroke(overlay, points, preset);
        session.requestRender();
        return;
      }
      if (event.kind === "cancel") {
        points = [];
        overlay.clear();
        session.requestRender();
        return;
      }
      if (event.kind !== "up" || points.length === 0) return;
      const committedPoints = [...points, event.projectPoint];
      const targetClipId = session.targetClipId;
      const strokeId = interactionId;
      points = [];
      void (async () => {
        try {
          const substrokes = splitStrokePoints(committedPoints);
          const preparedSubstrokes = [];
          for (const [index, substroke] of substrokes.entries()) {
            const bounds = getStrokeBounds(substroke, preset.radius);
            const blob = await rasterizeStroke(substroke, preset, bounds);
            const asset = await context.api.assets.ingest({
              name: `paint-stroke-${strokeId}-${index + 1}.png`,
              type: "image",
              blob,
            });
            preparedSubstrokes.push({ assetId: asset.id, points: substroke });
          }

          // Keep the timeline commits consecutive: async asset preparation is
          // complete before the bounded undo interaction starts.
          for (const [index, substroke] of preparedSubstrokes.entries()) {
            const result = commitPaintedResult(
              context.api,
              targetClipId,
              substroke.assetId,
              substroke.points,
              preset,
              strokeId,
              index === preparedSubstrokes.length - 1,
            );
            if (!result.ok) throw new Error(result.message);
          }
        } catch (error) {
          context.logger.error("Failed to commit paint stroke", error);
        }
      })();
    },
  });

  context.api.ui.commands.registerKeybinding({
    id: "activate-brush",
    apiVersion: 1,
    chord: "Mod+Shift+P",
    command: tool.command,
    regions: ["canvas"],
  });
  context.api.ui.commands.register({
    id: "painting-tips",
    apiVersion: 1,
    title: "Painting tool tips",
    run: () => {
      context.logger.info("Select a clip, activate Paint brush, then drag on canvas.");
    },
  });
  context.api.ui.menus.addItem({
    id: "painting-tips",
    apiVersion: 1,
    menuId: "player.canvas.context",
    kind: "command",
    command: "painting-tips",
    group: "9_extensions",
  });
};
