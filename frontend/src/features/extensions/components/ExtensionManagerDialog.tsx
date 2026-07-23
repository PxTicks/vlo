import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { VLO_EXTENSION_SDK_VERSION } from "../constants";
import { VLO_APP_VERSION } from "../../project/constants";
import type {
  ExtensionInventoryItem,
  ExtensionInventoryStatus,
  ExtensionPreflightReport,
} from "../services/extensionManagementApi";
import { useExtensionManagementStore } from "../store/useExtensionManagementStore";
import { evaluateExtensionSdkCompatibility } from "../utils/sdkCompatibility";
import { evaluateExtensionVloCompatibility } from "../utils/sdkCompatibility";

interface ExtensionManagerDialogProps {
  open: boolean;
  onClose(): void;
}

interface ExtensionCardProps {
  item: ExtensionInventoryItem;
  busy: boolean;
  onApprove(item: ExtensionInventoryItem): void;
  onDisable(extensionId: string): void;
  onRevoke(extensionId: string): void;
}

interface ApprovalDialogProps {
  item: ExtensionInventoryItem | null;
  busy: boolean;
  onCancel(): void;
  onApprove(item: ExtensionInventoryItem): void;
}

const STATUS_LABELS: Record<ExtensionInventoryStatus, string> = {
  invalid: "Won't load",
  pending_approval: "Not allowed yet",
  approved: "Allowed",
  changed: "Changed",
  disabled: "Blocked",
};

function statusColor(
  status: ExtensionInventoryStatus,
): "default" | "error" | "success" | "warning" {
  if (status === "approved") return "success";
  if (status === "invalid") return "error";
  if (status === "pending_approval" || status === "changed") return "warning";
  return "default";
}

function statusMessage(item: ExtensionInventoryItem) {
  if (item.status === "invalid") {
    return (
      <Alert severity="error">
        {item.errors.length > 0
          ? item.errors.join(" ")
          : "vlo cannot read this extension, so it cannot be allowed."}
      </Alert>
    );
  }
  if (item.status === "changed") {
    return (
      <Alert severity="warning">
        This extension has been altered since you last allowed it. It will not
        run until you check that you still trust it and allow it again.
      </Alert>
    );
  }
  if (item.status === "pending_approval") {
    return (
      <Alert severity="info">
        This extension is new. It will not run until you allow it.
      </Alert>
    );
  }
  if (item.status === "disabled") {
    return (
      <Alert severity="info">
        You blocked this extension. It will not run.
      </Alert>
    );
  }
  return null;
}

function backendRuntimeMessage(item: ExtensionInventoryItem) {
  if (item.manifest?.backend === undefined) return null;

  const severity =
    item.backendRuntime.status === "active"
      ? "success"
      : item.backendRuntime.status === "failed"
        ? "error"
        : item.backendRuntime.status === "restart_required"
          ? "warning"
          : "info";
  return (
    <Alert severity={severity}>
      Background service: {item.backendRuntime.message}
    </Alert>
  );
}

function DependencyPreflightSection({
  preflight,
}: {
  preflight: ExtensionPreflightReport | null;
}) {
  if (preflight === null) return null;

  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        Extra software this extension needs
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        display="block"
        sx={{ overflowWrap: "anywhere" }}
      >
        Checked against: {preflight.environment}
        {preflight.isolated ? "" : " (not an isolated virtual environment)"}
      </Typography>
      <Stack spacing={0.5} sx={{ mt: 0.5 }}>
        {preflight.dependencies.map((dependency) => (
          <Box
            key={dependency.module}
            sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}
          >
            {dependency.satisfied ? (
              <CheckCircleOutlineIcon color="success" fontSize="small" />
            ) : (
              <ErrorOutlineIcon color="warning" fontSize="small" />
            )}
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2">
                <strong>{dependency.module}</strong>
                {dependency.distribution
                  ? ` · ${dependency.distribution}`
                  : ""}
              </Typography>
              {dependency.purpose ? (
                <Typography variant="caption" color="text.secondary">
                  {dependency.purpose}
                </Typography>
              ) : null}
              {!dependency.satisfied ? (
                <Typography variant="caption" color="text.secondary" display="block">
                  {dependency.detail}
                </Typography>
              ) : null}
            </Box>
          </Box>
        ))}
      </Stack>
      {preflight.satisfied ? (
        <Alert severity="success" sx={{ mt: 1 }}>
          Everything this extension needs is already installed.
        </Alert>
      ) : (
        <Alert severity="warning" sx={{ mt: 1 }}>
          Some of it is missing. Run this to install it, then restart vlo:
          <Box
            component="pre"
            sx={{
              mt: 1,
              mb: 0,
              p: 1,
              borderRadius: 1,
              bgcolor: "action.hover",
              fontFamily: "monospace",
              fontSize: "0.75rem",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {preflight.installHints.join("\n")}
          </Box>
        </Alert>
      )}
    </Box>
  );
}

