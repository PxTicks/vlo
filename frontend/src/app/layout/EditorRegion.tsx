import type {
  MouseEvent,
  MouseEventHandler,
  PointerEvent,
  ReactNode,
} from "react";
import { Box } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";

type SxValue = NonNullable<SxProps<Theme>>;
type SxArray = Extract<SxValue, readonly unknown[]>;
type SxArrayItem = SxArray[number];

interface EditorRegionProps {
  readonly area: string;
  readonly blocked: boolean;
  readonly children: ReactNode;
  readonly overlayTestId?: string;
  readonly sx?: SxProps<Theme>;
  readonly overlaySx?: SxProps<Theme>;
  readonly onMouseDown?: MouseEventHandler<HTMLDivElement>;
}

function isSxArray(sx: SxValue): sx is SxArray {
  return Array.isArray(sx);
}

function toSxArray(sx?: SxProps<Theme>): SxArrayItem[] {
  if (!sx) {
    return [];
  }

  return isSxArray(sx) ? [...sx] : [sx];
}

export function EditorRegion({
  area,
  blocked,
  children,
  overlayTestId,
  sx,
  overlaySx,
  onMouseDown,
}: EditorRegionProps) {
  return (
    <Box
      sx={[
        {
          gridArea: area,
          position: "relative",
        },
        ...toSxArray(sx),
      ]}
      onMouseDown={onMouseDown}
    >
      {children}
      {blocked ? (
        <Box
          data-testid={overlayTestId}
          sx={[
            {
              position: "absolute",
              inset: 0,
              zIndex: 100,
              bgcolor: "rgba(8, 8, 8, 0.52)",
              backdropFilter: "grayscale(0.35)",
              cursor: "not-allowed",
            },
            ...toSxArray(overlaySx),
          ]}
          onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event: MouseEvent<HTMLDivElement>) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      ) : null}
    </Box>
  );
}
