# Player Architecture & Clip Resolution

The player system operates as a **time-synchronized, multi-track compositor**. It does not "queue" clips in a traditional playlist sense; instead, it uses a **clock-driven architecture** where each track independently resolves what should be displayed at the current specific moment in time.

## 1. The Layer System (Orchestration)

The entry point is `Player.tsx`. Its primary job is to act as an orchestrator that transforms the abstract Timeline state into visual layers.

### Track-to-Layer Mapping

The player filters the global track list to find visible visual tracks. It then maps each of these tracks to a `<TrackLayer />` component (which uses `useTrackRenderer`).

### Z-Index Management

The stacking order is determined by the track's index in the timeline.

- In `Player.tsx`, the `zIndex` is calculated as `visualTracks.length - 1 - index`.
- This means the **first track** in the list (Index 0) gets the **highest Z-index**.
- In video editing terms, "Track 1" (top of the list) renders _on top_ of "Track 2".

### Canvas Composition

All layers share a single `PIXI.Application`. The `useTrackRenderer` hook ensures that the `PIXI.Sprite` object for that specific track is moved to the correct Z-index by adding it to `app.stage` and setting the `zIndex` property (since `sortableChildren` is enabled).

## 2. Per-Track "Queuing" (Clip Resolution)

The actual logic for "which clip plays when" is decentralized. Instead of a central loop telling tracks what to do, each track manages itself via the `useTrackRenderer` hook.

### A. Independent Clip Filtering

Each track renderer isolates its own data using `useTimelineStore` with a shallow selector:

```typescript
// useTrackRenderer.ts
const trackClips = useTimelineStore(
  useShallow((state) => state.clips.filter((c) => c.trackId === trackId))
);
```

This creates a subset of clips specific to that track. This array acts as the "schedule" for the track.

### B. The Clock-Driven Render Loop

The system is driven by `playbackClock`. When the clock ticks:

1.  **Subscription:** The hook subscribes to the clock updates.
2.  **Active Clip Lookup:** On every frame (tick), the renderer searches its `trackClips` array to find a clip that overlaps the current time:
    ```typescript
    const activeClip = trackClips.find(
      (c) => c.start <= currentTime && c.start + c.duration > currentTime
    );
    ```
3.  **Blank Space Handling:** If no clip is found for the current time, the renderer hides the sprite (`spriteRef.current.visible = false`), effectively rendering transparency for that layer.

## 3. Asset Swapping & Decoding

Once an `activeClip` is identified, the system determines _what_ frame of video to show.

### A. Asset Initialization (The "Queue" Transition)

The hook tracks `currentClipIdRef`. If the `activeClip.id` differs from the previous frame (e.g., the playhead crossed a cut point from Clip A to Clip B):

1.  It retrieves the underlying asset URL from the `AssetStore`.
2.  It sends an `init` message to the dedicated `DecoderWorker` for that track.
3.  This effectively "queues" the new video file into the worker's decoding pipeline.

### B. Local Time Calculation

The global timeline time (ticks) is converted into the asset's local time (seconds):

```typescript
// Global Time -> Local Time
const timeOffsetInTicks = currentTime - activeClip.start;
const localTimeSeconds =
  (activeClip.offset + timeOffsetInTicks) / TICKS_PER_SECOND;
```

This allows the player to handle **trimming** (via `offset`) and **sliding** (via `start`) seamlessly.

### C. Worker Decoding

The `DecoderWorker` receives the `render` command with the specific timestamp.

- It uses `mediabunny` to seek or iterate to the correct frame.
- It transfers the frame (as an `ImageBitmap`) back to the main thread.
- The main thread creates a `PIXI.Texture` from the bitmap and assigns it to the `PIXI.Sprite`.

## Summary Flow

1. **Player** creates a **Renderer** for "Track 1".
2. **Clock** ticks to `00:05:00`.
3. **Renderer** looks at "Track 1 Clips", finds "Clip A" exists from `00:00:00` to `00:10:00`.
4. **Renderer** calculates that `00:05:00` is actually `00:02:00` into the source video (due to trim).
5. **Renderer** asks **Worker 1**: "Give me the frame at 2.0s for Asset X".
6. **Worker 1** decodes and returns the frame.
7. **Renderer** draws it on the Pixi Stage at Z-Index 10.

## 4. The Audio System (Synchronization & Scheduling)

While video is rendered frame-by-frame (pull-based), audio requires a **push-based lookahead architecture** to ensure gapless playback without audio glitches.

### A. The Master Clock (`AudioSystem.ts`)

The `AudioSystem` wraps the Web Audio API `AudioContext`. Crucially, during playback, **Audio is the Master Clock**.

- The visual render loop in `Player.tsx` queries `audioSystem.getCurrentPlaybackTicks()` to determine what frame to draw.
- This ensures video stays synchronized to the audio hardware clock, preventing drift.

### B. Invisible Layers (`AudioTrackLayer.tsx`)

Audio tracks are rendered as "invisible" components in the React tree.

- `Player.tsx` renders an `<AudioTrackLayer />` for every track that contains audio.
- This component initializes the `useAudioTrack` hook, binding the audio lifecycle to the track's existence.

### C. Lookahead Scheduling (`useAudioTrack.ts`)

Instead of reacting to a "tick", the audio hook runs a high-frequency polling loop (every 50ms) to schedule audio buffers in advance.

1.  **Lookahead Window:** The scheduler attempts to fill the `AudioContext` buffer up to **2.0 seconds** into the future.
2.  **Clip Resolution:** Similar to the video renderer, it finds clips that overlap the target schedule time.
3.  **Decoding:** It uses `mediabunny`'s `AudioBufferSink` to pull raw `AudioBuffer` chunks.
4.  **Precise Scheduling:**
    - It calculates the exact `AudioContext` time for the buffer: `startTime + (globalTicks - startTicks) / TICKS`.
    - It creates an `AudioBufferSourceNode` and schedules it with `source.start(preciseTime)`.

### D. Seek & Drift Handling

- If the user seeks, `AudioSystem` updates its internal `startTime`.
- `useAudioTrack` detects this change, immediately stops all currently scheduled nodes (`stopAllNodes()`), and restarts scheduling from the new time.
