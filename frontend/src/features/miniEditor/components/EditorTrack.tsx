import { useCallback, useRef } from "react";
import { Box } from "@mui/material";
import type { EditorRangeMask } from "../types";
import type { MiniEditorExtractionMode } from "../useMiniEditorStore";

const TRACK_HEIGHT = 72;
const HANDLE_WIDTH = 10;

interface EditorTrackProps {
  durationTicks: number;
  cropStartTicks: number;
  cropEndTicks: number;
  ranges: EditorRangeMask[];
  selectedRangeId: string | null;
  playheadTicks: number;
  onSetCrop: (startTicks: number, endTicks: number) => void;
  onUpdateRange: (id: string, startTicks: number, endTicks: number) => void;
  onSelectRange: (id: string | null) => void;
  onSeek: (ticks: number) => void;
  extractionMode?: MiniEditorExtractionMode;
}

type DragKind =
  | { kind: "crop-start" }
  | { kind: "crop-end" }
  | { kind: "seek" }
  | { kind: "range-start"; id: string }
  | { kind: "range-end"; id: string }
  | { kind: "range-move"; id: string; grabOffsetTicks: number };

export function EditorTrack({
  durationTicks,
  cropStartTicks,
  cropEndTicks,
  ranges,
  selectedRangeId,
  playheadTicks,
  onSetCrop,
  onUpdateRange,
  onSelectRange,
  onSeek,
  extractionMode = null,
}: EditorTrackProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragKind | null>(null);

  const safeDuration = Math.max(1, durationTicks);
  const pct = (ticks: number) => `${(ticks / safeDuration) * 100}%`;

  const tickFromClientX = useCallback(
    (clientX: number): number => {
      const el = containerRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = (clientX - rect.left) / Math.max(1, rect.width);
      return Math.round(Math.max(0, Math.min(1, ratio)) * safeDuration);
    },
    [safeDuration],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const tick = tickFromClientX(event.clientX);

      switch (drag.kind) {
        case "seek":
          onSeek(tick);
          break;
        case "crop-start":
          onSetCrop(tick, cropEndTicks);
          break;
        case "crop-end":
          onSetCrop(cropStartTicks, tick);
          break;
        case "range-start": {
          const range = ranges.find((r) => r.id === drag.id);
          if (range) onUpdateRange(drag.id, tick, range.endSourceTicks);
          break;
        }
        case "range-end": {
          const range = ranges.find((r) => r.id === drag.id);
          if (range) onUpdateRange(drag.id, range.startSourceTicks, tick);
          break;
        }
        case "range-move": {
          const range = ranges.find((r) => r.id === drag.id);
          if (range) {
            const len = range.endSourceTicks - range.startSourceTicks;
            const start = tick - drag.grabOffsetTicks;
            onUpdateRange(drag.id, start, start + len);
          }
          break;
        }
      }
    },
    [
      cropEndTicks,
      cropStartTicks,
      onSeek,
      onSetCrop,
      onUpdateRange,
      ranges,
      tickFromClientX,
    ],
  );

  const endDrag = useCallback((event: React.PointerEvent) => {
    dragRef.current = null;
    const container = containerRef.current;
    if (container?.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }
  }, []);

  const beginDrag = useCallback(
    (event: React.PointerEvent, drag: DragKind) => {
      // Capture on the container (not the handle) so the container's
      // onPointerMove/onPointerUp keep firing for the whole drag.
      event.stopPropagation();
      dragRef.current = drag;
      containerRef.current?.setPointerCapture(event.pointerId);
    },
    [],
  );

  const handleSx = {
    position: "absolute",
    top: 0,
    height: "100%",
    width: HANDLE_WIDTH,
    cursor: "ew-resize",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 4,
    "&::after": {
      content: '""',
      width: 2,
      height: "55%",
      borderRadius: 1,
      backgroundColor: "rgba(255,255,255,0.85)",
    },
  } as const;

  return (
    <Box
      ref={containerRef}
      sx={{
        position: "relative",
        height: TRACK_HEIGHT,
        borderRadius: 1,
        bgcolor: "#101013",
        border:
          extractionMode !== null
            ? "1px solid rgba(144,202,249,0.7)"
            : "1px solid #2a2a30",
        overflow: "hidden",
        touchAction: "none",
        userSelect: "none",
      }}
      onPointerDown={(event) => {
        // Click/drag on empty track scrubs the playhead.
        onSelectRange(null);
        beginDrag(event, { kind: "seek" });
        onSeek(tickFromClientX(event.clientX));
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Trimmed-away regions (outside crop) */}
      <Box
        sx={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: pct(cropStartTicks),
          bgcolor: "rgba(0,0,0,0.6)",
          pointerEvents: "none",
        }}
      />
      <Box
        sx={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: pct(cropEndTicks),
          right: 0,
          bgcolor: "rgba(0,0,0,0.6)",
          pointerEvents: "none",
        }}
      />

      {/* Crop window */}
      <Box
        sx={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: pct(cropStartTicks),
          width: pct(cropEndTicks - cropStartTicks),
          border: "1px solid rgba(144,202,249,0.9)",
          boxShadow: "inset 0 0 0 1px rgba(144,202,249,0.25)",
          pointerEvents: "none",
        }}
      />
      <Box
        aria-label="Crop start"
        sx={{
          ...handleSx,
          left: `calc(${pct(cropStartTicks)} - ${HANDLE_WIDTH / 2}px)`,
          bgcolor: "rgba(144,202,249,0.9)",
          opacity: extractionMode === "frame" ? 0.3 : 1,
          pointerEvents: extractionMode === "frame" ? "none" : "auto",
        }}
        onPointerDown={(event) => beginDrag(event, { kind: "crop-start" })}
      />
      <Box
        aria-label="Crop end"
        sx={{
          ...handleSx,
          left: `calc(${pct(cropEndTicks)} - ${HANDLE_WIDTH / 2}px)`,
          bgcolor: "rgba(144,202,249,0.9)",
          opacity: extractionMode === "frame" ? 0.3 : 1,
          pointerEvents: extractionMode === "frame" ? "none" : "auto",
        }}
        onPointerDown={(event) => beginDrag(event, { kind: "crop-end" })}
      />

      {/* Range masks */}
      {ranges.map((range) => {
        const selected = range.id === selectedRangeId;
        const baseColor = range.isActive
          ? "rgba(244,67,54,0.32)"
          : "rgba(120,120,120,0.28)";
        return (
          <Box
            key={range.id}
            aria-label={`Range ${range.id}`}
            sx={{
              position: "absolute",
              top: 6,
              bottom: 6,
              left: pct(range.startSourceTicks),
              width: pct(
                Math.max(0, range.endSourceTicks - range.startSourceTicks),
              ),
              bgcolor: baseColor,
              border: selected
                ? "1px solid rgba(244,67,54,0.95)"
                : "1px solid rgba(244,67,54,0.5)",
              borderRadius: 1,
              cursor: "grab",
            }}
            onPointerDown={(event) => {
              onSelectRange(range.id);
              const grab =
                tickFromClientX(event.clientX) - range.startSourceTicks;
              beginDrag(event, {
                kind: "range-move",
                id: range.id,
                grabOffsetTicks: grab,
              });
            }}
          >
            <Box
              aria-label={`Range ${range.id} start`}
              sx={{ ...handleSx, left: -HANDLE_WIDTH / 2 }}
              onPointerDown={(event) =>
                beginDrag(event, { kind: "range-start", id: range.id })
              }
            />
            <Box
              aria-label={`Range ${range.id} end`}
              sx={{ ...handleSx, right: -HANDLE_WIDTH / 2 }}
              onPointerDown={(event) =>
                beginDrag(event, { kind: "range-end", id: range.id })
              }
            />
          </Box>
        );
      })}

      {/* Playhead */}
      <Box
        aria-label="Playhead"
        sx={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: pct(playheadTicks),
          width: 12,
          marginLeft: "-6px",
          cursor: "ew-resize",
          zIndex: 3,
        }}
        onPointerDown={(event) => beginDrag(event, { kind: "seek" })}
      >
        <Box
          sx={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 5,
            width: 2,
            bgcolor: "#fff",
            boxShadow:
              extractionMode === "frame"
                ? "0 0 0 2px rgba(33,150,243,0.45)"
                : "none",
          }}
        />
        {extractionMode === "frame" ? (
          <Box
            sx={{
              position: "absolute",
              top: 0,
              left: 2,
              width: 8,
              height: 8,
              bgcolor: "#fff",
              clipPath: "polygon(0 0, 100% 0, 50% 100%)",
            }}
          />
        ) : null}
      </Box>
    </Box>
  );
}
