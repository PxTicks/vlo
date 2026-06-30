import {
  Component,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Alert } from "@mui/material";
import type { ExtensionApiScope } from "../types";

interface ExtensionTrustedReactBoundaryProps {
  readonly contributionId: string;
  readonly surface: string;
  readonly report: ExtensionApiScope["report"];
  readonly fallback?: ReactNode;
  readonly children: ReactNode;
}

interface ExtensionTrustedReactBoundaryState {
  readonly failed: boolean;
}

class ExtensionTrustedReactBoundary extends Component<
  ExtensionTrustedReactBoundaryProps,
  ExtensionTrustedReactBoundaryState
> {
  state: ExtensionTrustedReactBoundaryState = { failed: false };

  static getDerivedStateFromError(): ExtensionTrustedReactBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.report(
      "error",
      `${this.props.surface} '${this.props.contributionId}' failed to render.`,
      { error, componentStack: info.componentStack },
    );
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      this.props.fallback ?? (
        <Alert severity="error">Extension UI failed to render.</Alert>
      )
    );
  }
}

export interface ExtensionTrustedReactMountProps<TProps extends object> {
  readonly contributionId: string;
  readonly surface: string;
  readonly report: ExtensionApiScope["report"];
  readonly component: ComponentType<TProps>;
  readonly componentProps: TProps;
  readonly fallback?: ReactNode;
}

/** One host-owned lifecycle/error boundary for every trusted React surface. */
export function ExtensionTrustedReactMount<TProps extends object>({
  contributionId,
  surface,
  report,
  component: TrustedComponent,
  componentProps,
  fallback,
}: ExtensionTrustedReactMountProps<TProps>) {
  return (
    <ExtensionTrustedReactBoundary
      contributionId={contributionId}
      surface={surface}
      report={report}
      fallback={fallback}
    >
      <TrustedComponent {...componentProps} />
    </ExtensionTrustedReactBoundary>
  );
}
