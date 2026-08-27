import { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Collapse,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import type { CapabilityInstall } from "../../../types/RuntimeStatus";
import { useRuntimeCapabilityStore } from "../useRuntimeCapabilityStore";
import { BackendRestartPrompt } from "./BackendRestartPrompt";

interface CapabilityInstallActionProps {
  capabilityId: string;
  capabilityLabel: string;
  install: CapabilityInstall;
  /** The backend has already installed this and is waiting to be restarted. */
  restartRequired: boolean;
  dense?: boolean;
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, mt: 0.75 }}>
      <Box
        component="code"
        data-testid="capability-install-command"
        sx={{
          flex: 1,
          fontFamily: "monospace",
          fontSize: "0.75rem",
          bgcolor: "rgba(0, 0, 0, 0.35)",
          borderRadius: 1,
          px: 1,
          py: 0.5,
          wordBreak: "break-all",
        }}
      >
        {command}
      </Box>
      <Button
        size="small"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(command)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        sx={{ textTransform: "none" }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </Box>
  );
}

function InstallLog({ lines }: { lines: string[] }) {
  const end = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Follow the tail: the interesting line during an install is always the
    // last one, and during a failure it is the last few. Optional-called
    // because scrolling is a nicety, and a DOM without it (jsdom) must not
    // take the log down with it.
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [lines]);

  return (
    <Box
      data-testid="capability-install-log"
      sx={{
        mt: 0.75,
        maxHeight: 160,
        overflowY: "auto",
        bgcolor: "rgba(0, 0, 0, 0.35)",
        borderRadius: 1,
        px: 1,
        py: 0.5,
      }}
    >
      {lines.map((line, index) => (
        <Typography
          key={`${index}-${line}`}
          variant="caption"
          sx={{
            fontFamily: "monospace",
            display: "block",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {line}
        </Typography>
      ))}
      <div ref={end} />
    </Box>
  );
}

/**
 * Run the install command, rather than only printing it.
 *
 * The command is shown before it runs and stays visible while it does: this
 * writes packages into the environment the app itself runs from, and a button
 * that does that without saying what it will do is not a button anyone should
 * press. The text shown is rendered from the argument vector the backend will
 * execute, so it cannot describe a different command than the one that runs.
 *
 * Nothing here names a package. The request is "install this capability", by
 * id; what that means is the backend's answer, derived from the same table the
 * printed remediation comes from.
 */
export function CapabilityInstallAction({
  capabilityId,
  capabilityLabel,
  install,
  restartRequired,
  dense = false,
}: CapabilityInstallActionProps) {
  const progress = useRuntimeCapabilityStore(
    (state) => state.installs[capabilityId] ?? null,
  );
  const installing = useRuntimeCapabilityStore((state) =>
    state.installing.includes(capabilityId),
  );
  const installCapability = useRuntimeCapabilityStore(
    (state) => state.installCapability,
  );
  const cancelInstall = useRuntimeCapabilityStore(
    (state) => state.cancelInstall,
  );
  const [showLog, setShowLog] = useState(false);

  const succeeded = progress?.status === "succeeded";
  const failed = progress?.status === "failed";
  const log = progress?.log ?? [];

  // The restart prompt replaces the install affordance rather than joining it:
  // once the packages are on disk, installing them again is not the next step.
  if (restartRequired || succeeded) {
    return (
      <Stack spacing={0.75} data-testid={`capability-install-${capabilityId}`}>
        <BackendRestartPrompt label={capabilityLabel} dense={dense} />
        {log.length > 0 ? (
          <>
            <Button
              size="small"
              onClick={() => setShowLog((value) => !value)}
              sx={{ alignSelf: "flex-start", textTransform: "none" }}
            >
              {showLog ? "Hide install log" : "Install log"}
            </Button>
            <Collapse in={showLog} unmountOnExit>
              <InstallLog lines={log} />
            </Collapse>
          </>
        ) : null}
      </Stack>
    );
  }

  return (
    <Box sx={{ mt: 0.75 }} data-testid={`capability-install-${capabilityId}`}>
      <Typography variant="body2">{install.summary}</Typography>
      <CommandLine command={install.command} />

      {installing ? (
        <Box sx={{ mt: 0.75 }}>
          <LinearProgress />
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", mt: 0.25 }}
            data-testid="capability-install-message"
          >
            {progress?.message || "Installing…"}
          </Typography>
        </Box>
      ) : null}

      {failed && progress?.error ? (
        <Typography
          variant="caption"
          sx={{ color: "error.main", display: "block", mt: 0.5 }}
          data-testid="capability-install-error"
        >
          {progress.error}
        </Typography>
      ) : null}

      <Stack direction="row" spacing={1} sx={{ mt: 0.75 }} alignItems="center">
        <Button
          size="small"
          variant="contained"
          disabled={installing}
          onClick={() => void installCapability(capabilityId)}
          data-testid="capability-install-run"
          sx={{ textTransform: "none" }}
        >
          {installing ? "Installing…" : failed ? "Try again" : "Install now"}
        </Button>
        {installing ? (
          <Button
            size="small"
            onClick={() => void cancelInstall(capabilityId)}
            data-testid="capability-install-cancel"
            sx={{ textTransform: "none" }}
          >
            Cancel
          </Button>
        ) : null}
        {log.length > 0 ? (
          <Button
            size="small"
            onClick={() => setShowLog((value) => !value)}
            sx={{ textTransform: "none" }}
          >
            {showLog ? "Hide output" : "Show output"}
          </Button>
        ) : null}
      </Stack>

      <Collapse in={showLog || (installing && log.length > 0)} unmountOnExit>
        <InstallLog lines={log} />
      </Collapse>
    </Box>
  );
}
