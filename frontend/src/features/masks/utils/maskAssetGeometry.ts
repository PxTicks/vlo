/**
 * Whether an asset mask's stored distance band still holds true distances
 * once its frame sprite is placed in content space
 * (docs/mask-distance-field-plan.md).
 *
 * A band survives a similarity transform (rotation plus uniform scale) as
 * scaled distances. Any other affine transform keeps the band's zero
 * crossing (the edge) but not its distances, and wherever the sprite does not
 * cover the content the band reads "far outside" across what is really the
 * asset's border. In those cases the band is only used to place the edge,
 * which is then re-distanced.
 */

/** x' = a x + c y + tx, y' = b x + d y + ty (Pixi's Matrix layout). */
export interface Affine2D {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export interface QuadBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface AssetFieldGeometry {
  /**
   * Content units per asset pixel for decoded anti-aliased coverage: the
   * smallest stretch, so the edge never narrows below a texel.
   */
  coverageScale: number;
  /**
   * Content units per asset pixel when the band's values are true content
   * distances everywhere in the content; null when they are not.
   */
  distanceScale: number | null;
}

const UNIFORM_SCALE_TOLERANCE = 1e-3;
const COVER_TOLERANCE = 1e-3;

/** `left` after `right`. */
export function multiplyAffine(left: Affine2D, right: Affine2D): Affine2D {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    tx: left.a * right.tx + left.c * right.ty + left.tx,
    ty: left.b * right.tx + left.d * right.ty + left.ty,
  };
}

/** Largest and smallest stretch of the linear part (its singular values). */
export function affineStretch(m: Affine2D): { max: number; min: number } {
  const sumOfSquares = m.a * m.a + m.b * m.b + m.c * m.c + m.d * m.d;
  const determinant = m.a * m.d - m.b * m.c;
  const spread = Math.sqrt(
    Math.max(0, sumOfSquares * sumOfSquares - 4 * determinant * determinant),
  );
  return {
    max: Math.sqrt((sumOfSquares + spread) / 2),
    min: Math.sqrt(Math.max(0, (sumOfSquares - spread) / 2)),
  };
}

/** Whether the transformed quad covers the rect [0, width] x [0, height]. */
export function quadCoversRect(
  m: Affine2D,
  bounds: QuadBounds,
  width: number,
  height: number,
): boolean {
  const determinant = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    return false;
  }
  // A convex quad covers the rect when it contains the rect's corners.
  return [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].every(([x, y]) => {
    const dx = x - m.tx;
    const dy = y - m.ty;
    const localX = (m.d * dx - m.c * dy) / determinant;
    const localY = (-m.b * dx + m.a * dy) / determinant;
    return (
      localX >= bounds.minX - COVER_TOLERANCE &&
      localX <= bounds.maxX + COVER_TOLERANCE &&
      localY >= bounds.minY - COVER_TOLERANCE &&
      localY <= bounds.maxY + COVER_TOLERANCE
    );
  });
}

/**
 * @param spriteToContent the frame sprite's local space to content space.
 * @param spriteBounds the sprite's local quad.
 */
export function resolveAssetFieldGeometry(
  spriteToContent: Affine2D,
  spriteBounds: QuadBounds,
  contentSize: { width: number; height: number },
): AssetFieldGeometry {
  const stretch = affineStretch(spriteToContent);
  const coverageScale =
    Number.isFinite(stretch.min) && stretch.min > 0 ? stretch.min : 1;
  const uniform =
    stretch.max - stretch.min <= UNIFORM_SCALE_TOLERANCE * stretch.max;
  const covers = quadCoversRect(
    spriteToContent,
    spriteBounds,
    contentSize.width,
    contentSize.height,
  );
  return {
    coverageScale,
    distanceScale: uniform && covers ? coverageScale : null,
  };
}
