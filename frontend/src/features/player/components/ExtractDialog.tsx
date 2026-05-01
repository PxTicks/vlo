import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Stack,
  Typography,
  LinearProgress,
  Box,
  ButtonBase,
  Tooltip,
} from "@mui/material";
import CameraAltIcon from "@mui/icons-material/CameraAlt";
import ContentCutIcon from "@mui/icons-material/ContentCut";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import { CacheProvider, type EmotionCache } from "@emotion/react";
import createCache from "@emotion/cache";
import type { DialogView } from "../useExtractStore";

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow: (options?: {
        width?: number;
        height?: number;
      }) => Promise<Window>;
    };
  }
}

interface PipState {
  win: Window;
  container: HTMLElement;
  cache: EmotionCache;
}

function ExportProgressPip({ progress }: { progress: number }) {
  return (
    <Box sx={{ p: 2, color: "#eee", bgcolor: "#1a1a1a", minHeight: "100vh" }}>
      <Typography variant="body2" color="text.secondary" gutterBottom>
        Rendering... {Math.round(progress)}%
      </Typography>
      <LinearProgress variant="determinate" value={progress} sx={{ mb: 2 }} />
      <Typography variant="body2">
        You can move this popup somewhere inoffensive, but don&apos;t close it!{" "}
        <Tooltip
          title="Browser limitations throttle background tabs and this could interrupt the file export. This popup keeps the export running smoothly."
          arrow
        >
          <Box
            component="span"
            sx={{
              textDecoration: "underline dotted",
              cursor: "help",
              fontWeight: 600,
            }}
          >
            why?
          </Box>
        </Tooltip>
      </Typography>
    </Box>
  );
}

interface ExtractDialogProps {
  open: boolean;
  dialogView: DialogView;
  onClose: () => void;
  onCancelProcessing?: () => void;
  onExtractFrame: () => void;
  onExtractSelection: () => void;
  onExport: (resolution: number) => void;
  onSetView: (view: DialogView) => void;
  isProcessing: boolean;
  progress: number;
}

const optionButtonSx = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 1,
  p: 2.5,
  borderRadius: 2,
  bgcolor: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "#ccc",
  width: "100%",
  transition: "all 0.15s ease",
  "&:hover": {
    bgcolor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(255,255,255,0.25)",
    color: "#fff",
  },
} as const;

