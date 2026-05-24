import { useCallback, useEffect } from "react";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CloseIcon from "@mui/icons-material/Close";
import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography,
} from "@mui/material";
import type { Asset } from "../../../types/Asset";
import { useAssetSourceUrl } from "../publicApi";

interface AssetPreviewDialogProps {
  asset: Asset;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

export function AssetPreviewDialog({
  asset,
  onClose,
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
}: AssetPreviewDialogProps) {
  const sourceUrl = useAssetSourceUrl(asset.id, true);

  useEffect(() => {
    function handleWindowBlur() {
      onClose();
    }

    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [onClose]);

  const handlePrev = useCallback(() => {
    if (hasPrev && onPrev) {
      onPrev();
    }
  }, [hasPrev, onPrev]);

  const handleNext = useCallback(() => {
    if (hasNext && onNext) {
      onNext();
    }
  }, [hasNext, onNext]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      if (event.key === "ArrowLeft" && hasPrev && onPrev) {
        event.preventDefault();
        onPrev();
      } else if (event.key === "ArrowRight" && hasNext && onNext) {
        event.preventDefault();
        onNext();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasPrev, hasNext, onPrev, onNext]);

  const showNav = Boolean(onPrev || onNext);

  return (
    <Dialog
      open
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
          zIndex: 2,
        }}
      >
        <CloseIcon />
      </IconButton>
      <DialogContent
        sx={{ p: 0, bgcolor: "#000", position: "relative" }}
      >
        {sourceUrl ? (
          asset.type === "video" ? (
            <Box
              key={asset.id}
              component="video"
              src={sourceUrl}
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
          ) : (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "100%",
                maxHeight: "75vh",
                backgroundColor: "#000",
              }}
            >
              <Box
                key={asset.id}
                component="img"
                src={sourceUrl}
                alt={asset.name}
                aria-label={`${asset.name} preview`}
                sx={{
                  display: "block",
                  maxWidth: "100%",
                  maxHeight: "75vh",
                  objectFit: "contain",
                }}
              />
            </Box>
          )
        ) : (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 280,
              color: "#9aa0a6",
            }}
          >
            <Typography variant="body2">Loading preview...</Typography>
          </Box>
        )}

        {showNav ? (
          <>
            <IconButton
              aria-label="Previous asset"
              onClick={handlePrev}
              disabled={!hasPrev}
              sx={{
                position: "absolute",
                top: "50%",
                left: 8,
                transform: "translateY(-50%)",
                color: "white",
                bgcolor: "rgba(0, 0, 0, 0.45)",
                "&:hover": { bgcolor: "rgba(0, 0, 0, 0.7)" },
                "&.Mui-disabled": { color: "rgba(255, 255, 255, 0.25)" },
                zIndex: 2,
              }}
            >
              <ChevronLeftIcon />
            </IconButton>
            <IconButton
              aria-label="Next asset"
              onClick={handleNext}
              disabled={!hasNext}
              sx={{
                position: "absolute",
                top: "50%",
                right: 8,
                transform: "translateY(-50%)",
                color: "white",
                bgcolor: "rgba(0, 0, 0, 0.45)",
                "&:hover": { bgcolor: "rgba(0, 0, 0, 0.7)" },
                "&.Mui-disabled": { color: "rgba(255, 255, 255, 0.25)" },
                zIndex: 2,
              }}
            >
              <ChevronRightIcon />
            </IconButton>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
