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
} from "@mui/material";

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  onExport: (resolution: number) => void;
  isExporting: boolean;
  progress: number;
}

export function ExportDialog({
  open,
  onClose,
  onExport,
  isExporting,
  progress,
}: ExportDialogProps) {
  const [resolution, setResolution] = useState(1080);

  const handleExport = () => {
    onExport(resolution);
  };

  return (
    <Dialog open={open} onClose={isExporting ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Export Project</DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ mt: 1 }}>
          {!isExporting ? (
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
             <Box sx={{ width: '100%', mt: 2 }}>
                <Typography variant="body2" color="text.secondary" gutterBottom>
                    Rendering... {Math.round(progress)}%
                </Typography>
                <LinearProgress variant="determinate" value={progress} />
             </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        {!isExporting ? (
            <>
                <Button onClick={onClose} color="inherit">
                Cancel
                </Button>
                <Button onClick={handleExport} variant="contained" color="primary">
                Export
                </Button>
            </>
        ) : (
            <Button onClick={onClose} color="error">
                Cancel
            </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
