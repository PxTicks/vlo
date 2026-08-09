import type {
  MouseEvent,
  MouseEventHandler,
  PointerEvent,
  ReactNode,
} from "react";
import { Box } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import {
  useRegionFocus,
  type EditorRegion as EditorFocusRegion,
} from "../../features/editorFocus";

type SxValue = NonNullable<SxProps<Theme>>;
type SxArray = Extract<SxValue, readonly unknown[]>;
type SxArrayItem = SxArray[number];

interface EditorRegionProps {
  readonly id?: string;
  readonly area: string;
  readonly blocked: boolean;
  readonly children: ReactNode;
  readonly overlayTestId?: string;
  readonly sx?: SxProps<Theme>;
  readonly overlaySx?: SxProps<Theme>;
  readonly onMouseDown?: MouseEventHandler<HTMLDivElement>;
  /**
   * When set, this region claims keyboard ownership (Delete, etc.) on pointer
   * interaction. See {@link useRegionFocus}.
   */
  readonly focusRegion?: EditorFocusRegion;
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
  id,
  area,
  blocked,
  children,
  overlayTestId,
  sx,
  overlaySx,
  onMouseDown,
  focusRegion,
}: EditorRegionProps) {
  const focusProps = useRegionFocus(focusRegion ?? "canvas");
  return (
    <Box
      id={id}
      sx={[
        {
          gridArea: area,
          position: "relative",
        },
        ...toSxArray(sx),
      ]}
      onMouseDown={onMouseDown}
      {...(focusRegion && !blocked ? focusProps : {})}
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
