import { Container, Graphics, Rectangle } from "pixi.js";
import { syncContainerTransformToTarget } from "../../renderer";

// Constants for styling
const BORDER_COLOR = 0x00aaff;
const HANDLE_COLOR = 0xffffff;
const HANDLE_STROKE = 0x00aaff;
const HANDLE_SIZE = 8; // Size in screen pixels (unscaled)
const ROTATE_ZONE_SIZE = 12; // Hover/hit zone for rotation, in screen pixels
const ROTATE_ZONE_GAP = 0; // Gap between resize handle and rotation zone, in screen pixels

const RESIZE_HANDLE_KEYS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
const ROTATE_HANDLE_KEYS = ["rot-nw", "rot-ne", "rot-se", "rot-sw"] as const;

type ResizeHandleKey = (typeof RESIZE_HANDLE_KEYS)[number];
type RotateHandleKey = (typeof ROTATE_HANDLE_KEYS)[number];
export type GizmoHandleKey = ResizeHandleKey | RotateHandleKey;

// Quarter-arc with arrowheads at both ends. Drawn so the arc opens into the
// inside-bottom-right quadrant (i.e. correct orientation for a NW corner when
// looked at from outside the gizmo). We rotate the SVG per-corner so each
// rotation zone points along its own diagonal.
function buildRotateCursor(rotationDeg: number): string {
  // Filled triangle arrowheads. Each triangle's BASE is centered on the arc
  // endpoint and its TIP extends outward along the tangent — so the arc flows
  // visually into the base of the arrow and the tip lies just beyond. The
  // arc uses butt linecaps so it ends exactly at the base.
  // Start: tangent up, outward direction +y, tip at (-8, 3).
  const startTri = "M -10 0 L -8 3.5 L -6 0 Z";
  // End: tangent right, outward direction +x, tip at (3, -8).
  const endTri = "M 0 -10 L 3.5 -8 L 0 -6 Z";
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='-12 -12 24 24'>" +
    `<g transform='rotate(${rotationDeg})'>` +
    "<g fill='none' stroke-linecap='butt'>" +
    "<path d='M -8 0 A 8 8 0 0 1 0 -8' stroke='white' stroke-width='3.5'/>" +
    "<path d='M -8 0 A 8 8 0 0 1 0 -8' stroke='black' stroke-width='1.5'/>" +
    "</g>" +
    "<g fill='black' stroke='white' stroke-width='1.5' stroke-linejoin='round'>" +
    `<path d='${startTri}'/>` +
    `<path d='${endTri}'/>` +
    "</g>" +
    "</g>" +
    "</svg>";
  return `url("data:image/svg+xml;utf8,${svg}") 12 12, alias`;
}

// Quadrant rotations: rot-nw arc lives in the NW corner pointing into the
// gizmo, rot-ne is rotated 90°, rot-se 180°, rot-sw 270°.
const ROTATE_CURSORS: Record<RotateHandleKey, string> = {
  "rot-nw": buildRotateCursor(0),
  "rot-ne": buildRotateCursor(90),
  "rot-se": buildRotateCursor(180),
  "rot-sw": buildRotateCursor(270),
};

export type GizmoTarget = Container & {
  anchor?: { x: number; y: number };
};

interface LocalBoundsRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function resolveGizmoLocalBounds(target: GizmoTarget): LocalBoundsRect {
  const spriteLikeTarget = target as GizmoTarget & {
    renderPipeId?: string;
    visualBounds?: {
      minX: number;
      maxX: number;
      minY: number;
      maxY: number;
    };
  };

