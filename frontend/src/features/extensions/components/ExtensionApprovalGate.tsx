import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";
import { VLO_APP_VERSION } from "../../project/constants";
import type { ExtensionInventoryItem } from "../services/extensionManagementApi";
import { useExtensionManagementStore } from "../store/useExtensionManagementStore";
import {
  evaluateExtensionSdkCompatibility,
  evaluateExtensionVloCompatibility,
} from "../utils/sdkCompatibility";

/**
 * Blocking trust prompt for new and altered extensions, shown on the project
 * menu because that is the only point where activation state can still change
 * without discarding editor work. Both answers are remembered against the
 * exact package contents that were reviewed, so the prompt returns only when
 * the package itself changes.
 */

interface ExtensionApprovalGateProps {
  /** Escape hatch for tests; production reloads the page to activate. */
  onReload?(): void;
}

/**
 * A package can only be decided on if approving it would actually let it run.
 * Packages the host cannot load are left for the extension manager to explain
 * rather than asked about here, since neither answer would change anything.
 */
function needsDecision(item: ExtensionInventoryItem): boolean {
  if (item.status !== "pending_approval" && item.status !== "changed") {
    return false;
  }
  if (item.manifest === null || item.digest === null) return false;
  if (!evaluateExtensionSdkCompatibility(item.manifest.sdk).compatible) {
    return false;
  }
  if (item.manifest.vlo === undefined) return true;
  return evaluateExtensionVloCompatibility(item.manifest.vlo, VLO_APP_VERSION)
    .compatible;
}

function reachDescription(item: ExtensionInventoryItem): string {
  const manifest = item.manifest;
  if (manifest?.backend) {
    return "It runs its own code inside vlo and on this computer, with the same access that vlo itself has.";
  }
  if (manifest?.frontend) {
    return "It runs its own code inside vlo, with the same access that vlo itself has.";
  }
  return "It only adds ready-made looks and presets. It contains no code of its own.";
}

