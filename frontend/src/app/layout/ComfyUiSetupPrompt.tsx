import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  TextField,
  Typography,
} from "@mui/material";
import {
  getComfyuiInstallStatus,
  getRuntimeSettings,
  installComfyui,
  pickComfyuiDirectory,
  updateRuntimeSettings,
  verifyComfyuiInstall,
  type ComfyuiInstallStatus,
} from "../../services/runtimeApi";
import type { ComfyuiInstallVerification } from "../../types/RuntimeStatus";

type SetupPurpose = "install" | "existing";

export function ComfyUiSetupPrompt() {
  const [open, setOpen] = useState(false);
  const [pickerPurpose, setPickerPurpose] = useState<SetupPurpose | null>(null);
  const [manualPurpose, setManualPurpose] = useState<SetupPurpose | null>(null);
  const [manualPath, setManualPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pickerRequestRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [installStatus, setInstallStatus] =
    useState<ComfyuiInstallStatus | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void getRuntimeSettings({ signal: controller.signal })
      .then((payload) => {
        if (payload.recommendations.shouldPromptForComfyuiInstallDir) {
          setOpen(true);
          void getComfyuiInstallStatus()
            .then((status) => {
              if (
                !controller.signal.aborted &&
                (status.running || status.phase === "failed")
              ) {
                setInstallStatus(status);
              }
            })
            .catch(() => {
              // The setup choices remain usable without progress recovery.
            });
        }
      })
      .catch(() => {
        // Startup remains usable when the optional local-runtime API is absent.
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!installStatus?.running) return;
    const interval = window.setInterval(() => {
      void getComfyuiInstallStatus()
        .then((status) => {
          setInstallStatus(status);
          if (status.phase === "complete") {
            setOpen(false);
          }
        })
        .catch((err: unknown) => {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to read ComfyUI installation progress",
          );
        });
    }, 1500);
    return () => window.clearInterval(interval);
  }, [installStatus?.running]);

  // The native picker is a separate OS window that can open behind the
  // browser or, under WSLg, never become usable at all. Its request can then
  // block for minutes, so a typed path supersedes it and any late picker
  // result is ignored.
  const supersedePicker = () => {
    pickerRequestRef.current += 1;
    setPickerPurpose(null);
  };

  const applyExistingInstall = async (
    verification: ComfyuiInstallVerification | null,
  ) => {
    if (!verification?.valid) {
      throw new Error(
        verification?.warnings[0] ??
          "The selected folder is not a recognized ComfyUI install",
      );
    }
    await updateRuntimeSettings({
      comfyuiInstallDir: verification.installPath,
      comfyuiInstallDirPromptStatus: "accepted",
    });
    setOpen(false);
  };

  const applyInstallParent = async (parentPath: string) => {
    const status = await installComfyui(parentPath);
    setInstallStatus(status);
  };

  const handlePick = async (purpose: SetupPurpose) => {
    const requestId = ++pickerRequestRef.current;
    setPickerPurpose(purpose);
    setManualPurpose(purpose);
    setManualPath("");
    setError(null);
    try {
      const result = await pickComfyuiDirectory(purpose);
      if (pickerRequestRef.current !== requestId) return;
      setPickerPurpose(null);
      if (result.cancelled || !result.path) return;
      setSubmitting(true);
      if (purpose === "existing") {
        await applyExistingInstall(result.verification);
      } else {
        await applyInstallParent(result.path);
      }
    } catch (err) {
      if (pickerRequestRef.current !== requestId) return;
      setPickerPurpose(null);
      setError(
        err instanceof Error
          ? err.message
          : purpose === "existing"
            ? "Failed to choose ComfyUI"
            : "Failed to start installation",
      );
    } finally {
      if (pickerRequestRef.current === requestId) {
        setSubmitting(false);
      }
    }
  };

  const handleManualSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const path = manualPath.trim();
    if (!manualPurpose || !path) return;
    supersedePicker();
    setSubmitting(true);
    setError(null);
    try {
      if (manualPurpose === "existing") {
        await applyExistingInstall(await verifyComfyuiInstall(path));
      } else {
        await applyInstallParent(path);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : manualPurpose === "existing"
            ? "Failed to choose ComfyUI"
            : "Failed to start installation",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDecline = async () => {
    supersedePicker();
    setOpen(false);
    setSubmitting(true);
    setError(null);
    try {
      await updateRuntimeSettings({
        comfyuiInstallDirPromptStatus: "declined",
      });
    } catch (err) {
      console.warn(
        "[ComfyUI setup] Failed to persist the generative AI opt-out:",
        err,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const installing = installStatus?.running === true;
  const busy = pickerPurpose !== null || submitting;

  return (
    <Dialog
      open={open}
      onClose={(_event, reason) => {
        // The prompt can appear while the app is still loading, so a stray
        // click elsewhere must not lose it; only Escape or an explicit
        // choice dismisses it.
        if (reason === "backdropClick") return;
        setOpen(false);
      }}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>Connect vlo to ComfyUI</DialogTitle>
      <DialogContent>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            vlo works without generative AI, but generation workflows use a
            local or remote ComfyUI instance. Choose an existing local install
            or let vlo install one.
          </Typography>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {installStatus ? (
            <Alert
              severity={installStatus.phase === "failed" ? "error" : "info"}
            >
              {installStatus.error ??
                installStatus.message ??
                "Preparing ComfyUI…"}
              {installStatus.targetPath ? (
                <Typography variant="caption" component="div">
                  {installStatus.targetPath}
                </Typography>
              ) : null}
            </Alert>
          ) : null}
          {installing ? <LinearProgress /> : null}
          {installStatus?.logLine &&
          (installing || installStatus.phase === "failed") ? (
            <Typography
              variant="caption"
              title={installStatus.logLine}
              data-testid="comfyui-install-log-line"
              sx={{
                mt: -1.5,
                color: "text.secondary",
                fontFamily: "monospace",
                fontSize: 11,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {installStatus.logLine}
            </Typography>
          ) : null}
          {!installing ? (
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button
                variant="contained"
                onClick={() => void handlePick("install")}
                disabled={busy}
              >
                Install ComfyUI For Me
              </Button>
              <Button
                variant="outlined"
                onClick={() => void handlePick("existing")}
                disabled={busy}
              >
                Choose Existing Install
              </Button>
              {busy ? <CircularProgress size={24} /> : null}
            </Box>
          ) : null}
          {pickerPurpose ? (
            <Typography variant="body2" color="text.secondary">
              A folder picker opened in a separate window. If you can&apos;t
              find it, check your taskbar or type the path below.
            </Typography>
          ) : null}
          {manualPurpose && !installing ? (
            <Box
              component="form"
              onSubmit={(event: FormEvent<HTMLFormElement>) =>
                void handleManualSubmit(event)
              }
              sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}
            >
              <TextField
                label={
                  manualPurpose === "install"
                    ? "Install location"
                    : "ComfyUI folder"
                }
                helperText={
                  manualPurpose === "install"
                    ? "vlo creates a ComfyUI folder inside this folder."
                    : "The folder that contains ComfyUI's main.py."
                }
                value={manualPath}
                onChange={(event) => setManualPath(event.target.value)}
                disabled={submitting}
                size="small"
                fullWidth
              />
              <Button
                type="submit"
                variant="outlined"
                disabled={submitting || manualPath.trim().length === 0}
                sx={{ flexShrink: 0 }}
              >
                {manualPurpose === "install" ? "Install Here" : "Use Folder"}
              </Button>
            </Box>
          ) : null}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => void handleDecline()}
          disabled={submitting || installing}
        >
          Continue without generative AI
        </Button>
      </DialogActions>
    </Dialog>
  );
}
