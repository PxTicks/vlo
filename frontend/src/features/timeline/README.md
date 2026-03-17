# Timeline Feature Documentation

## Overview

The Timeline feature is a multi-track editor built around three local Zustand stores plus a few shared project/player services. It supports:

- Dragging new assets from the asset browser into the timeline
- Moving and resizing existing clips
- Multi-select, copy/paste, split, undo/redo
- Zoomed timeline rendering with frame-snapped seeking
- Timeline-backed range/frame selection flows
- Mask clips stored alongside normal clips

The timeline now has two drag layers:

1. An outer `DndContext` in `EditorLayout` for dragging assets into the timeline
2. An inner `DndContext` in `TimelineContainer` for moving/resizing clips already on the timeline

## Public API

The feature's public surface is intentionally small:

```ts
export { TimelineContainer as Timeline } from "./TimelineContainer";
export { useTimelineStore } from "./useTimelineStore";
```

Most hooks/components under `components/`, `hooks/`, `services/`, and `utils/` are internal implementation details.

## State Architecture

### `useTimelineStore`

`useTimelineStore` is the domain store and source of truth for timeline data.

It owns:

- `tracks`
- `clips`
- `selectedClipIds`
- `copiedClips`
- `canUndo` / `canRedo`

It is responsible for:

- Track creation and insertion
- Adding, removing, duplicating, splitting, moving, and resizing clips
- Clip transforms and mask lifecycle
- Selection and clipboard behavior
- Undo/redo via Immer-style patches
- Debounced persistence into the project document
- Keeping padding tracks above/below occupied tracks

Important current behavior:

- Masks are stored as real timeline clips with `type === "mask"`
- Parent clips reference child mask clips through `clipComponents`
- Timing changes on a parent clip propagate to child mask clips
- Collision and occupancy logic typically ignores mask clips
- All model mutations should go through the store's mutation pipeline so history and persistence stay correct

### `useTimelineViewStore`

`useTimelineViewStore` holds view-only timeline state:

- `zoomScale`
- `ticksToPx`
- `pxToTicks`
- `scrollContainer`

It does not own current playback time. Playhead time comes from `playbackClock`.

`scrollContainer` is shared so overlays and thumbnail rendering can stay aligned with the real viewport.

### `useInteractionStore`

`useInteractionStore` holds high-frequency drag state that should not live in React render state:

- Active clip/id
- Current operation: move / resize-left / resize-right
- Drag deltas
- Resize constraints
- Whether the pointer is over the timeline
- Snap points and snap preview
- Projected end time for temporary timeline expansion

`TimelineClip` subscribes to this store directly and mutates inline styles during drags to avoid excessive rerenders.

## External Dependencies Used By Timeline

The feature also depends on shared stores/services:

- `useProjectStore`
  - Project FPS for frame snapping
  - Project config and document lifecycle
- `useTimelineSelectionStore`
  - Timeline range-selection session state and selection recommendations
- `playbackClock`
  - Current playhead time and ruler scrubbing
- `useExtractStore`
  - Frame-selection mode plus extraction dialog/progress callbacks
- `useAssetStore`
  - Asset lookup and asset-to-clip insertion
- `thumbnailCacheService`
  - Cached timeline thumbnail rendering

## Rendering Architecture

### `TimelineContainer`

`TimelineContainer` is the root timeline UI. It receives:

- `scrollContainerRef`
- `insertGapIndex`

Those come from the outer asset-drag flow in `EditorLayout`.

It is responsible for:

- Registering the scroll container with `useTimelineViewStore`
- Ctrl+wheel zoom anchored to the cursor
- Timeline click-to-seek
- Keyboard shortcuts for delete, copy, paste, undo, and redo
- Hosting the inner `DndContext` for timeline-internal clip interactions
- Computing the scrollable content width, including drag projections

### Visual Layering

Inside the scrollable content, rendering is layered like this:

1. `TimelineRuler`
2. `TimelinePlayhead`
3. `SelectionOverlay`
4. `FrameSelectionOverlay`
5. Snap line indicator
6. `HoverGapIndicator`
7. `TimelineRow` list for track headers and row backgrounds
8. Absolute clip layer that renders `TimelineClipItem` for each non-mask clip

This is an important change from the older mental model:

- `TimelineBody` is a visual row background, not the owner of clip rendering
- Clips are rendered in one absolute overlay above the rows

