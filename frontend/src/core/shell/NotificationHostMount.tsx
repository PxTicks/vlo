import { useSyncExternalStore } from "react";
import {
  Box,
  IconButton,
  LinearProgress,
  Paper,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import {
  hostNotificationCenter,
  type HostNotificationCenter,
  type ShellNotificationEntry,
  type ShellNotificationTone,
} from "./notificationCenter";

const TONE_COLORS: Readonly<Record<ShellNotificationTone, string>> = {
  info: "#38bdf8",
  success: "#4ade80",
  warning: "#fbbf24",
  error: "#f87171",
};

interface NotificationCardProps {
  readonly entry: ShellNotificationEntry;
  readonly center: HostNotificationCenter;
}

function NotificationCard({ entry, center }: NotificationCardProps) {
  const accent = TONE_COLORS[entry.tone];
  return (
    <Paper
      elevation={8}
      role="status"
      data-testid={`shell-notification-${entry.id}`}
      sx={{
        width: 320,
        bgcolor: "#18181b",
        border: "1px solid #3f3f46",
        borderLeft: `3px solid ${accent}`,
        borderRadius: 1,
        overflow: "hidden",
        pointerEvents: "auto",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, px: 1.5, py: 1 }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          {entry.title ? (
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {entry.title}
            </Typography>
          ) : null}
          {entry.message ? (
            <Typography
              variant="caption"
              sx={{ color: "text.secondary", display: "block", wordBreak: "break-word" }}
            >
              {entry.message}
            </Typography>
          ) : null}
        </Box>
        {entry.cancellable ? (
          <IconButton
            size="small"
            aria-label={`Cancel ${entry.title ?? entry.message}`}
            onClick={() => center.cancel(entry.id)}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        ) : (
          <IconButton
            size="small"
            aria-label={`Dismiss ${entry.title ?? entry.message}`}
            onClick={() => center.dismiss(entry.id)}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        )}
      </Box>
      {entry.kind === "task" ? (
        <LinearProgress
          variant={entry.progress === null ? "indeterminate" : "determinate"}
          value={entry.progress === null ? undefined : entry.progress * 100}
          sx={{ height: 2 }}
        />
      ) : null}
    </Paper>
  );
}

export interface NotificationHostMountProps {
  readonly center?: HostNotificationCenter;
}

/**
 * Renders the shell notification centre. Mount once in the app shell: it is
 * app-wide rather than editor-wide because activation diagnostics and
 * background work both start before a project is open.
 */
export function NotificationHostMount({
  center = hostNotificationCenter,
}: NotificationHostMountProps) {
  useSyncExternalStore(
    (listener) => center.subscribe(listener),
    () => center.getRevision(),
    () => center.getRevision(),
  );
  const entries = center.list();
  if (entries.length === 0) return null;
  return (
    <Box
      aria-label="Notifications"
      sx={{
        position: "fixed",
        right: 16,
        bottom: 16,
        display: "flex",
        flexDirection: "column-reverse",
        gap: 1,
        // Above the editor's docks and dialogs, below a modal the user is
        // actively answering.
        zIndex: 1_250,
        pointerEvents: "none",
      }}
    >
      {entries.map((entry) => (
        <NotificationCard key={entry.id} entry={entry} center={center} />
      ))}
    </Box>
  );
}
