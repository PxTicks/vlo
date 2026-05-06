import { useState } from "react";
import { Box, CircularProgress, Slider, Stack, IconButton, Tooltip } from "@mui/material";
import ZoomInIcon from "@mui/icons-material/ZoomIn";
import ZoomOutIcon from "@mui/icons-material/ZoomOut";
import ContentCutIcon from "@mui/icons-material/ContentCut";
import VerticalAlignCenterIcon from "@mui/icons-material/VerticalAlignCenter";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import { useTimelineViewStore } from "../hooks/useTimelineViewStore";
import { useInteractionStore } from "../hooks/useInteractionStore";
import { useTimelineStore } from "../useTimelineStore";
import { playbackClock } from "../../player/services/PlaybackClock";
import { useProjectStore } from "../../project/useProjectStore";
import { calculateClipTime } from "../../transformations";
import { getTicksPerFrame, snapTickToFrame } from "../../timelineSelection";
import type {
  MarkerEntry,
  MarkersComponent,
} from "../../../types/Components";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { MIN_ZOOM, MAX_ZOOM, TICKS_PER_SECOND } from "../constants";
import { ensureAssetSourceLoaded } from "../../userAssets/publicApi";
import { mediaProcessingService } from "../../userAssets/services/MediaProcessingService";
import {
  detectBeats,
  registerBeatThisSource,
} from "../services/beatThisApi";

