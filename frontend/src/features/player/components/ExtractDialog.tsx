import { useState } from "react";
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
} from "@mui/material";
import CameraAltIcon from "@mui/icons-material/CameraAlt";
import ContentCutIcon from "@mui/icons-material/ContentCut";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import type { DialogView } from "../useExtractStore";

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
  const handleCancelProcessing = onCancelProcessing ?? onClose;

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
