import { Box, Paper, Stack, Typography } from "@mui/material";
import type { RuntimeEnvironmentSnapshot } from "../../../types/RuntimeStatus";

interface RuntimeEnvironmentCardProps {
  environment: RuntimeEnvironmentSnapshot;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ display: "flex", gap: 1 }}>
      <Typography variant="caption" sx={{ color: "text.secondary", minWidth: 96 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ wordBreak: "break-all" }}>
        {value}
      </Typography>
    </Box>
  );
}

/**
 * What the device probe established — and nothing more.
 *
 * "CPU only" is a finding: it means a probe ran and reported no accelerator.
 * A probe that failed, timed out, or never ran establishes nothing, and
 * rendering that as "CPU only" would invent a result.
 */
function describeDevices(environment: RuntimeEnvironmentSnapshot): string {
  const torch = environment.torch;
  if (!torch || torch.torchVersion === null) {
    const reason = torch?.error ?? environment.probe.error;
    return reason ? `Unknown — ${reason}` : "Unknown — no device probe has run";
  }
  if (torch.error) {
    return `Unknown — ${torch.error}`;
  }
  if (torch.devices.length > 0) {
    return torch.devices
      .map(
        (device) =>
          `${device.name} · ${Math.round(device.totalMemoryMb / 1024)} GB`,
      )
      .join(", ");
  }
  if (torch.cudaAvailable) return "CUDA available";
  if (torch.mpsAvailable) return "MPS available";
  return "CPU only";
}

export function RuntimeEnvironmentCard({
  environment,
}: RuntimeEnvironmentCardProps) {
  const torch = environment.torch;
  const unwritable = environment.directories.filter(
    (directory) => !directory.writable,
  );

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }} data-testid="environment-card">
      <Stack spacing={0.5}>
        <Typography variant="subtitle2">Backend environment</Typography>
        <Row
          label="Checked"
          value={new Date(environment.checkedAt).toLocaleTimeString()}
        />
        <Row
          label="Python"
          value={`${environment.python.version} (${environment.python.implementation})${
            environment.python.virtualEnv ? " · virtualenv" : ""
          }`}
        />
        <Row label="Interpreter" value={environment.python.executable} />
        <Row
          label="Platform"
          value={`${environment.platform.system} ${environment.platform.release} · ${environment.platform.machine}`}
        />
        <Row
          label="Torch"
          value={
            torch?.torchVersion
              ? `${torch.torchVersion}${
                  torch.cudaBuildVersion ? ` (CUDA ${torch.cudaBuildVersion})` : ""
                }`
              : "not reported"
          }
        />
        <Row label="Devices" value={describeDevices(environment)} />
        <Row
          label="Hugging Face"
          value={
            environment.huggingFace.tokenPresent
              ? `token present (${environment.huggingFace.tokenSource ?? "unknown source"})`
              : "no token"
          }
        />
        {unwritable.length > 0 ? (
          <Row
            label="Not writable"
            value={unwritable.map((directory) => directory.path).join(", ")}
          />
        ) : null}
      </Stack>
    </Paper>
  );
}