export function ExtractDialog({
  open,
  dialogView,
  onClose,
  onCancelProcessing,
  onExtractFrame,
  onExtractSelection,
  onExport,
  onSetView,
  isProcessing,
  progress,
}: ExtractDialogProps) {
  const [resolution, setResolution] = useState(1080);
  const [pip, setPip] = useState<PipState | null>(null);
  const handleCancelProcessing = onCancelProcessing ?? onClose;

  const exportInProgress = isProcessing && dialogView === "export";

  useEffect(() => {
    if (!exportInProgress) return;
    const dpip = window.documentPictureInPicture;
    if (!dpip) return;

    let cancelled = false;
    let openedWindow: Window | null = null;

    (async () => {
      try {
        const win = await dpip.requestWindow({ width: 380, height: 200 });
        if (cancelled) {
          win.close();
          return;
        }
        openedWindow = win;
        win.document.title = "Exporting…";

        for (const node of Array.from(
          document.head.querySelectorAll("style, link[rel='stylesheet']"),
        )) {
          win.document.head.appendChild(node.cloneNode(true));
        }

        win.document.body.style.margin = "0";
        win.document.body.style.backgroundColor = "#1a1a1a";

        const container = win.document.createElement("div");
        win.document.body.appendChild(container);

        const cache = createCache({
          key: "pip",
          container: win.document.head,
        });

        win.addEventListener("pagehide", () => {
          setPip((current) => (current?.win === win ? null : current));
        });

        setPip({ win, container, cache });
      } catch (err) {
        console.error("Failed to open Document Picture-in-Picture", err);
      }
    })();

    return () => {
      cancelled = true;
      if (openedWindow) openedWindow.close();
      setPip(null);
    };
  }, [exportInProgress]);

  if (dialogView === "choose") {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth="xs"
        fullWidth
        PaperProps={{ sx: { bgcolor: "#1a1a1a", color: "#eee" } }}
      >
        <DialogTitle>Extract</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <ButtonBase sx={optionButtonSx} onClick={onExtractFrame}>
              <CameraAltIcon fontSize="medium" />
              <Typography variant="body2" fontWeight={600}>
                Extract Frame
              </Typography>
              <Typography variant="caption" sx={{ color: "#888" }}>
                Save a single frame as an image asset
              </Typography>
            </ButtonBase>

            <ButtonBase sx={optionButtonSx} onClick={onExtractSelection}>
              <ContentCutIcon fontSize="medium" />
              <Typography variant="body2" fontWeight={600}>
                Extract Selection
              </Typography>
              <Typography variant="caption" sx={{ color: "#888" }}>
                Select a range on the timeline to extract as video
              </Typography>
            </ButtonBase>

            <ButtonBase sx={optionButtonSx} onClick={() => onSetView("export")}>
              <FileDownloadIcon fontSize="medium" />
              <Typography variant="body2" fontWeight={600}>
                Export
              </Typography>
              <Typography variant="caption" sx={{ color: "#888" }}>
                Download the full timeline as MP4
              </Typography>
            </ButtonBase>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} color="inherit" size="small">
            Cancel
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  if (dialogView === "export") {
    return (
      <>
        <Dialog
          open={open}
          onClose={isProcessing ? undefined : onClose}
          maxWidth="xs"
          fullWidth
          PaperProps={{ sx: { bgcolor: "#1a1a1a", color: "#eee" } }}
        >
          <DialogTitle>Export Project</DialogTitle>
          <DialogContent>
            <Stack spacing={3} sx={{ mt: 1 }}>
              {!isProcessing ? (
                <FormControl fullWidth size="small">
                  <InputLabel id="export-resolution-label">Resolution</InputLabel>
                  <Select
                    labelId="export-resolution-label"
                    value={resolution}
                    label="Resolution"
                    onChange={(e) => setResolution(Number(e.target.value))}
                  >
                    <MenuItem value={480}>480p (SD)</MenuItem>
                    <MenuItem value={720}>720p (HD)</MenuItem>
                    <MenuItem value={1080}>1080p (FHD)</MenuItem>
                    <MenuItem value={2160}>4K (UHD)</MenuItem>
                  </Select>
                </FormControl>
              ) : (
                <Box sx={{ width: "100%", mt: 2 }}>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Rendering... {Math.round(progress)}%
                  </Typography>
                  <LinearProgress variant="determinate" value={progress} />
                </Box>
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            {!isProcessing ? (
              <>
                <Button
                  onClick={() => onSetView("choose")}
                  color="inherit"
                  size="small"
                >
                  Back
                </Button>
                <Button
                  onClick={() => onExport(resolution)}
                  variant="contained"
                  color="primary"
                  size="small"
                >
                  Export
                </Button>
              </>
            ) : (
              <Button onClick={handleCancelProcessing} color="error" size="small">
                Cancel
              </Button>
            )}
          </DialogActions>
        </Dialog>
        {pip &&
          createPortal(
            <CacheProvider value={pip.cache}>
              <ExportProgressPip progress={progress} />
            </CacheProvider>,
            pip.container,
          )}
      </>
    );
  }

  if (dialogView === "extracting-frame") {
    return (
      <Dialog
        open={open}
        maxWidth="xs"
        fullWidth
        PaperProps={{ sx: { bgcolor: "#1a1a1a", color: "#eee" } }}
      >
        <DialogContent>
          <Stack spacing={2} alignItems="center" sx={{ py: 2 }}>
            <Typography variant="body1">Extracting frame...</Typography>
          </Stack>
        </DialogContent>
      </Dialog>
    );
  }

  // extracting-selection
  return (
    <Dialog
      open={open}
      maxWidth="xs"
      fullWidth
      PaperProps={{ sx: { bgcolor: "#1a1a1a", color: "#eee" } }}
    >
      <DialogTitle>Extracting Selection</DialogTitle>
      <DialogContent>
        <Box sx={{ width: "100%", mt: 2 }}>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            Rendering... {Math.round(progress)}%
          </Typography>
          <LinearProgress variant="determinate" value={progress} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleCancelProcessing} color="error" size="small">
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}
