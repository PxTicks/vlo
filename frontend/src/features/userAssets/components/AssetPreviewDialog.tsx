import { useEffect } from "react";
import CloseIcon from "@mui/icons-material/Close";
import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
} from "@mui/material";
import type { Asset } from "../../../types/Asset";

interface AssetPreviewDialogProps {
  asset: Asset;
  open: boolean;
  onClose: () => void;
}

export function AssetPreviewDialog({
  asset,
  open,
  onClose,
}: AssetPreviewDialogProps) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handleWindowBlur() {
      onClose();
    }

    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [onClose, open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{
        sx: {
          bgcolor: "#050505",
          color: "white",
          overflow: "hidden",
        },
      }}
    >
      <DialogTitle sx={{ pr: 7, fontSize: "0.95rem" }}>{asset.name}</DialogTitle>
      <IconButton
        aria-label="Close preview"
        onClick={onClose}
        sx={{
          position: "absolute",
          top: 8,
          right: 8,
          color: "white",
          zIndex: 1,
        }}
      >
        <CloseIcon />
      </IconButton>
      <DialogContent sx={{ p: 0, bgcolor: "#000" }}>
        <Box
          component="video"
          src={asset.proxySrc ?? asset.src}
          autoPlay
          controls
          playsInline
          aria-label={`${asset.name} preview`}
          sx={{
            display: "block",
            width: "100%",
            maxHeight: "75vh",
            backgroundColor: "#000",
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