function ExtensionCard({
  item,
  busy,
  onApprove,
  onDisable,
  onRevoke,
}: ExtensionCardProps) {
  const manifest = item.manifest;
  const sdkCompatibility = manifest
    ? evaluateExtensionSdkCompatibility(manifest.sdk)
    : null;
  const vloCompatibility = manifest?.vlo
    ? evaluateExtensionVloCompatibility(manifest.vlo, VLO_APP_VERSION)
    : null;
  const canApprove =
    manifest !== null &&
    item.digest !== null &&
    sdkCompatibility?.compatible === true &&
    vloCompatibility?.compatible !== false &&
    ["pending_approval", "changed", "disabled"].includes(item.status);
  const canRevoke = item.approval !== null && item.status !== "invalid";

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Box
          sx={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 2,
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={600}>
              {manifest?.name ?? item.id}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {item.id}
              {manifest ? ` · v${manifest.version}` : ""}
            </Typography>
            <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
              <Chip
                size="small"
                variant="outlined"
                label={manifest?.contributions?.luts ? "Look pack" : "Extension"}
              />
              {manifest?.capabilities.includes("render.filter-pack") ? (
                <Chip size="small" variant="outlined" label="Filter pack" />
              ) : null}
            </Stack>
          </Box>
          <Chip
            size="small"
            label={STATUS_LABELS[item.status]}
            color={statusColor(item.status)}
          />
        </Box>

        {statusMessage(item)}
        {backendRuntimeMessage(item)}

        {sdkCompatibility && !sdkCompatibility.compatible ? (
          <Alert severity="error">
            This extension was built for a different version of vlo, so it
            cannot run here. {sdkCompatibility.reason}
          </Alert>
        ) : null}

        {vloCompatibility && !vloCompatibility.compatible ? (
          <Alert severity="error">
            This extension does not support vlo {VLO_APP_VERSION}, so it cannot
            run here. {vloCompatibility.reason}
          </Alert>
        ) : null}
        {vloCompatibility?.warning ? (
          <Alert severity="warning">{vloCompatibility.warning}</Alert>
        ) : null}

        <Box>
          <Typography variant="caption" color="text.secondary">
            Installed at
          </Typography>
          <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
            {item.sourcePath}
          </Typography>
        </Box>

        {item.digest ? (
          <Box>
            <Typography variant="caption" color="text.secondary">
              Exact contents (fingerprint)
            </Typography>
            <Typography
              variant="body2"
              sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}
            >
              {item.digest}
            </Typography>
          </Box>
        ) : null}

        {manifest ? (
          <Stack spacing={1}>
            <Typography variant="body2">
              Declared SDK range: <strong>{manifest.sdk}</strong> · Host SDK:{" "}
              <strong>{VLO_EXTENSION_SDK_VERSION}</strong>
            </Typography>
            {manifest.vlo ? (
              <Typography variant="body2">
                Declared VLO range: <strong>{manifest.vlo}</strong> · Host VLO:{" "}
                <strong>{VLO_APP_VERSION ?? "unknown"}</strong>
              </Typography>
            ) : null}
            {[manifest.frontend?.entry, manifest.backend?.entry].some(Boolean) ? (
              <Typography variant="body2">
                Runs its own code: {[manifest.frontend?.entry, manifest.backend?.entry]
                  .filter((entry): entry is string => Boolean(entry))
                  .join(", ")}
              </Typography>
            ) : (
              <Typography variant="body2">
                Adds ready-made looks and presets only. Contains no code.
              </Typography>
            )}
            <Box>
              <Typography variant="caption" color="text.secondary">
                What the author says it does
              </Typography>
              <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                {manifest.capabilities.length > 0 ? (
                  manifest.capabilities.map((capability) => (
                    <Chip key={capability} size="small" label={capability} />
                  ))
                ) : (
                  <Typography variant="body2">None declared</Typography>
                )}
              </Stack>
            </Box>
            {manifest.capabilities.includes("host.raw") ? (
              <Alert severity="info">
                This list is what the author declared, not a limit vlo enforces.
                Allowing an extension gives it full access either way.
              </Alert>
            ) : null}
          </Stack>
        ) : null}

        <DependencyPreflightSection preflight={item.preflight} />

        <Stack direction="row" spacing={1} justifyContent="flex-end">
          {canRevoke ? (
            <Button
              color="error"
              disabled={busy}
              onClick={() => onRevoke(item.id)}
            >
              Forget my answer
            </Button>
          ) : null}
          {item.status === "approved" ? (
            <Button disabled={busy} onClick={() => onDisable(item.id)}>
              Block
            </Button>
          ) : null}
          {canApprove ? (
            <Button
              variant="contained"
              disabled={busy}
              onClick={() => onApprove(item)}
            >
              {item.status === "disabled" ? "Allow again" : "Allow"}
            </Button>
          ) : null}
        </Stack>
      </Stack>
    </Paper>
  );
}

