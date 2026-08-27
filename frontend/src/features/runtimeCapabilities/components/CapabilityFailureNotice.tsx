import { useState, type ReactNode } from "react";
import { Alert, AlertTitle, Box, Button, Stack, Typography } from "@mui/material";
import type {
  CapabilityCheck,
  CapabilityFailureRecord,
} from "../../../types/RuntimeStatus";
import {
  failureHeadline,
  isInstallProblem,
  isModelProblem,
  severityForCode,
} from "../failureCodes";
import { useRuntimeCapabilityStore } from "../useRuntimeCapabilityStore";
import { CapabilityInstallAction } from "./CapabilityInstallAction";

interface CapabilityFailureNoticeProps {
  /**
   * Which capability this is about.
   *
   * Optional only for callers that predate it. With it, the notice can offer
   * to *run* the install rather than only print it — an install is requested
   * by id, so this is the whole of what that takes.
   */
  capabilityId?: string;
  capabilityLabel: string;
  failure: CapabilityCheck | null;
  lastFailure?: CapabilityFailureRecord | null;
  /**
   * The feature's own model-download UI. Rendered only for missing or
   * incomplete model files — the one class of failure it can actually fix.
   */
  downloadSurface?: ReactNode;
  fallbackMessage?: string | null;
  dense?: boolean;
}

function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard
      ?.writeText(command)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, mt: 0.75 }}>
      <Box
        component="code"
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
      <Button size="small" onClick={copy} sx={{ textTransform: "none" }}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </Box>
  );
}

/**
 * What went wrong and what can be done about it.
 *
 * The prose comes from the backend, which classified the failure; this
 * component only decides which affordance the code justifies. That is the
 * whole point of the code set: a missing package gets an install command, not
 * an invitation to re-download a model that is already there.
 */
export function CapabilityFailureNotice({
  capabilityId,
  capabilityLabel,
  failure,
  lastFailure = null,
  downloadSurface,
  fallbackMessage = null,
  dense = false,
}: CapabilityFailureNoticeProps) {
  const capability = useRuntimeCapabilityStore((state) =>
    capabilityId === undefined
      ? null
      : state.capabilities[capabilityId] ?? null,
  );
  const code = failure?.code ?? null;
  const summary = failure?.summary ?? fallbackMessage;
  const remediation = failure?.remediation ?? null;
  const showDownload = Boolean(downloadSurface) && isModelProblem(code);

  const install = capability?.install;
  const restartRequired = capability?.restartRequired ?? false;
  // Offered for the failures an install repairs — and afterwards, whatever the
  // checks now say, because a restart is still owed until the process has had
  // one.
  const showInstall =
    capabilityId !== undefined &&
    install !== undefined &&
    (isInstallProblem(code) || restartRequired);

  if (!summary && !showDownload && !showInstall) return null;

  /* The install action supersedes the printed remediation rather than sitting
     beside it: it renders the command that will actually run, and two similar
     command lines invite the user to run the wrong one. The documentation link
     survives, because when it is there it is saying something the command does
     not.

     Built here rather than inline because it outlives the failure that
     produced it: once an install has succeeded the checks may well pass, and
     the restart this leaves behind still has to be shown somewhere. */
  const installBlock =
    showInstall && install !== undefined && capabilityId !== undefined ? (
      <Box>
        <CapabilityInstallAction
          capabilityId={capabilityId}
          capabilityLabel={capabilityLabel}
          install={install}
          restartRequired={restartRequired}
          dense={dense}
        />
        {remediation?.url ? (
          <Typography variant="caption" sx={{ display: "block", mt: 0.5 }}>
            <a href={remediation.url} target="_blank" rel="noreferrer">
              {remediation.url}
            </a>
          </Typography>
        ) : null}
      </Box>
    ) : null;

  return (
    <Stack spacing={dense ? 0.75 : 1.25} data-testid="capability-failure-notice">
      {summary ? (
        <Alert
          severity={severityForCode(code)}
          data-testid="capability-failure-alert"
          data-failure-code={code ?? "unknown"}
          sx={{ py: dense ? 0.25 : undefined }}
        >
          {!dense ? (
            <AlertTitle sx={{ mb: 0.25 }}>
              {capabilityLabel} unavailable: {failureHeadline(code)}
            </AlertTitle>
          ) : null}
          <Typography variant="body2">{summary}</Typography>
          {failure?.detail ? (
            <Typography
              variant="caption"
              sx={{ color: "text.secondary", display: "block", mt: 0.5 }}
            >
              {failure.detail}
            </Typography>
          ) : null}
          {installBlock ?? (remediation ? (
            <Box sx={{ mt: 0.75 }}>
              <Typography variant="body2">{remediation.summary}</Typography>
              {remediation.command ? (
                <CommandBlock command={remediation.command} />
              ) : null}
              {remediation.url ? (
                <Typography variant="caption" sx={{ display: "block", mt: 0.5 }}>
                  <a href={remediation.url} target="_blank" rel="noreferrer">
                    {remediation.url}
                  </a>
                </Typography>
              ) : null}
              {remediation.requiresRestart ? (
                <Typography
                  variant="caption"
                  sx={{ color: "text.secondary", display: "block", mt: 0.5 }}
                >
                  Restart the backend afterwards for this to take effect.
                </Typography>
              ) : null}
            </Box>
          ) : null)}
          {code === "runtime_load_failed" && lastFailure ? (
            <Typography
              variant="caption"
              sx={{ color: "text.secondary", display: "block", mt: 0.5 }}
            >
              Last failure {new Date(lastFailure.occurredAt).toLocaleString()}:{" "}
              {lastFailure.detail ?? lastFailure.summary}
            </Typography>
          ) : null}
        </Alert>
      ) : (
        // No failing check to explain — but an install that has just finished
        // still leaves a restart owed, and this is where it is said.
        installBlock
      )}
      {showDownload ? downloadSurface : null}
    </Stack>
  );
}
