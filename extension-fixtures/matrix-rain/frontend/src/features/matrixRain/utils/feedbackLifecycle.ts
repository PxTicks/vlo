/**
 * Pure decisions for the temporal-feedback state lifecycle, extracted so the
 * (GPU-bound) filter controller stays thin and the reset/reallocation rules are
 * unit-testable without a renderer.
 *
 * The state is stored in two persistent RGBA8 render textures (ping-pong), with
 * exactly one texel per glyph cell. Keeping this calculation outside the GPU
 * controller makes allocation behavior testable without a renderer.
 */

export interface StateGridSize {
  readonly width: number;
  readonly height: number;
}

export interface StateTopology {
  /** Source-local content width in pixels. */
  readonly width: number;
  /** Source-local content height in pixels. */
  readonly height: number;
  /** Glyph size in source pixels (changes the cell mapping). */
  readonly size: number;
  /** Vertical spacing in source pixels (changes the row pitch). */
  readonly verticalSpacing: number;
}

/** Resolve the one-texel-per-cell feedback texture dimensions. */
export function calculateStateGridSize(
  contentWidth: number,
  contentHeight: number,
  size: number,
  verticalSpacing: number,
): StateGridSize {
  const safeWidth = Math.max(1, Math.floor(contentWidth));
  const safeHeight = Math.max(1, Math.floor(contentHeight));
  const safeSize = Math.max(1, size);
  const rowPitch = safeSize + Math.max(0, verticalSpacing);
  return {
    width: Math.max(1, Math.ceil(safeWidth / safeSize)),
    height: Math.max(1, Math.ceil(safeHeight / rowPitch)),
  };
}

/**
 * The state textures must be recreated only when the grid dimensions change,
 * so uniform-only edits (palette, speed, injection) keep their history.
 */
export function stateNeedsReallocation(
  previous: Pick<StateTopology, "width" | "height"> | null,
  width: number,
  height: number,
): boolean {
  if (!width || !height) return false;
  return (
    !previous || previous.width !== width || previous.height !== height
  );
}

/**
 * The state must be cleared (a topology reset) whenever the pixel dimensions or
 * the grid mapping change: a resize reallocates, and a glyph-size or
 * vertical-spacing change re-partitions the grid, so stale accumulation would
 * no longer correspond to the same cells. Uniform-only edits do not reset.
 */
export function stateTopologyChanged(
  previous: StateTopology | null,
  next: StateTopology,
): boolean {
  return (
    !previous ||
    previous.width !== next.width ||
    previous.height !== next.height ||
    previous.size !== next.size ||
    previous.verticalSpacing !== next.verticalSpacing
  );
}