export const TimelineToolbar = () => {
  const zoomScale = useTimelineViewStore((state) => state.zoomScale);
  const setZoomScale = useTimelineViewStore((state) => state.setZoomScale);
  const snappingEnabled = useInteractionStore((state) => state.snappingEnabled);
  const toggleSnappingEnabled = useInteractionStore(
    (state) => state.toggleSnappingEnabled,
  );

  const [isDetectingBeats, setIsDetectingBeats] = useState(false);

  const handleSliderChange = (_: Event, newValue: number | number[]) => {
    setZoomScale(newValue as number);
  };

  const handleDetectBeats = async () => {
    if (isDetectingBeats) return;

    const state = useTimelineStore.getState();
    const playheadTick = playbackClock.time;

    const isAudibleClip = (clip: TimelineClip): boolean =>
      clip.type === "audio" || clip.type === "video";

    let candidates: TimelineClip[] = state.selectedClipIds
      .map((id) => state.clips.find((candidate) => candidate.id === id))
      .filter((clip): clip is TimelineClip => clip !== undefined && isAudibleClip(clip));

    if (candidates.length === 0) {
      candidates = state.clips.filter(
        (clip) =>
          isAudibleClip(clip) &&
          clip.start <= playheadTick &&
          clip.start + clip.timelineDuration > playheadTick,
      );
    }

    if (candidates.length === 0) {
      window.alert("Select an audio or video clip to detect beats.");
      return;
    }

    setIsDetectingBeats(true);
    try {
      for (const clip of candidates) {
        if (!("assetId" in clip) || !clip.assetId) continue;

        const asset = await ensureAssetSourceLoaded(clip.assetId);
        const sourceFile = asset?.file;
        if (!asset || !sourceFile) {
          console.warn("[BeatDetect] Skipping clip without loadable asset", clip.id);
          continue;
        }

        let audioFile: File | null = sourceFile;
        if (asset.type === "video") {
          audioFile = await mediaProcessingService.extractPrimaryAudioTrack(sourceFile);
          if (!audioFile) {
            console.warn(
              "[BeatDetect] No audio track found on video clip",
              clip.id,
            );
            continue;
          }
        } else if (asset.type !== "audio") {
          continue;
        }

        await registerBeatThisSource(audioFile, asset.hash);
        const result = await detectBeats({
          sourceId: asset.hash,
          ticksPerSecond: TICKS_PER_SECOND,
        });

        if (result.beats.length === 0) continue;

        const newMarkers: MarkerEntry[] = result.beats.map((beat) => ({
          id: crypto.randomUUID(),
          sourceTimeTicks: beat.timeTicks,
          name: beat.isDownbeat ? "downbeat" : "beat",
        }));

        const refreshed = useTimelineStore
          .getState()
          .clips.find((candidate) => candidate.id === clip.id);
        if (!refreshed || refreshed.type === "mask") continue;

        const existing = (refreshed.components ?? []).find(
          (component): component is MarkersComponent =>
            component.type === "markers",
        );

        if (existing) {
          useTimelineStore
            .getState()
            .updateClipComponent(clip.id, existing.id, (component) => {
              if (component.type !== "markers") return component;
              return {
                ...component,
                parameters: {
                  ...component.parameters,
                  markers: [...component.parameters.markers, ...newMarkers],
                },
              };
            });
        } else {
          const newComponent: MarkersComponent = {
            id: crypto.randomUUID(),
            type: "markers",
            parameters: { markers: newMarkers },
          };
          useTimelineStore.getState().addClipComponent(clip.id, newComponent);
        }
      }
    } catch (error) {
      window.alert(
        error instanceof Error
          ? `Beat detection failed: ${error.message}`
          : "Beat detection failed.",
      );
    } finally {
      setIsDetectingBeats(false);
    }
  };

  return (
    <Box
      sx={{
        p: 1,
        borderBottom: "1px solid #333",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between", // Spread out
        height: "40px",
        bgcolor: "#1a1a1a",
      }}
      data-testid="timeline-toolbar"
    >
      {/* Left Tools */}
      <Stack direction="row" spacing={1} sx={{ ml: 2 }}>
        <Tooltip
          title={snappingEnabled ? "Timeline Snapping: On" : "Timeline Snapping: Off"}
        >
          <IconButton
            size="small"
            data-testid="timeline-snapping-toggle"
            onClick={toggleSnappingEnabled}
            aria-label={snappingEnabled ? "Disable timeline snapping" : "Enable timeline snapping"}
            aria-pressed={snappingEnabled}
            sx={{ color: snappingEnabled ? "#fbc02d" : "#666" }}
          >
            <VerticalAlignCenterIcon
              fontSize="small"
              sx={{ transform: "rotate(90deg)" }}
            />
          </IconButton>
        </Tooltip>

        <Tooltip title="Add Marker at Playhead">
          <IconButton
            size="small"
            data-testid="timeline-add-marker"
            aria-label="Add marker at playhead"
            onClick={() => {
              const fps = useProjectStore.getState().config.fps;
              const ticksPerFrame = getTicksPerFrame(fps);
              const snappedTick = snapTickToFrame(
                playbackClock.time,
                ticksPerFrame,
              );

              const state = useTimelineStore.getState();
              let targetIds = state.selectedClipIds.filter((id) => {
                const clip = state.clips.find((candidate) => candidate.id === id);
                return (
                  clip &&
                  clip.type !== "mask" &&
                  clip.start <= snappedTick &&
                  clip.start + clip.timelineDuration > snappedTick
                );
              });

              if (targetIds.length === 0) {
                targetIds = state.clips
                  .filter(
                    (clip) =>
                      clip.type !== "mask" &&
                      clip.start <= snappedTick &&
                      clip.start + clip.timelineDuration > snappedTick,
                  )
                  .map((clip) => clip.id);
              }

              targetIds.forEach((id) => {
                const clip = useTimelineStore
                  .getState()
                  .clips.find((candidate) => candidate.id === id);
                if (!clip || clip.type === "mask") return;

                const localVisualTicks = snappedTick - clip.start;
                const sourceTimeTicks = calculateClipTime(
                  clip,
                  localVisualTicks,
                );

                const markersComponent = (clip.components ?? []).find(
                  (component): component is MarkersComponent =>
                    component.type === "markers",
                );

                const newMarker: MarkerEntry = {
                  id: crypto.randomUUID(),
                  sourceTimeTicks,
                };

                if (markersComponent) {
                  useTimelineStore.getState().updateClipComponent(
                    id,
                    markersComponent.id,
                    (component) => {
                      if (component.type !== "markers") return component;
                      return {
                        ...component,
                        parameters: {
                          ...component.parameters,
                          markers: [
                            ...component.parameters.markers,
                            newMarker,
                          ],
                        },
                      };
                    },
                  );
                } else {
                  const newComponent: MarkersComponent = {
                    id: crypto.randomUUID(),
                    type: "markers",
                    parameters: { markers: [newMarker] },
                  };
                  useTimelineStore.getState().addClipComponent(id, newComponent);
                }
              });
            }}
            sx={{ color: "#fbc02d" }}
          >
            <ArrowDropDownIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        <Tooltip title="Detect Beats (selected audio/video clip)">
          <span>
            <IconButton
              size="small"
              data-testid="timeline-detect-beats"
              aria-label="Detect beats"
              onClick={handleDetectBeats}
              disabled={isDetectingBeats}
              sx={{ color: "#fbc02d" }}
            >
              {isDetectingBeats ? (
                <CircularProgress size={16} sx={{ color: "#fbc02d" }} />
              ) : (
                <MusicNoteIcon fontSize="small" />
              )}
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title="Split Clip (Cut)">
          <IconButton
            size="small"
            onClick={() => {
              const currentTime = playbackClock.time;
              const state = useTimelineStore.getState();

              let idsToSplit = [...state.selectedClipIds];

              // If no clips are selected, split ALL clips under the playhead (Razor behavior)
              if (idsToSplit.length === 0) {
                const intersectingClips = state.clips.filter(
                  (c) =>
                    c.type !== "mask" &&
                    c.start < currentTime &&
                    c.start + c.timelineDuration > currentTime,
                );
                idsToSplit = intersectingClips.map((c) => c.id);
              } else {
                // If there IS a selection, we should only split selected clips that ACTUALLY intersect
                // To prevent errors or weird behavior if we try to split a clip not under playhead
                const clips = state.clips;
                idsToSplit = idsToSplit.filter((id) => {
                  const c = clips.find((clip) => clip.id === id);
                  return (
                    c &&
                    c.type !== "mask" &&
                    c.start < currentTime &&
                    c.start + c.timelineDuration > currentTime
                  );
                });
              }

              idsToSplit.forEach((id) => {
                state.splitClip(id, currentTime);
              });
            }}
            sx={{ color: "#eee" }}
          >
            <ContentCutIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Right Zoom Controls */}
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        sx={{ width: 200, mr: 2 }}
      >
        <ZoomOutIcon sx={{ color: "#888", fontSize: 20 }} />
        <Slider
          size="small"
          value={zoomScale}
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.1}
          onChange={handleSliderChange}
          sx={{
            color: "#555",
            "& .MuiSlider-thumb": {
              width: 12,
              height: 12,
              transition: "0.2s",
              "&:hover, &.Mui-focusVisible": {
                boxShadow: "0px 0px 0px 8px rgba(255, 255, 255, 0.16)",
              },
            },
          }}
        />
        <ZoomInIcon sx={{ color: "#888", fontSize: 20 }} />
      </Stack>
    </Box>
  );
};
