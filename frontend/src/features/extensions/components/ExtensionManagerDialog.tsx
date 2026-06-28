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
import { VLO_EXTENSION_SDK_VERSION } from "../constants";
import type {
  ExtensionInventoryItem,
  ExtensionInventoryStatus,
} from "../services/extensionManagementApi";
import { useExtensionManagementStore } from "../store/useExtensionManagementStore";
import { evaluateExtensionSdkCompatibility } from "../utils/sdkCompatibility";

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
  invalid: "Invalid",
  pending_approval: "Approval required",
  approved: "Approved",
  changed: "Changed",
  disabled: "Disabled",
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
          : "This package is invalid and cannot be approved."}
      </Alert>
    );
  }
  if (item.status === "changed") {
    return (
      <Alert severity="warning">
        Package bytes changed after approval. Review and approve the new digest
        before any code can run.
      </Alert>
    );
  }
  if (item.status === "pending_approval") {
    return (
      <Alert severity="info">
        The package is inert until you approve this exact digest.
      </Alert>
    );
  }
  if (item.status === "disabled") {
    return <Alert severity="info">Activation is disabled.</Alert>;
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
      Backend runtime: {item.backendRuntime.message}
    </Alert>
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
  const canApprove =
    manifest !== null &&
    item.digest !== null &&
    sdkCompatibility?.compatible === true &&
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
            This package cannot activate with extension SDK {VLO_EXTENSION_SDK_VERSION}.{" "}
            {sdkCompatibility.reason}
          </Alert>
        ) : null}

        <Box>
          <Typography variant="caption" color="text.secondary">
            Package
          </Typography>
          <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
            {item.sourcePath}
          </Typography>
        </Box>

        {item.digest ? (
          <Box>
            <Typography variant="caption" color="text.secondary">
              Current digest
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
            <Typography variant="body2">
              Entry points: {[manifest.frontend?.entry, manifest.backend?.entry]
                .filter((entry): entry is string => Boolean(entry))
                .join(", ")}
            </Typography>
            <Box>
              <Typography variant="caption" color="text.secondary">
                Requested capabilities
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
          </Stack>
        ) : null}

        <Stack direction="row" spacing={1} justifyContent="flex-end">
          {canRevoke ? (
            <Button
              color="error"
              disabled={busy}
              onClick={() => onRevoke(item.id)}
            >
              Revoke approval
            </Button>
          ) : null}
          {item.status === "approved" ? (
            <Button disabled={busy} onClick={() => onDisable(item.id)}>
              Disable on reload
            </Button>
          ) : null}
          {canApprove ? (
            <Button
              variant="contained"
              disabled={busy}
              onClick={() => onApprove(item)}
            >
              {item.status === "disabled"
                ? "Review & re-enable"
                : "Approve current digest"}
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
      <DialogTitle>Trust and approve extension?</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Alert severity="warning">
            Approved extensions are trusted code. Frontend code can access the
            editor and browser context; backend code runs with the backend
            process&apos;s authority. Capability declarations are informational,
            not enforced permissions.
          </Alert>
          <Typography>
            Approve <strong>{manifest?.name ?? item?.id}</strong> only if you
            trust its source and have reviewed the requested capabilities.
          </Typography>
          {item?.digest ? (
            <Box>
              <Typography variant="caption" color="text.secondary">
                Exact package digest
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
              Backend activation requires an application restart. Dependency
              installation is a separate operation and is not performed by this
              approval.
            </Alert>
          ) : null}
          {manifest?.frontend ? (
            <Alert severity="info">
              Approved frontend code activates at the next page load. Disabling
              or revoking an active extension also takes full effect after reload.
            </Alert>
          ) : null}
          {manifest ? (
            <Typography variant="body2" color="text.secondary">
              Declared SDK range: {manifest.sdk}. Approval does not guarantee
              that an incompatible package can activate.
            </Typography>
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
          {busy ? <CircularProgress size={18} /> : "Approve exact digest"}
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
              This is a trusted extension system, not a sandbox. Approval is
              bound to the displayed package digest; any byte change requires
              approval again. Declared capabilities are informational rather
              than permission boundaries.
            </Alert>
            <Alert severity="info">
              Frontend activation state is established at page startup. Approval,
              disable, and revoke changes take full effect after reload.
            </Alert>

            {error ? <Alert severity="error">{error}</Alert> : null}

            {loadStatus === "loading" && items.length === 0 ? (
              <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                <CircularProgress aria-label="Loading extensions" />
              </Box>
            ) : null}

            {loadStatus === "ready" && items.length === 0 ? (
              <Typography color="text.secondary">
                No extension packages were found.
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
