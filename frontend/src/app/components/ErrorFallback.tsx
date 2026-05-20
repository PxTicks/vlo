import { Box, Button, Typography } from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import type { ErrorBoundaryVariant } from "./ErrorBoundary";

interface ErrorFallbackProps {
  readonly boundaryName: string;
  readonly error: Error;
  readonly variant: ErrorBoundaryVariant;
  readonly onRetry: () => void;
  readonly onReload: () => void;
}

function getFallbackTitle(variant: ErrorBoundaryVariant): string {
  return variant === "screen" ? "Something went wrong" : "This area crashed";
}

function getFallbackMessage(
  boundaryName: string,
  variant: ErrorBoundaryVariant,
): string {
  return variant === "screen"
    ? "The app hit an unexpected rendering error."
    : `${boundaryName} hit an unexpected rendering error.`;
}

export function ErrorFallback({
  boundaryName,
  error,
  variant,
  onRetry,
  onReload,
}: ErrorFallbackProps) {
  const isScreen = variant === "screen";
  const isRegion = variant === "region";

  return (
    <Box
      role="alert"
      sx={{
        height: isScreen ? "100vh" : "100%",
        minHeight: isRegion ? 160 : undefined,
        width: "100%",
        bgcolor: isScreen ? "background.default" : "rgba(18, 18, 18, 0.96)",
        color: "text.primary",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 1.5,
        p: isScreen ? 4 : 2,
        textAlign: "center",
      }}
    >
      <Typography variant={isScreen ? "h5" : "subtitle1"}>
        {getFallbackTitle(variant)}
      </Typography>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ maxWidth: isScreen ? 520 : 360 }}
      >
        {getFallbackMessage(boundaryName, variant)}
      </Typography>
      <Typography
        variant="caption"
        color="text.disabled"
        sx={{
          maxWidth: isScreen ? 520 : 360,
          overflowWrap: "anywhere",
        }}
      >
        {error.message}
      </Typography>
      <Box
        sx={{
          display: "flex",
          gap: 1,
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        <Button
          variant="contained"
          size={isScreen ? "medium" : "small"}
          startIcon={<RestartAltIcon />}
          onClick={onRetry}
        >
          Try again
        </Button>
        <Button
          variant="outlined"
          size={isScreen ? "medium" : "small"}
          startIcon={<RefreshIcon />}
          onClick={onReload}
        >
          Reload app
        </Button>
      </Box>
    </Box>
  );
}