export function ExtensionApprovalGate({ onReload }: ExtensionApprovalGateProps) {
  const items = useExtensionManagementStore((state) => state.items);
  const loadStatus = useExtensionManagementStore((state) => state.loadStatus);
  const error = useExtensionManagementStore((state) => state.error);
  const mutation = useExtensionManagementStore((state) => state.mutation);
  const load = useExtensionManagementStore((state) => state.load);
  const approve = useExtensionManagementStore((state) => state.approve);
  const decline = useExtensionManagementStore((state) => state.decline);
  const cancelPending = useExtensionManagementStore(
    (state) => state.cancelPending,
  );
  const [allowedNames, setAllowedNames] = useState<string[]>([]);
  // Nothing the user has answered may return to the queue. This dialog blocks
  // the project menu, so a decision the backend reports oddly must still let
  // the queue drain rather than trapping the user behind it.
  const [decidedIds, setDecidedIds] = useState<readonly string[]>([]);
  // Keyed by extension so the panel collapses on its own as the queue advances.
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    void load();
    return cancelPending;
  }, [cancelPending, load]);

  const undecided = useMemo(
    () =>
      items.filter((item) => needsDecision(item) && !decidedIds.includes(item.id)),
    [decidedIds, items],
  );
  const current = undecided[0] ?? null;
  const busy = mutation !== null;

  // The queue empties as decisions land, so the reload offer is the terminal
  // state rather than a separate screen the user can navigate back from.
  const showReloadOffer =
    current === null && allowedNames.length > 0 && !finished;
  const open = current !== null || showReloadOffer;

  const detailsOpen = current !== null && detailsFor === current.id;

  if (!open || loadStatus === "idle") return null;

  const manifest = current?.manifest ?? null;
  const displayName = manifest?.name ?? current?.id ?? "";
  const isChanged = current?.status === "changed";
  const total = decidedIds.length + undecided.length;
  const position = total > 1 ? `${decidedIds.length + 1} of ${total}` : null;

  const markDecided = (extensionId: string) => {
    setDecidedIds((ids) => [...ids, extensionId]);
  };

  const handleAllow = async () => {
    if (!current?.digest) return;
    const name = displayName;
    if (await approve(current.id, current.digest)) {
      setAllowedNames((names) => [...names, name]);
      markDecided(current.id);
    }
  };

  const handleBlock = async () => {
    if (!current?.digest) return;
    if (await decline(current.id, current.digest)) {
      markDecided(current.id);
    }
  };

  const handleReload = () => {
    if (onReload) {
      onReload();
      return;
    }
    window.location.reload();
  };

  return (
    <Dialog
      open
      disableEscapeKeyDown
      maxWidth="sm"
      fullWidth
      aria-labelledby="extension-approval-gate-title"
      data-testid="extension-approval-gate"
    >
      {current ? (
        <>
          <DialogTitle
            id="extension-approval-gate-title"
            sx={{ display: "flex", alignItems: "center", gap: 1.5 }}
          >
            <ShieldOutlinedIcon color="warning" />
            <Box sx={{ minWidth: 0, flex: 1 }}>
              {isChanged ? "An extension has changed" : "A new extension was found"}
            </Box>
            {position ? (
              <Chip size="small" variant="outlined" label={position} />
            ) : null}
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              <Box>
                <Typography variant="h6" fontWeight={600}>
                  {displayName}
                </Typography>
                {manifest ? (
                  <Typography variant="body2" color="text.secondary">
                    Version {manifest.version}
                  </Typography>
                ) : null}
              </Box>

              <Typography>
                {isChanged
                  ? "This extension has been altered since you last allowed it."
                  : "This extension is new."}{" "}
                Only allow it if you trust whoever made it, or you know what
                you&apos;re doing. Extensions can pose security risks.
              </Typography>

              <Typography variant="body2" color="text.secondary">
                {reachDescription(current)}
              </Typography>

              <Typography variant="body2" color="text.secondary">
                If you are not sure, block it. Nothing breaks, and you can
                change your mind later in Settings.
              </Typography>

              {error ? <Alert severity="error">{error}</Alert> : null}

              <Box>
                <Button
                  size="small"
                  onClick={() =>
                    setDetailsFor((value) =>
                      value === current.id ? null : current.id,
                    )
                  }
                  data-testid="extension-approval-gate-details-toggle"
                >
                  {detailsOpen ? "Hide details" : "Show details"}
                </Button>
                <Collapse in={detailsOpen} unmountOnExit>
                  <Stack spacing={1} sx={{ mt: 1 }}>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        Installed at
                      </Typography>
                      <Typography
                        variant="body2"
                        sx={{ overflowWrap: "anywhere" }}
                      >
                        {current.sourcePath}
                      </Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        Exact contents (fingerprint)
                      </Typography>
                      <Typography
                        variant="body2"
                        sx={{
                          fontFamily: "monospace",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {current.digest}
                      </Typography>
                    </Box>
                    <Typography variant="body2" color="text.secondary">
                      Your answer applies to these exact contents. If the
                      extension changes again, you will be asked again.
                    </Typography>
                  </Stack>
                </Collapse>
              </Box>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              disabled={busy}
              onClick={() => void handleBlock()}
              data-testid="extension-approval-gate-block"
            >
              {mutation?.action === "decline" ? (
                <CircularProgress size={18} />
              ) : (
                "Block"
              )}
            </Button>
            <Button
              variant="contained"
              color="warning"
              disabled={busy}
              onClick={() => void handleAllow()}
              data-testid="extension-approval-gate-allow"
            >
              {mutation?.action === "approve" ? (
                <CircularProgress size={18} />
              ) : (
                "Allow"
              )}
            </Button>
          </DialogActions>
        </>
      ) : (
        <>
          <DialogTitle id="extension-approval-gate-title">
            Restart to finish
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              <Typography>
                {allowedNames.length === 1
                  ? `${allowedNames[0]} is allowed to run.`
                  : `${allowedNames.length} extensions are allowed to run.`}{" "}
                vlo needs to restart before it can load them.
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Nothing is open yet, so nothing will be lost.
              </Typography>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={() => setFinished(true)}
              data-testid="extension-approval-gate-later"
            >
              Not now
            </Button>
            <Button
              variant="contained"
              onClick={handleReload}
              data-testid="extension-approval-gate-reload"
            >
              Restart now
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}
