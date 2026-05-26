import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import GroupWorkIcon from "@mui/icons-material/GroupWork";
import { playbackClock } from "../../player/services/PlaybackClock";
import { useExtractStore } from "../../player/useExtractStore";
import {
  getDefaultSelectionEnd,
  useTimelineSelectionStore,
} from "../../timelineSelection";
import {
  isGroupOverlapValid,
  isGroupTrackRangeContiguous,
} from "../model/renderGroupCommands";
import { useTimelineStore } from "../useTimelineStore";
import { TICKS_PER_SECOND } from "../constants";

/**
 * Dev-only tester for the render-group scaffolding. Drives a create-from-
 * selection flow against `useTimelineStore.createGroup`, lists existing
 * groups, and offers per-group delete. Pairs with the dev alpha cue inside
 * `applyGroupTransforms` so you can visually confirm the orchestrator
 * engages when the playhead enters a group's window.
 *
 * Render groups themselves are intended as internal machinery (no end-user
 * UI), so this panel exists purely to exercise the scaffolding.
 */
export function RenderGroupTesterPanel() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectionMode = useTimelineSelectionStore(
    (state) => state.selectionMode,
  );
  const groups = useTimelineStore((state) => state.groups);
  const createGroup = useTimelineStore((state) => state.createGroup);
  const deleteGroup = useTimelineStore((state) => state.deleteGroup);

  const handleConfirmRenderGroupSelection = () => {
    const {
      selectionStartTick,
      selectionEndTick,
      selectionIncludedTrackIds,
      exitSelectionMode,
    } = useTimelineSelectionStore.getState();
    exitSelectionMode();
    useExtractStore.getState().setOnConfirmSelection(null);

    const start = Math.min(selectionStartTick, selectionEndTick);
    const end = Math.max(selectionStartTick, selectionEndTick);
    const timelineDuration = end - start;

    if (timelineDuration <= 0) {
      setErrorMessage("Selection has zero duration.");
      return;
    }
    if (selectionIncludedTrackIds.length === 0) {
      setErrorMessage("Selection has no included tracks.");
      return;
    }

    // Surface validator failure reasons before dispatching so the user knows
    // why the action no-opped (the draft helpers warn but don't throw).
    const draft = useTimelineStore.getState();
    const candidate = {
      trackIds: selectionIncludedTrackIds,
      start,
      timelineDuration,
    };
    if (!isGroupTrackRangeContiguous(draft, candidate)) {
      setErrorMessage(
        "Selected tracks are not a contiguous run of visual tracks.",
      );
      return;
    }
    if (!isGroupOverlapValid(draft, candidate)) {
      setErrorMessage(
        "Selected window collides with an existing group over a shared track.",
      );
      return;
    }

    const id = createGroup({
      label: `Group ${groups.length + 1}`,
      trackIds: selectionIncludedTrackIds,
      start,
      timelineDuration,
    });
    if (id === null) {
      setErrorMessage("createGroup returned null (check console).");
      return;
    }
    setErrorMessage(null);
  };

  const handleCreateFromSelection = () => {
    setErrorMessage(null);
    const currentTime = playbackClock.time;
    const safeEnd = getDefaultSelectionEnd(currentTime);
    // Default included tracks = every visual track, so the user can just
    // confirm if they want the group to span everything. The two-stage
    // overlay (range → tracks) is driven by includeTracks: true.
    const defaultIncludedTrackIds = useTimelineStore
      .getState()
      .tracks.filter((t) => t.type === undefined || t.type === "visual")
      .map((t) => t.id);
    useExtractStore
      .getState()
      .setOnConfirmSelection(() => handleConfirmRenderGroupSelection());
    useTimelineSelectionStore.getState().enterSelectionMode(
      currentTime,
      safeEnd,
      {
        message:
          "Choose the range, then pick the tracks the render group should cover.",
        includeTracks: true,
        includedTrackIds: defaultIncludedTrackIds,
      },
    );
  };

  const formatTicks = (ticks: number) =>
    `${(ticks / TICKS_PER_SECOND).toFixed(2)}s`;

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        p: 1.5,
        border: "1px dashed rgba(33, 150, 243, 0.4)",
        borderRadius: 1,
        bgcolor: "rgba(33, 150, 243, 0.04)",
      }}
      data-testid="render-group-tester"
    >
      <Typography variant="caption" sx={{ color: "#5fa8ff", fontWeight: 700 }}>
        🛠 Render group tester (dev only)
      </Typography>
      <Typography variant="caption" sx={{ color: "#aeb4bd", lineHeight: 1.3 }}>
        Creates a TimelineGroup from your selection. Active groups dim the
        scene to alpha 0.5 (a v1 cue while group transforms are a no-op).
      </Typography>

      <Tooltip title="Create render group from selection">
        <span>
          <Button
            size="small"
            variant="outlined"
            color="info"
            startIcon={<GroupWorkIcon fontSize="small" />}
            disabled={selectionMode}
            onClick={handleCreateFromSelection}
            data-testid="render-group-tester-create"
            sx={{ alignSelf: "flex-start" }}
          >
            Create from selection
          </Button>
        </span>
      </Tooltip>

      {errorMessage ? (
        <Alert
          severity="warning"
          onClose={() => setErrorMessage(null)}
          sx={{ py: 0.25 }}
        >
          {errorMessage}
        </Alert>
      ) : null}

      {groups.length === 0 ? (
        <Typography variant="caption" sx={{ color: "#7a8088" }}>
          No groups yet.
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {groups.map((group) => (
            <Stack
              key={group.id}
              direction="row"
              alignItems="center"
              spacing={1}
              data-testid={`render-group-tester-row-${group.id}`}
            >
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography
                  variant="caption"
                  sx={{ color: "#d6dade", fontWeight: 600 }}
                  noWrap
                >
                  {group.label}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{ display: "block", color: "#7a8088", lineHeight: 1.1 }}
                  noWrap
                >
                  {group.trackIds.length} track
                  {group.trackIds.length === 1 ? "" : "s"} ·{" "}
                  {formatTicks(group.start)} –{" "}
                  {formatTicks(group.start + group.timelineDuration)}
                </Typography>
              </Box>
              <Tooltip title="Delete group">
                <IconButton
                  size="small"
                  onClick={() => deleteGroup(group.id)}
                  data-testid={`render-group-tester-delete-${group.id}`}
                  sx={{ color: "#aeb4bd" }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}
        </Stack>
      )}
    </Box>
  );
}
