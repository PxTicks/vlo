import {
  useSyncExternalStore,
  type ComponentType,
} from "react";
import { Alert, Box, Button } from "@mui/material";
import { ArrowBack } from "@mui/icons-material";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import type {
  ExtensionSpatialPathEditorProps,
  ExtensionSpatialPathParameter,
} from "../../extensions/types";
import { extensionSpatialPathRegistry } from "../animation";
import { ExtensionTrustedReactMount } from "../../extensions/ui/ExtensionTrustedReactMount";

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
    | ComponentType<ExtensionSpatialPathEditorProps>
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
        <ExtensionTrustedReactMount
          contributionId={contribution.id}
          surface="Extension spatial-path editor"
          report={contribution.definition.report}
          component={Editor}
          componentProps={{
            value: path,
            domain: { minTime: 0, duration },
            currentTime,
            onChange,
          }}
        />
      )}

      <Button variant="outlined" color="error" onClick={onRemove}>
        Remove Path
      </Button>
    </Box>
  );
}
