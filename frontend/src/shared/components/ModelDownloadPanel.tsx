import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Link,
  LinearProgress,
  TextField,
  Typography,
} from "@mui/material";
import {
  Check,
  Close,
  OpenInNew,
  Visibility,
  VisibilityOff,
  VpnKey,
} from "@mui/icons-material";
import type { DownloadableModel } from "../../services/downloadApi";
import type {
  ActiveModelDownload,
  DownloadContext,
} from "../hooks/useModelDownloadController";

const HF_TOKEN_STORAGE_KEY = "vlo:hf-access-token";
const HF_TOKEN_PAGE_URL = "https://huggingface.co/settings/tokens";

interface ModelDownloadPanelProps {
  icon?: ReactNode;
  title: string;
  description: string;
  models: DownloadableModel[];
  loading: boolean;
  loadingLabel: string;
  error: string | null;
  activeDownload: ActiveModelDownload | null;
  beforeModels?: ReactNode;
  emptyState?: ReactNode;
  onDownload: (modelKey: string, context?: DownloadContext) => void;
  onCancel: () => void;
  variant?: "card" | "plain";
  fillHeight?: boolean;
}

const cardSx = {
  p: 1.5,
  borderRadius: 1,
  border: "1px solid #3a3d44",
  bgcolor: "#2a2d33",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function loadStoredHfToken(): string {
  try {
    return globalThis.localStorage?.getItem(HF_TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function ModelDownloadPanel({
  icon,
  title,
  description,
  models,
  loading,
  loadingLabel,
  error,
  activeDownload,
  beforeModels,
  emptyState,
  onDownload,
  onCancel,
  variant = "card",
  fillHeight = false,
}: ModelDownloadPanelProps) {
  const hasGatedModels = models.some((model) => model.gated);
  const [hfToken, setHfToken] = useState<string>("");
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    if (hasGatedModels) {
      setHfToken(loadStoredHfToken());
    }
  }, [hasGatedModels]);

  const handleTokenChange = useCallback((value: string) => {
    setHfToken(value);
    try {
      const trimmed = value.trim();
      if (trimmed) {
        globalThis.localStorage?.setItem(HF_TOKEN_STORAGE_KEY, trimmed);
      } else {
        globalThis.localStorage?.removeItem(HF_TOKEN_STORAGE_KEY);
      }
    } catch {
      // ignore storage failures (private mode, etc.)
    }
  }, []);

  const trimmedToken = hfToken.trim();

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        width: "100%",
        flex: fillHeight ? 1 : undefined,
        px: 2,
        py: variant === "card" ? 3 : 2,
        gap: 2,
        textAlign: "center",
        borderRadius: variant === "card" ? 1 : 0,
        border: variant === "card" ? "1px solid #3a3d44" : "none",
        bgcolor: variant === "card" ? "#1f2126" : "transparent",
      }}
    >
      {icon ?? null}
      <Typography variant="subtitle2" sx={{ color: "text.primary" }}>
        {title}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          lineHeight: 1.5,
          overflowWrap: "anywhere",
          wordBreak: "break-word",
        }}
      >
        {description}
      </Typography>

      {error ? (
        <Typography variant="caption" sx={{ color: "error.main" }}>
          {error}
        </Typography>
      ) : null}

      {beforeModels ? <Box sx={{ width: "100%" }}>{beforeModels}</Box> : null}

      {hasGatedModels && !loading ? (
        <Box
          sx={{
            width: "100%",
            p: 1.5,
            borderRadius: 1,
            border: "1px solid #4a432a",
            bgcolor: "#2a2620",
            display: "flex",
            flexDirection: "column",
            gap: 1,
            textAlign: "left",
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
            <VpnKey sx={{ fontSize: 16, color: "warning.light" }} />
            <Typography variant="caption" sx={{ color: "warning.light", fontWeight: 600 }}>
              HuggingFace access token required
            </Typography>
          </Box>
          <Typography variant="caption" sx={{ color: "text.secondary", lineHeight: 1.5 }}>
            Some FLUX models are gated. Open each gated model's repository
            below to accept the license, create a read-scoped token at{" "}
            <Link
              href={HF_TOKEN_PAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
              sx={{ color: "primary.light" }}
            >
              huggingface.co/settings/tokens
            </Link>
            , then paste it here.
          </Typography>
          <TextField
            value={hfToken}
            onChange={(event) => handleTokenChange(event.target.value)}
            placeholder="hf_..."
            size="small"
            type={showToken ? "text" : "password"}
            autoComplete="off"
            fullWidth
            InputProps={{
              sx: { fontFamily: "monospace", fontSize: "0.75rem" },
              endAdornment: (
                <IconButton
                  size="small"
                  onClick={() => setShowToken((prev) => !prev)}
                  edge="end"
                  sx={{ color: "text.secondary" }}
                  aria-label={showToken ? "Hide token" : "Show token"}
                >
                  {showToken ? (
                    <VisibilityOff sx={{ fontSize: 16 }} />
                  ) : (
                    <Visibility sx={{ fontSize: 16 }} />
                  )}
                </IconButton>
              ),
            }}
          />
          <Typography variant="caption" sx={{ color: "text.disabled", fontSize: "0.65rem" }}>
            Saved locally in this browser for convenience.
          </Typography>
        </Box>
      ) : null}

      {loading ? (
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 1,
            width: "100%",
            py: 1,
          }}
        >
          <CircularProgress size={20} />
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {loadingLabel}
          </Typography>
        </Box>
      ) : models.length > 0 ? (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, width: "100%" }}>
          {models.map((model) => {
            const isDownloading = activeDownload?.modelKey === model.key;
            const progress = isDownloading ? activeDownload.progress : null;
            const pct =
              progress?.progress.overallBytesTotal &&
              progress.progress.overallBytesTotal > 0
                ? Math.round(
                    (progress.progress.overallBytes / progress.progress.overallBytesTotal) * 100,
                  )
                : null;

            return (
              <Box key={model.key} sx={cardSx}>
                <Box
                  sx={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    mb: 0.5,
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      textAlign: "left",
                      fontWeight: 600,
                      color: "text.primary",
                      overflowWrap: "anywhere",
                      wordBreak: "break-word",
                    }}
                  >
                    {model.label}
                  </Typography>
                  {model.installed ? (
                    <Check sx={{ fontSize: 16, color: "success.main" }} />
                  ) : null}
                </Box>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    display: "block",
                    mb: 1,
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                  }}
                >
                  {model.description}
                </Typography>

                {model.gated && model.gatedRepoUrl ? (
                  <Button
                    variant="text"
                    size="small"
                    href={model.gatedRepoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    startIcon={<OpenInNew sx={{ fontSize: 14 }} />}
                    sx={{
                      textTransform: "none",
                      justifyContent: "flex-start",
                      px: 0,
                      mb: 0.5,
                      color: "primary.light",
                      fontSize: "0.7rem",
                    }}
                  >
                    Accept license on HuggingFace
                  </Button>
                ) : null}

                {model.installed ? (
                  <Typography variant="caption" sx={{ color: "success.main" }}>
                    Installed
                  </Typography>
                ) : isDownloading ? (
                  <Box>
                    <LinearProgress
                      variant={pct !== null ? "determinate" : "indeterminate"}
                      value={pct ?? undefined}
                      sx={{ mb: 0.5, borderRadius: 1 }}
                    />
                    <Box
                      sx={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        {progress?.progress.overallBytes != null
                          ? formatBytes(progress.progress.overallBytes)
                          : "Starting..."}
                        {progress?.progress.overallBytesTotal != null
                          ? ` / ${formatBytes(progress.progress.overallBytesTotal)}`
                          : ""}
                        {pct !== null ? ` (${pct}%)` : ""}
                      </Typography>
                      <Button
                        size="small"
                        color="error"
                        onClick={() => void onCancel()}
                        sx={{ minWidth: 0, p: 0.5, textTransform: "none" }}
                      >
                        <Close sx={{ fontSize: 14 }} />
                      </Button>
                    </Box>
                  </Box>
                ) : (
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() =>
                      void onDownload(
                        model.key,
                        model.gated ? { hfToken: trimmedToken } : undefined,
                      )
                    }
                    disabled={
                      activeDownload !== null ||
                      (model.gated === true && trimmedToken.length === 0)
                    }
                    sx={{ textTransform: "none", width: "100%" }}
                  >
                    {model.gated && trimmedToken.length === 0
                      ? "Enter token to download"
                      : "Download"}
                  </Button>
                )}
              </Box>
            );
          })}
        </Box>
      ) : (
        emptyState ?? null
      )}
    </Box>
  );
}
