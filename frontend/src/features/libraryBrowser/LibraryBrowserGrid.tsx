import type { MouseEvent, ReactNode, RefObject } from "react";
import { Box, Grid, Typography } from "@mui/material";

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
}: LibraryBrowserGridProps<TItem>) {
  return (
    <Box
      ref={scrollRegionRef}
      data-testid={testId}
      data-scroll-locked={isScrollLocked ? "true" : "false"}
      onClick={onBackgroundClick}
      sx={{
        flexGrow: 1,
        overflowY: isScrollLocked ? "hidden" : "auto",
        overscrollBehaviorY: isScrollLocked ? "none" : "auto",
        scrollbarGutter: "stable",
        touchAction: isScrollLocked ? "none" : "auto",
        p: 2,
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
        <Grid container spacing={2}>
          {items.map((item) => {
            const itemId = getItemId(item);
            return (
              <Grid
                size={{ xs: 6 }}
                key={itemId}
                data-library-item-id={itemId}
                data-testid={itemTestId}
              >
                {renderItem(item)}
              </Grid>
            );
          })}
        </Grid>
      )}
    </Box>
  );
}
