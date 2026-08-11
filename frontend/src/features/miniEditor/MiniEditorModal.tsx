import { useCallback } from "react";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
} from "@mui/material";
import {
  MiniEditorActions,
  MiniEditorControls,
  MiniEditorPreview,
} from "./MiniEditorContent";
import { useMiniEditorStore } from "./useMiniEditorStore";

/** Legacy presentation retained while the dedicated-workspace canary proves parity. */
export function MiniEditorModal() {
  const isOpen = useMiniEditorStore((state) => state.isOpen);
  const presentation = useMiniEditorStore((state) => state.presentation);
  const title = useMiniEditorStore((state) => state.title);
  const status = useMiniEditorStore((state) => state.status);
  const extractionMode = useMiniEditorStore((state) => state.extractionMode);
  const close = useMiniEditorStore((state) => state.close);
  const cancelExtractionSelection = useMiniEditorStore(
    (state) => state.cancelExtractionSelection,
  );
  const isBusy =
    status === "saving" ||
    status === "extracting-range" ||
    status === "extracting-frame";

  const handleClose = useCallback(() => {
    if (isBusy) return;
    if (extractionMode !== null) {
      cancelExtractionSelection();
      return;
    }
    close();
  }, [cancelExtractionSelection, close, extractionMode, isBusy]);

  return (
    <Dialog
      open={isOpen && presentation === "modal"}
      onClose={handleClose}
      maxWidth="md"
      fullWidth
      PaperProps={{ sx: { bgcolor: "#161618", color: "#eee" } }}
    >
      <DialogTitle sx={{ pb: 1 }}>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <MiniEditorPreview />
          <MiniEditorControls />
        </Stack>
      </DialogContent>
      <DialogActions>
        <MiniEditorActions onRequestClose={handleClose} />
      </DialogActions>
    </Dialog>
  );
}