  // Sprite masking is attached as a Pixi effect, and `getLocalBounds()` folds
  // effect bounds back into the sprite. That makes the transform gizmo drift
  // when an AlphaMask is active, so for sprites we stick to the intrinsic quad.
  if (
    spriteLikeTarget.renderPipeId === "sprite" &&
    spriteLikeTarget.visualBounds
  ) {
    const { minX, maxX, minY, maxY } = spriteLikeTarget.visualBounds;
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  const bounds = target.getLocalBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

export class SelectionGizmo extends Container {
  private border: Graphics;
  private handles: { [key: string]: Graphics };

  /** All interactive handle keys, including rotation zones. */
  public readonly handleKeys: readonly GizmoHandleKey[] = [
    ...RESIZE_HANDLE_KEYS,
    ...ROTATE_HANDLE_KEYS,
  ];

  // Stored references for interaction
  public target: GizmoTarget | null = null;

  // Cache for optimization
  private lastBounds = { x: 0, y: 0, width: 0, height: 0 };
  private lastViewportScale = 0;
  private lastScale = { x: 0, y: 0 };

  constructor() {
    super();

    // 1. Create Border
    this.border = new Graphics();
    this.addChild(this.border);

    // 2. Create Handles (resize + rotation hover zones)
    this.handles = {};
    this.handleKeys.forEach((key) => {
      const handle = new Graphics();
      this.addChild(handle);
      this.handles[key] = handle;

      handle.eventMode = "static";
      handle.cursor = this.getCursorForHandle(key);
    });
  }

  private getCursorForHandle(key: string): string {
    switch (key) {
      case "nw":
        return "nw-resize";
      case "ne":
        return "ne-resize";
      case "sw":
        return "sw-resize";
      case "se":
        return "se-resize";
      case "n":
        return "n-resize";
      case "s":
        return "s-resize";
      case "e":
        return "e-resize";
      case "w":
        return "w-resize";
      case "rot-nw":
      case "rot-ne":
      case "rot-se":
      case "rot-sw":
        return ROTATE_CURSORS[key];
      default:
        return "default";
    }
  }

  /**
   * Updates the gizmo to match the target sprite's transforms.
   * @param target The sprite to follow
   * @param viewportScale The current scale of the viewport (used to keep handles constant size)
   */
  public update(target: GizmoTarget, viewportScale: number = 1) {
    if (!target || target.destroyed) {
      this.visible = false;
      return;
    }

    this.target = target;
    this.visible = true;

    // 1. Sync transform to target, even if parent hierarchies differ.
    if (!syncContainerTransformToTarget(this, target)) {
      this.visible = false;
      return;
    }
    const anchor = target.anchor;
    const bounds = resolveGizmoLocalBounds(target);
    if (anchor) {
      this.pivot.set(
        bounds.x + bounds.width * anchor.x,
        bounds.y + bounds.height * anchor.y,
      );
    } else {
      this.pivot.set(0, 0);
    }

    // --- OPTIMIZATION START ---
    // Only redraw geometry if dimensions or scale context changed
    const isDirty =
      Math.abs(bounds.x - this.lastBounds.x) > 0.01 ||
      Math.abs(bounds.y - this.lastBounds.y) > 0.01 ||
      Math.abs(bounds.width - this.lastBounds.width) > 0.01 ||
      Math.abs(bounds.height - this.lastBounds.height) > 0.01 ||
      Math.abs(viewportScale - this.lastViewportScale) > 0.001 ||
      Math.abs(this.scale.x - this.lastScale.x) > 0.001 ||
      Math.abs(this.scale.y - this.lastScale.y) > 0.001;

    if (!isDirty) return;

    // Update Cache
    this.lastBounds = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
    this.lastViewportScale = viewportScale;
    this.lastScale = { x: this.scale.x, y: this.scale.y };
    // --- OPTIMIZATION END ---

    // Handle size should be constant in screen space, so we divide by (target.scale * viewportScale)
    // Gizmo is scaled with target via syncContainerTransformToTarget, so we must invert that scale
    // for both handles and the border stroke.
    const safeScaleX = Math.max(Math.abs(this.scale.x), 0.0001);
    const safeScaleY = Math.max(Math.abs(this.scale.y), 0.0001);
    const invScaleX = 1 / safeScaleX;
    const invScaleY = 1 / safeScaleY;
    // Strokes take a uniform width; use the average of both axes so the border
    // reads as roughly constant thickness even when scaleX != scaleY.
    const invStrokeScale = (invScaleX + invScaleY) / 2;

    // 2. Draw Border
    this.border.clear();
    this.border
      .rect(bounds.x, bounds.y, bounds.width, bounds.height)
      .stroke({
        width: (2 / viewportScale) * invStrokeScale,
        color: BORDER_COLOR,
      });

    // 3. Position and Draw Handles
    // Note: We also divide by viewportScale to stay constant on screen relative to zoom
    const handleSizeX = (HANDLE_SIZE / viewportScale) * invScaleX;
    const handleSizeY = (HANDLE_SIZE / viewportScale) * invScaleY;
    const rotateSizeX = (ROTATE_ZONE_SIZE / viewportScale) * invScaleX;
    const rotateSizeY = (ROTATE_ZONE_SIZE / viewportScale) * invScaleY;
    // Diagonal offset from the corner so the rotate zone sits *just outside*
    // the resize handle with a small visual gap.
    const rotateOffsetX =
      ((HANDLE_SIZE / 2 + ROTATE_ZONE_GAP + ROTATE_ZONE_SIZE / 2) /
        viewportScale) *
      invScaleX;
    const rotateOffsetY =
      ((HANDLE_SIZE / 2 + ROTATE_ZONE_GAP + ROTATE_ZONE_SIZE / 2) /
        viewportScale) *
      invScaleY;

    const drawResizeHandle = (key: string, x: number, y: number) => {
      const h = this.handles[key];
      h.clear();
      h.rect(-handleSizeX / 2, -handleSizeY / 2, handleSizeX, handleSizeY)
        .fill(HANDLE_COLOR)
        .stroke({
          width: (1 / viewportScale) * invStrokeScale,
          color: HANDLE_STROKE,
        });
      h.position.set(x, y);
      h.scale.set(1);
    };

    const drawRotateZone = (key: string, x: number, y: number) => {
      const h = this.handles[key];
      h.clear();
      // Invisible hit area — we use a transparent fill so the Graphics
      // produces a hit-testable region without painting anything visible.
      h.rect(-rotateSizeX / 2, -rotateSizeY / 2, rotateSizeX, rotateSizeY).fill({
        color: 0xffffff,
        alpha: 0,
      });
      h.hitArea = new Rectangle(
        -rotateSizeX / 2,
        -rotateSizeY / 2,
        rotateSizeX,
        rotateSizeY,
      );
      h.position.set(x, y);
      h.scale.set(1);
    };

    const l = bounds.x;
    const r = bounds.x + bounds.width;
    const t = bounds.y;
    const b = bounds.y + bounds.height;
    const cx = (l + r) / 2;
    const cy = (t + b) / 2;

    drawResizeHandle("nw", l, t);
    drawResizeHandle("n", cx, t);
    drawResizeHandle("ne", r, t);
    drawResizeHandle("e", r, cy);
    drawResizeHandle("se", r, b);
    drawResizeHandle("s", cx, b);
    drawResizeHandle("sw", l, b);
    drawResizeHandle("w", l, cy);

    drawRotateZone("rot-nw", l - rotateOffsetX, t - rotateOffsetY);
    drawRotateZone("rot-ne", r + rotateOffsetX, t - rotateOffsetY);
    drawRotateZone("rot-se", r + rotateOffsetX, b + rotateOffsetY);
    drawRotateZone("rot-sw", l - rotateOffsetX, b + rotateOffsetY);
  }

  public getHandle(key: string): Graphics | undefined {
    return this.handles[key];
  }

  public static isRotateHandleKey(key: string): boolean {
    return key.startsWith("rot-");
  }
}
