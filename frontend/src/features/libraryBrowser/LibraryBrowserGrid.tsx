import {
  useImperativeHandle,
  useMemo,
  useRef,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { Box, Typography } from "@mui/material";
import { useVirtualizer } from "@tanstack/react-virtual";

const DEFAULT_COLUMNS = 2;
// Mirrors the previous MUI layout: `<Grid container spacing={2}>` (16px gaps)
// inside a `p: 2` (16px) scroll region.
const GAP_PX = 16;
const CONTAINER_PADDING_PX = 16;
const ESTIMATED_ROW_PX = 150;
const ROW_OVERSCAN = 6;

export interface LibraryBrowserGridApi {
  /**
   * Scrolls the row containing `itemId` into view. Required because virtualized
   * items may be unmounted, so callers cannot rely on querying the DOM.
   */
  scrollToItemId: (itemId: string) => void;
}

interface LibraryBrowserGridProps<TItem> {
  items: readonly TItem[];
  getItemId: (item: TItem) => string;
  renderItem: (item: TItem) => ReactNode;
  emptyMessage: string;
  scrollRegionRef?: RefObject<HTMLDivElement | null>;
  testId?: string;
  itemTestId?: string;
  isScrollLocked?: boolean;
  onBackgroundClick?: (event: MouseEvent<HTMLDivElement>) => void;
  /** Number of columns per row. Defaults to 2 (matches the legacy `xs: 6` grid). */
  columns?: number;
  /**
   * Keeps the row containing this item mounted even when it scrolls out of the
   * virtual window. Used to stop dnd-kit from losing the drag source when the
   * list auto-scrolls during a drag.
   */
  pinnedItemId?: string | null;
  /** Imperative handle for reveal/scroll-to-item requests. */
  apiRef?: Ref<LibraryBrowserGridApi>;
}

export function LibraryBrowserGrid<TItem>({
  items,
  getItemId,
  renderItem,
  emptyMessage,
  scrollRegionRef,
  testId = "library-browser-scroll-region",
  itemTestId,
  isScrollLocked = false,
  onBackgroundClick,
  columns = DEFAULT_COLUMNS,
  pinnedItemId,
  apiRef,
}: LibraryBrowserGridProps<TItem>) {
  const fallbackScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = scrollRegionRef ?? fallbackScrollRef;

  const columnCount = Math.max(1, columns);
  const rowCount = Math.ceil(items.length / columnCount);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: ROW_OVERSCAN,
    gap: GAP_PX,
    paddingStart: CONTAINER_PADDING_PX,
    paddingEnd: CONTAINER_PADDING_PX,
  });

  // Keep the latest items/getItemId reachable from the stable imperative handle
  // without rebuilding it (and without stale closures) on every render.
  const latestRef = useRef({ items, getItemId, columnCount });
  latestRef.current = { items, getItemId, columnCount };

  useImperativeHandle(
    apiRef,
    () => ({
      scrollToItemId: (itemId: string) => {
        const { items, getItemId, columnCount } = latestRef.current;
        const index = items.findIndex((item) => getItemId(item) === itemId);
        if (index < 0) {
          return;
        }
        virtualizer.scrollToIndex(Math.floor(index / columnCount), {
          align: "auto",
        });
      },
    }),
    [virtualizer],
  );

  const pinnedRowIndex = useMemo(() => {
    if (!pinnedItemId) {
      return -1;
    }
    const index = items.findIndex((item) => getItemId(item) === pinnedItemId);
    return index < 0 ? -1 : Math.floor(index / columnCount);
  }, [pinnedItemId, items, getItemId, columnCount]);

  const virtualRows = virtualizer.getVirtualItems();
  const rowsToRender = [...virtualRows];
  if (
    pinnedRowIndex >= 0 &&
    !virtualRows.some((row) => row.index === pinnedRowIndex)
  ) {
    const cached = virtualizer.measurementsCache[pinnedRowIndex];
    if (cached) {
      rowsToRender.push(cached);
    }
  }

  return (
    <Box
      ref={scrollRef}
      data-testid={testId}
      data-scroll-locked={isScrollLocked ? "true" : "false"}
      onClick={onBackgroundClick}
      sx={{
        flexGrow: 1,
        overflowY: isScrollLocked ? "hidden" : "auto",
        overscrollBehaviorY: isScrollLocked ? "none" : "auto",
        scrollbarGutter: "stable",
        touchAction: isScrollLocked ? "none" : "auto",
      }}
    >
      {items.length === 0 ? (
        <Typography
          variant="body2"
          sx={{ textAlign: "center", mt: 4, color: "#666" }}
        >
          {emptyMessage}
        </Typography>
      ) : (
        <Box
          sx={{
            position: "relative",
            width: "100%",
            height: `${virtualizer.getTotalSize()}px`,
          }}
        >
          {rowsToRender.map((virtualRow) => {
            const startIndex = virtualRow.index * columnCount;
            const rowItems = items.slice(startIndex, startIndex + columnCount);

            return (
              <Box
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                sx={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    gap: `${GAP_PX}px`,
                    px: `${CONTAINER_PADDING_PX}px`,
                  }}
                >
                  {rowItems.map((item) => (
                    <Box
                      key={getItemId(item)}
                      data-library-item-id={getItemId(item)}
                      data-testid={itemTestId}
                      sx={{ flex: "1 1 0", minWidth: 0 }}
                    >
                      {renderItem(item)}
                    </Box>
                  ))}
                  {rowItems.length < columnCount
                    ? Array.from({ length: columnCount - rowItems.length }).map(
                        (_, fillerIndex) => (
                          <Box
                            key={`filler-${fillerIndex}`}
                            aria-hidden
                            sx={{ flex: "1 1 0", minWidth: 0 }}
                          />
                        ),
                      )
                    : null}
                </Box>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
