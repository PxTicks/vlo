import { Box, Typography } from "@mui/material";
import type { ComfyUiNodePackReport } from "../../../types/RuntimeStatus";

interface ComfyuiNodePackNoticeProps {
  report: ComfyUiNodePackReport | undefined;
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

/**
 * Warns when the configured ComfyUI's ComfyUI-vlo is older than vlo's
 * workflows need. An old pack can still define every node class, so the
 * per-workflow missing-node warning does not catch it; the generation would
 * otherwise fail inside ComfyUI's validation.
 */
export function ComfyuiNodePackNotice({ report }: ComfyuiNodePackNoticeProps) {
  if (!report || report.status === "ok" || report.status === "not_checked") {
    return null;
  }

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
        {report.updateCommand
          ? "Run this, then restart ComfyUI."
          : "Update it from ComfyUI-Manager, then restart ComfyUI."}
      </Typography>
    </Box>
  );
}
