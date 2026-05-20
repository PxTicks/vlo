import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorFallback } from "./ErrorFallback";
import {
  errorBoundaryActions,
  reportBoundaryError,
} from "./errorBoundaryRuntime";

export type ErrorBoundaryVariant = "screen" | "region" | "panel";

interface ErrorBoundaryProps {
  readonly boundaryName: string;
  readonly children: ReactNode;
  readonly variant?: ErrorBoundaryVariant;
  readonly resetKeys?: readonly unknown[];
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

function areResetKeysEqual(
  previousKeys: readonly unknown[] | undefined,
  nextKeys: readonly unknown[] | undefined,
): boolean {
  if (previousKeys === nextKeys) {
    return true;
  }
  if (!previousKeys || !nextKeys) {
    return false;
  }
  if (previousKeys.length !== nextKeys.length) {
    return false;
  }

  return previousKeys.every((key, index) => Object.is(key, nextKeys[index]));
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportBoundaryError(error, info, this.props.boundaryName);
  }

  override componentDidUpdate(previousProps: ErrorBoundaryProps): void {
    if (
      this.state.error &&
      !areResetKeysEqual(previousProps.resetKeys, this.props.resetKeys)
    ) {
      this.setState({ error: null });
    }
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    errorBoundaryActions.reloadApp();
  };

  override render() {
    const { boundaryName, children, variant = "region" } = this.props;
    const { error } = this.state;

    if (error) {
      return (
        <ErrorFallback
          boundaryName={boundaryName}
          error={error}
          variant={variant}
          onRetry={this.handleRetry}
          onReload={this.handleReload}
        />
      );
    }

    return children;
  }
}
