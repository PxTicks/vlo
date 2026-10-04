export interface MarqueePoint {
  x: number;
  y: number;
}

export interface MarqueeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GridRowExtent {
  start: number;
  size: number;
}

/**
 * Layout of the virtualized grid in scroll-content coordinates. Rows come
 * from the virtualizer's measurement cache rather than the DOM, because rows
 * outside the virtual window are unmounted but can still be inside a marquee.
 */
export interface GridGeometry {
  columnCount: number;
  contentWidth: number;
  gapPx: number;
  paddingXPx: number;
  rows: readonly GridRowExtent[];
}

export function rectFromPoints(a: MarqueePoint, b: MarqueePoint): MarqueeRect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

/** Indices of items whose cell intersects `rect`, in item order. */
export function getItemIndicesInRect(
  rect: MarqueeRect,
  geometry: GridGeometry,
  itemCount: number,
): number[] {
  const { columnCount, contentWidth, gapPx, paddingXPx, rows } = geometry;
  const columnWidth =
    (contentWidth - paddingXPx * 2 - gapPx * (columnCount - 1)) / columnCount;

  if (columnWidth <= 0) {
    return [];
  }

  // 1. Resolve which columns the rect spans horizontally.
  const hitColumns: number[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    const left = paddingXPx + column * (columnWidth + gapPx);
    const right = left + columnWidth;
    if (rect.left < right && rect.right > left) {
      hitColumns.push(column);
    }
  }

  if (hitColumns.length === 0) {
    return [];
  }

  // 2. Intersect each overlapping row with those columns. Filler cells past
  //    the last item are skipped by the itemCount bound. Index access rather
  //    than forEach: TanStack's measurement cache is a lazy Proxy over a
  //    sparse array, and iteration methods skip rows it hasn't materialized.
  const indices: number[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (rect.top >= row.start + row.size || rect.bottom <= row.start) {
      continue;
    }
    for (const column of hitColumns) {
      const index = rowIndex * columnCount + column;
      if (index < itemCount) {
        indices.push(index);
      }
    }
  }

  return indices;
}
