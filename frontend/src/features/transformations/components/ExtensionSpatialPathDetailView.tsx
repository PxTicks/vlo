import {
  Component,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Alert, Box, Button } from "@mui/material";
import { ArrowBack } from "@mui/icons-material";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import type {
  ExtensionSpatialPathEditorProps,
  ExtensionSpatialPathParameter,
} from "../../extensions/types";
import { extensionSpatialPathRegistry } from "../animation";

interface ExtensionPathEditorBoundaryProps {
  readonly contributionId: string;
  readonly report: (
    level: "error",
    message: string,
    detail?: unknown,
  ) => void;
  readonly children: ReactNode;
}

interface ExtensionPathEditorBoundaryState {
  readonly failed: boolean;
}

class ExtensionPathEditorBoundary extends Component<
  ExtensionPathEditorBoundaryProps,
  ExtensionPathEditorBoundaryState
> {
  state: ExtensionPathEditorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ExtensionPathEditorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.report(
      "error",
      `Extension spatial-path editor '${this.props.contributionId}' failed to render.`,
      { error, componentStack: info.componentStack },
    );
  }

  render(): ReactNode {
    return this.state.failed ? (
      <Alert severity="error">The extension path editor failed.</Alert>
    ) : (
      this.props.children
    );
  }
}

export interface ExtensionSpatialPathDetailViewProps {
  readonly path: ExtensionSpatialPathParameter;
  readonly duration: number;
  readonly onChange: (path: ExtensionSpatialPathParameter) => void;
  readonly onBack: () => void;
  readonly onRemove: () => void;
}

export function ExtensionSpatialPathDetailView({
  path,
  duration,
  onChange,
  onBack,
  onRemove,
}: ExtensionSpatialPathDetailViewProps) {
  const currentTime = useSyncExternalStore(
    (listener) => playbackClock.subscribe(listener),
    () => playbackClock.time,
    () => playbackClock.time,
  );
  const contribution = extensionSpatialPathRegistry.get(path.geometry);
  const Editor = contribution?.definition.editor as
    | ((props: ExtensionSpatialPathEditorProps) => ReactNode)
    | undefined;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2, p: 2 }}>
      <Button
        size="small"
        startIcon={<ArrowBack fontSize="small" />}
        onClick={onBack}
        sx={{ alignSelf: "flex-start", textTransform: "none" }}
      >
        Back To Transform
      </Button>

      {!contribution || !Editor ? (
        <Alert severity="warning">
          This spatial-path provider is missing or does not provide an editor.
        </Alert>
      ) : (
        <ExtensionPathEditorBoundary
          contributionId={contribution.id}
          report={contribution.definition.report}
        >
          <Editor
            value={path}
            domain={{ minTime: 0, duration }}
            currentTime={currentTime}
            onChange={onChange}
          />
        </ExtensionPathEditorBoundary>
      )}

      <Button variant="outlined" color="error" onClick={onRemove}>
        Remove Path
      </Button>
    </Box>
  );
}