function ExtensionApprovalDialog({
  item,
  busy,
  onCancel,
  onApprove,
}: ApprovalDialogProps) {
  const manifest = item?.manifest ?? null;

  return (
    <Dialog open={item !== null} onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>Allow this extension to run?</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {manifest?.frontend || manifest?.backend ? (
            <Alert severity="warning">
              This extension runs its own code, with the same access that vlo
              itself has. Only allow it if you trust whoever made it, or you
              know what you&apos;re doing. Extensions can pose security risks.
            </Alert>
          ) : (
            <Alert severity="info">
              This extension only adds ready-made looks and presets. It contains
              no code of its own.
            </Alert>
          )}
          <Typography>
            Allow <strong>{manifest?.name ?? item?.id}</strong> only if you
            trust where it came from.
          </Typography>
          {item?.digest ? (
            <Box>
              <Typography variant="caption" color="text.secondary">
                Exact contents (fingerprint)
              </Typography>
              <Typography
                variant="body2"
                sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}
              >
                {item.digest}
              </Typography>
            </Box>
          ) : null}
          {manifest?.backend ? (
            <Alert severity="info">
              Part of this extension runs outside the editor and only starts
              when vlo restarts. Allowing it never installs anything for you —
              see the list below for what it needs.
            </Alert>
          ) : null}
          {item ? (
            <DependencyPreflightSection preflight={item.preflight} />
          ) : null}
          {manifest?.frontend ? (
            <Alert severity="info">
              Extensions load when vlo starts, so this takes effect after a
              restart. Blocking one takes effect after a restart too.
            </Alert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>
          Cancel
        </Button>
        <Button
          color="warning"
          variant="contained"
          disabled={busy || item?.digest == null}
          onClick={() => {
            if (item) onApprove(item);
          }}
        >
          {busy ? <CircularProgress size={18} /> : "Yes, allow it"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function ExtensionManagerDialog({
  open,
  onClose,
}: ExtensionManagerDialogProps) {
  const items = useExtensionManagementStore((state) => state.items);
  const loadStatus = useExtensionManagementStore((state) => state.loadStatus);
  const error = useExtensionManagementStore((state) => state.error);
  const mutation = useExtensionManagementStore((state) => state.mutation);
  const load = useExtensionManagementStore((state) => state.load);
  const approve = useExtensionManagementStore((state) => state.approve);
  const disable = useExtensionManagementStore((state) => state.disable);
  const revoke = useExtensionManagementStore((state) => state.revoke);
  const cancelPending = useExtensionManagementStore(
    (state) => state.cancelPending,
  );
  const [approvalItem, setApprovalItem] =
    useState<ExtensionInventoryItem | null>(null);

  useEffect(() => {
    if (!open) return;
    void load();
    return cancelPending;
  }, [cancelPending, load, open]);

  const handleApprove = async (item: ExtensionInventoryItem) => {
    if (!item.digest) return;
    const approved = await approve(item.id, item.digest);
    if (approved) setApprovalItem(null);
  };

  const handleClose = () => {
    cancelPending();
    setApprovalItem(null);
    onClose();
  };

  const handleApprovalCancel = () => {
    cancelPending();
    setApprovalItem(null);
  };

  const busy = mutation !== null;

  return (
    <>
      <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
        <DialogTitle
          sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
        >
          Extension manager
          <IconButton
            aria-label="Refresh extensions"
            disabled={loadStatus === "loading" || busy}
            onClick={() => void load()}
          >
            <RefreshIcon />
          </IconButton>
        </DialogTitle>
        <Divider />
        <DialogContent>
          <Stack spacing={2}>
            <Alert severity="warning">
              Extensions are not sandboxed: an extension you allow can do
              anything vlo can do. Only allow ones you trust. Your answer covers
              the exact contents listed here — if an extension changes, vlo asks
              again.
            </Alert>
            <Alert severity="info">
              Extensions load when vlo starts, so any change you make here takes
              effect after a restart.
            </Alert>

            {error ? <Alert severity="error">{error}</Alert> : null}

            {loadStatus === "loading" && items.length === 0 ? (
              <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                <CircularProgress aria-label="Loading extensions" />
              </Box>
            ) : null}

            {loadStatus === "ready" && items.length === 0 ? (
              <Typography color="text.secondary">
                No extensions are installed.
              </Typography>
            ) : null}

            {items.map((item) => (
              <ExtensionCard
                key={item.id}
                item={item}
                busy={busy}
                onApprove={setApprovalItem}
                onDisable={(extensionId) => void disable(extensionId)}
                onRevoke={(extensionId) => void revoke(extensionId)}
              />
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>
            Close
          </Button>
        </DialogActions>
      </Dialog>

      <ExtensionApprovalDialog
        item={approvalItem}
        busy={mutation?.action === "approve"}
        onCancel={handleApprovalCancel}
        onApprove={(item) => void handleApprove(item)}
      />
    </>
  );
}
