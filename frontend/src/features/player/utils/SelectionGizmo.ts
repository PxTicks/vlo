import { Container, Graphics } from "pixi.js";
import { syncContainerTransformToTarget } from "../../renderer";

// Constants for styling
const BORDER_COLOR = 0x00aaff;
const HANDLE_COLOR = 0xffffff;
const HANDLE_STROKE = 0x00aaff;
const HANDLE_SIZE = 8; // Size in screen pixels (unscaled)

export type GizmoTarget = Container & {
  anchor?: { x: number; y: number };
};

export class SelectionGizmo extends Container {
  private border: Graphics;
  private handles: { [key: string]: Graphics };

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

    // 2. Create Handles
    this.handles = {};
    const handleKeys = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

    handleKeys.forEach((key) => {
      const handle = new Graphics();
      this.addChild(handle);
      this.handles[key] = handle;

      // Setup interactivity for handles
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
    const bounds = target.getLocalBounds();
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

    // 2. Draw Border
    this.border.clear();
    this.border
      .rect(bounds.x, bounds.y, bounds.width, bounds.height)
      .stroke({ width: 2 / viewportScale, color: BORDER_COLOR });

    // 3. Position and Draw Handles
    // Handle size should be constant in screen space, so we divide by (target.scale * viewportScale)
    // Actually layoutApplicator handles target scale. Gizmo is scaled with target.
    // So to keep handles constant size, we must invert the scale.

    const safeScaleX = Math.max(Math.abs(this.scale.x), 0.0001);
    const safeScaleY = Math.max(Math.abs(this.scale.y), 0.0001);
    const invScaleX = 1 / safeScaleX;
    const invScaleY = 1 / safeScaleY;
    // Note: We also divide by viewportScale to stay constant on screen relative to zoom
    const handleSizeX = (HANDLE_SIZE / viewportScale) * invScaleX;
    const handleSizeY = (HANDLE_SIZE / viewportScale) * invScaleY;

    const drawHandle = (key: string, x: number, y: number) => {
      const h = this.handles[key];
      h.clear();

      h.rect(-handleSizeX / 2, -handleSizeY / 2, handleSizeX, handleSizeY)
        .fill(HANDLE_COLOR)
        .stroke({
          width: (1 / viewportScale) * invScaleX,
          color: HANDLE_STROKE,
        });

      h.position.set(x, y);
      h.scale.set(1); // Reset scale since we drew it sized
    };

    const l = bounds.x;
    const r = bounds.x + bounds.width;
    const t = bounds.y;
    const b = bounds.y + bounds.height;
    const cx = (l + r) / 2;
    const cy = (t + b) / 2;

    drawHandle("nw", l, t);
    drawHandle("n", cx, t);
    drawHandle("ne", r, t);
    drawHandle("e", r, cy);
    drawHandle("se", r, b);
    drawHandle("s", cx, b);
    drawHandle("sw", l, b);
    drawHandle("w", l, cy);
  }

  public getHandle(key: string): Graphics | undefined {
    return this.handles[key];
  }
}
