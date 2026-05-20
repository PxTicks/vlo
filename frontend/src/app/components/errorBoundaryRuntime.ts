import type { ErrorInfo } from "react";

export const errorBoundaryActions = {
  reloadApp(): void {
    window.location.reload();
  },
};

export function reportBoundaryError(
  error: Error,
  info: ErrorInfo,
  boundaryName: string,
): void {
  console.error("[ErrorBoundary] Caught render error", {
    boundaryName,
    error,
    componentStack: info.componentStack,
  });
}
