import { Box, Button, Typography } from "@mui/material";
import type { ComfyUiNodePackReport } from "../../../types/RuntimeStatus";
import {
  useComfyuiNodePackUpdate,
  type ComfyuiNodePackUpdate,
} from "../hooks/useComfyuiNodePackUpdate";
import { ComfyuiLaunchProgress } from "./ComfyuiLaunchProgress";

interface ComfyuiNodePackNoticeProps {
  report: ComfyUiNodePackReport | undefined;
  /** Called when an in-app update ends, so the report can be re-read. */
  onUpdateFinished: () => void;
}

function describeProblem(report: ComfyUiNodePackReport): string {
  const need = `vlo's workflows need ${report.requiredVersion} or newer.`;
  switch (report.status) {
    case "missing":
      return `ComfyUI-vlo was not found in this ComfyUI's custom_nodes. ${need}`;
    case "unreadable":
      return `This ComfyUI-vlo has no readable version. ${need}`;
    default:
      return `ComfyUI-vlo ${report.installedVersion} is installed. ${need}`;
  }
}

function manualInstructions(report: ComfyUiNodePackReport): string {
  if (!report.updateCommand) {
    return "Update it from ComfyUI-Manager, then restart ComfyUI.";
  }
  return report.managed
    ? "Or run this yourself, then restart ComfyUI."
    : "Run this, then restart ComfyUI.";
}

function isProblem(report: ComfyUiNodePackReport | undefined): boolean {
  return (
    report?.status === "outdated" ||
    report?.status === "unreadable" ||
    report?.status === "missing"
  );
}

/**
 * Warns when the configured ComfyUI's ComfyUI-vlo is older than vlo's
 * workflows need. An old pack can still define every node class, so the
 * per-workflow missing-node warning does not catch it; the generation would
 * otherwise fail inside ComfyUI's validation. A pack vlo cloned can be
 * updated from here; any other only gets the command to run.
 */
export function ComfyuiNodePackNotice({
  report,
  onUpdateFinished,
}: ComfyuiNodePackNoticeProps) {
  const update = useComfyuiNodePackUpdate(onUpdateFinished);

  if (report && isProblem(report)) {
    return <OutdatedNotice report={report} update={update} />;
  }
  // The update job is shown on its own terms: it can fail after the pull has
  // already made the report current, e.g. when ComfyUI does not restart.
  if (update.isRunning || update.error || update.status?.phase === "complete") {
    return <UpdateOutcome update={update} />;
  }
  return null;
}

interface OutdatedNoticeProps {
  report: ComfyUiNodePackReport;
  update: ComfyuiNodePackUpdate;
}

function OutdatedNotice({ report, update }: OutdatedNoticeProps) {
  const canUpdateInApp = report.managed && report.status !== "missing";

  return (
    <Box
      role="status"
      sx={{
        mx: 2,
        mb: 1,
        p: 1.5,
        border: "1px solid",
        borderColor: "warning.main",
        borderRadius: 1,
      }}
    >
      <Typography variant="subtitle2">
        {report.status === "missing"
          ? "ComfyUI-vlo is missing"
          : "ComfyUI-vlo needs an update"}
      </Typography>
      <Typography
        variant="caption"
        sx={{ color: "text.secondary", display: "block", mt: 0.5 }}
      >
        {describeProblem(report)}
      </Typography>
      {canUpdateInApp ? (
        update.isRunning ? (
          <ComfyuiLaunchProgress
            message={update.status?.message ?? "Updating ComfyUI-vlo…"}
            latestOutput={update.status?.logLine ?? null}
          />
        ) : (
          <Button
            variant="contained"
            size="small"
            onClick={update.start}
            sx={{ mt: 1.5, textTransform: "none" }}
          >
            Update ComfyUI-vlo
          </Button>
        )
      ) : null}
      {update.error ? (
        <Typography
          variant="caption"
          sx={{ color: "error.main", display: "block", mt: 1 }}
        >
          {update.error}
        </Typography>
      ) : null}
      {report.updateCommand ? (
        <Typography
          component="code"
          variant="caption"
          sx={{
            display: "block",
            mt: 1,
            p: 0.75,
            borderRadius: 0.5,
            bgcolor: "action.hover",
            fontFamily: "monospace",
            fontSize: 11,
            overflowWrap: "anywhere",
            userSelect: "all",
          }}
        >
          {report.updateCommand}
        </Typography>
      ) : null}
      <Typography
        variant="caption"
        sx={{ color: "text.secondary", display: "block", mt: 0.75 }}
      >
        {manualInstructions(report)}
      </Typography>
    </Box>
  );
}

function UpdateOutcome({ update }: { update: ComfyuiNodePackUpdate }) {
  const failed = Boolean(update.error);

  return (
    <Box
      role="status"
      sx={{
        mx: 2,
        mb: 1,
        p: 1.5,
        border: "1px solid",
        borderColor: update.isRunning
          ? "divider"
          : failed
            ? "error.main"
            : "success.main",
        borderRadius: 1,
      }}
    >
      {update.isRunning ? (
        <ComfyuiLaunchProgress
          message={update.status?.message ?? "Updating ComfyUI-vlo…"}
          latestOutput={update.status?.logLine ?? null}
        />
      ) : (
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
          <Box sx={{ flex: 1 }}>
            {update.status?.message ? (
              <Typography variant="caption" sx={{ display: "block" }}>
                {update.status.message}
              </Typography>
            ) : null}
            {update.error ? (
              <Typography
                variant="caption"
                sx={{ color: "error.main", display: "block", mt: 0.5 }}
              >
                {update.error}
              </Typography>
            ) : null}
          </Box>
          <Button
            size="small"
            onClick={update.dismiss}
            sx={{ textTransform: "none" }}
          >
            Dismiss
          </Button>
        </Box>
      )}
    </Box>
  );
}