### Rows and Clips

`TimelineRow` renders:

- `TimelineHeader`
- `TimelineBody`

`TimelineClip` handles:

- Absolute positioning from track index and time
- dnd-kit drag wiring
- Resize handles
- Selection styling
- Thumbnail rendering
- Spline overlays

Clip positioning uses a hybrid approach:

- Base left/width are calculated in unzoomed pixels
- Zoom is applied via the CSS variable `--timeline-zoom`
- Drag deltas are applied through CSS custom properties / transforms

This lets zoom updates stay cheap even with many clips on screen.

## Drag And Drop Architecture

### Outer Asset Drag

`EditorLayout` owns the outer `DndContext` and uses `useAssetDrag`.

That flow handles:

- Dragging assets from the asset browser
- Sharing `scrollContainerRef` with the timeline
- External `insertGapIndex`
- `AssetDragOverlay`

`AssetDragOverlay` has two modes:

- Outside the timeline: show an asset-card-like preview
- Over the timeline: show a clip-shaped overlay using `TimelineClipItem`

### Inner Timeline Drag

`TimelineContainer` owns the inner `DndContext` and uses `useTimelineInternalDrag`.

That flow handles:

- Selecting clips on drag start
- Moving clips
- Resizing left/right edges
- Multi-select drag behavior
- Hand-off into shared move/resize strategies

### Shared Move / Resize Strategies

`useClipMove` is shared by asset drags and internal clip drags. It handles:

- Normalizing dragged geometry for assets vs existing clips
- Detecting whether the pointer is over the timeline
- Gap insertion previews
- Move snapping
- Projected end-time calculation for temporary timeline growth
- Committing asset insertions and clip moves

`useClipResize` handles resize previews and commits using collision constraints and frame-aware minimum duration rules.

## Key Interaction Flows

### Zooming

- Toolbar slider and Ctrl+wheel both update `useTimelineViewStore.zoomScale`
- Ctrl+wheel zoom is cursor-anchored by restoring scroll position in a layout effect
- `TimelineRuler` and `TimelinePlayhead` subscribe imperatively and redraw/reposition outside React render work

### Seeking

- Clicking the timeline background seeks the playhead
- Dragging on the ruler scrubs the playhead
- Both flows snap to frame boundaries using project FPS

### Selection Modes

Selection overlays are not timeline-store state.

- `SelectionOverlay` reads range-selection state from `useTimelineSelectionStore`
- `FrameSelectionOverlay` reads single-frame extraction mode from `useExtractStore`

While selection mode is active, normal click-to-seek and some editor regions are intentionally blocked.

### Track Padding

The store keeps one empty track above and below the occupied non-mask clip region.

That means:

- Track lists are automatically trimmed and padded after many mutations
- Occupancy calculations for padding ignore mask clips
- Track labels are regenerated when padding changes

## Thumbnail Pipeline

Timeline thumbnails are rendered through `ThumbnailCanvas` + `useThumbnailRenderer`.

Important details:

- Rendering is viewport-aware and tied to the real scroll container
- The renderer expands thumbnail "wings" while resizing so newly exposed media can be drawn
- Asset thumbnail data is cached in `ThumbnailCacheService`
- Audio clips skip visual thumbnail drawing

## Current Pitfalls And Guardrails

- Do not assume playhead time lives in `useTimelineViewStore`; it comes from `playbackClock`
- Do not treat masks as metadata-only objects; they are stored as child timeline clips. This is because SAM masks are fundamentally stored as videos, and this exposes them seamlessly to the rendering pipeline. Child clips inherit parent geometry (cropping) and speed transformations.
- Collision helpers generally treat `type === "mask"` clips as non-obstacles; preserve that behavior unless intentionally changing mask semantics.
- Do not render clips inside `TimelineRow` or `TimelineBody`; the real clip layer is absolute and shared. Flat clip storage prevents react render headaches on dragging and dropping.
- Use `constants.ts`; do not re-hardcode zoom limits, `MIN_ZOOM` / `MAX_ZOOM`, or track geomety`TRACK_HEADER_WIDTH`, `RULER_HEIGHT`, and `TRACK_HEIGHT` in geometry code or drag math will drift.
- When changing timeline data, prefer store actions over ad-hoc state edits so undo/redo and persistence keep working.
