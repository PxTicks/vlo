import { useState } from "react";
import {
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import type {
  CapabilityCheck,
  CapabilityState,
  RuntimeCapability,
} from "../../../types/RuntimeStatus";
import { failureHeadline } from "../failureCodes";
import { CapabilityFailureNotice } from "./CapabilityFailureNotice";

interface RuntimeCapabilityCardProps {
  capability: RuntimeCapability;
  refreshing: boolean;
  testing: boolean;
  onRecheck: (capabilityId: string) => void;
  onTest: (capabilityId: string) => void;
}

const STATE_LABELS: Record<CapabilityState, string> = {
  unavailable: "Not installed",
  blocked: "Blocked",
  available_unverified: "Installed, unverified",
  ready: "Ready",
  degraded: "Degraded",
  checking: "Checking",
};

const STATE_COLORS: Record<
  CapabilityState,
  "default" | "success" | "warning" | "error" | "info"
> = {
  unavailable: "default",
  blocked: "error",
  available_unverified: "info",
  ready: "success",
  degraded: "warning",
  checking: "info",
};

const CHECK_MARKS: Record<CapabilityCheck["status"], string> = {
  pass: "✓",
  warn: "!",
  fail: "✕",
  skipped: "–",
};

function verificationLabel(capability: RuntimeCapability): string {
  switch (capability.verifiedThrough) {
    case "discovered":
      return "Files found";
    case "environment":
      return "Environment checked";
    case "loaded":
      return "Loaded successfully";
    case "operational":
      return "Ran successfully";
    default:
      return "Nothing verified";
  }
}

function deviceLabel(capability: RuntimeCapability): string | null {
  const device = capability.device;
  if (!device) return null;
  if (!device.resolved) return `${device.requested} (unresolved)`;
  if (device.requested === device.resolved) {
    return device.proven ? device.resolved : `${device.resolved} (expected)`;
  }
  return `${device.requested} → ${device.resolved}`;
}

export function RuntimeCapabilityCard({
  capability,
  refreshing,
  testing,
  onRecheck,
  onTest,
}: RuntimeCapabilityCardProps) {
  const [expanded, setExpanded] = useState(false);
  const failure = capability.checks.find((check) => check.status === "fail") ?? null;
  const hasBlockingLastFailure = capability.checks.some(
    (check) => check.id === "runtime.lastFailure",
  );
  const device = deviceLabel(capability);

  return (
    <Paper
      variant="outlined"
      sx={{ p: 1.5 }}
      data-testid={`capability-card-${capability.id}`}
    >
      <Stack spacing={1}>
        <Box
          sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}
        >
          <Typography variant="subtitle2" sx={{ flex: 1 }}>
            {capability.label}
          </Typography>
          <Chip
            size="small"
            label={STATE_LABELS[capability.state]}
            color={STATE_COLORS[capability.state]}
            data-testid={`capability-state-${capability.id}`}
          />
          <Button
            size="small"
            onClick={() => onRecheck(capability.id)}
            disabled={refreshing}
            sx={{ textTransform: "none" }}
          >
            {refreshing ? "Rechecking…" : "Recheck"}
          </Button>
          <Button
            size="small"
            onClick={() => onTest(capability.id)}
            disabled={!capability.canAttempt || refreshing || testing}
            sx={{ textTransform: "none" }}
          >
            {testing ? "Testing…" : "Test runtime"}
          </Button>
        </Box>

        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {/* The state alone is ambiguous without saying how far the evidence
              reaches — "installed" and "load-tested" are different claims. */}
          {verificationLabel(capability)}
          {capability.selectedModel ? ` · ${capability.selectedModel}` : ""}
          {device ? ` · ${device}` : ""}
          {` · checked ${new Date(capability.checkedAt).toLocaleTimeString()}`}
        </Typography>

        <CapabilityFailureNotice
          capabilityLabel={capability.label}
          failure={failure}
          lastFailure={capability.lastFailure}
        />

        {/* A failure that is not blocking is still worth seeing: an
            out-of-memory under load says nothing about the install, so it
            never becomes a failing check — and would otherwise be recorded
            where nobody looks. */}
        {!hasBlockingLastFailure && capability.lastFailure ? (
          <Typography
            variant="caption"
            sx={{ color: "warning.main" }}
            data-testid={`capability-last-failure-${capability.id}`}
          >
            Last failure {new Date(capability.lastFailure.occurredAt).toLocaleTimeString()}:{" "}
            {failureHeadline(capability.lastFailure.code)} —{" "}
            {capability.lastFailure.detail ?? capability.lastFailure.summary}
          </Typography>
        ) : null}

        <Button
          size="small"
          onClick={() => setExpanded((value) => !value)}
          sx={{ alignSelf: "flex-start", textTransform: "none" }}
        >
          {expanded ? "Hide details" : "Technical details"}
        </Button>
        <Collapse in={expanded} unmountOnExit>
          <Divider sx={{ mb: 1 }} />
          <Stack spacing={0.5}>
            {capability.checks.map((check) => (
              <Box key={check.id} data-testid={`capability-check-${check.id}`}>
                <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
                  {CHECK_MARKS[check.status]} {check.id} — {check.summary}
                  {check.code ? ` [${check.code}]` : ""}
                </Typography>
                {check.detail ? (
                  <Typography
                    variant="caption"
                    sx={{ color: "text.secondary", display: "block", pl: 2 }}
                  >
                    {check.detail}
                  </Typography>
                ) : null}
              </Box>
            ))}
          </Stack>
        </Collapse>
      </Stack>
    </Paper>
  );
}
