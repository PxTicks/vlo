import {
  Component,
  useCallback,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Alert, Box } from "@mui/material";
import type { ExtensionTimelineClip } from "../../../types/TimelineTypes";
import { commitExtensionTimelineTransaction } from "../../timeline/api";
import type {
  ExtensionEntityInspectorProps,
  ExtensionTimelineTransactionResult,
  JsonValue,
} from "../types";
import { extensionPayloadProviderRegistry } from "../persistence/ExtensionPayloadProviderRegistry";
import {
  extensionEntityProviderRegistry,
  type RegisteredExtensionEntityProvider,
} from "./ExtensionEntityProviderRegistry";

interface InspectorBoundaryProps {
  readonly provider: RegisteredExtensionEntityProvider;
  readonly children: ReactNode;
}

interface InspectorBoundaryState {
  readonly failed: boolean;
}

class InspectorBoundary extends Component<
  InspectorBoundaryProps,
  InspectorBoundaryState
> {
  state: InspectorBoundaryState = { failed: false };

  static getDerivedStateFromError(): InspectorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.provider.definition.report(
      "error",
      `Entity inspector '${this.props.provider.id}' failed to render.`,
      { error, componentStack: info.componentStack },
    );
  }

  render(): ReactNode {
    return this.state.failed ? (
      <Alert severity="error">Extension property UI failed to render.</Alert>
    ) : (
      this.props.children
    );
  }
}

function failedUpdate(message: string): ExtensionTimelineTransactionResult {
  return {
    ok: false,
    code: "incompatible_payload",
    message,
    label: "Update extension entity",
  };
}

interface TrustedInspectorProps {
  readonly provider: RegisteredExtensionEntityProvider;
  readonly props: ExtensionEntityInspectorProps;
}

function TrustedInspector({ provider, props }: TrustedInspectorProps) {
  const Inspector = provider.definition.inspector as (
    props: ExtensionEntityInspectorProps,
  ) => ReactNode;
  return <Inspector {...props} />;
}

export interface ExtensionEntityInspectorPropsInternal {
  readonly clip: ExtensionTimelineClip;
}

export function ExtensionEntityInspector({
  clip,
}: ExtensionEntityInspectorPropsInternal) {
  useSyncExternalStore(
    (listener) => extensionEntityProviderRegistry.subscribe(listener),
    () => extensionEntityProviderRegistry.getRevision(),
    () => extensionEntityProviderRegistry.getRevision(),
  );
  const provider = extensionEntityProviderRegistry.get(clip.extensionPayload);
  const resolution = extensionPayloadProviderRegistry.resolve(
    clip.extensionPayload,
  );
  const updateData = useCallback(
    (data: JsonValue): ExtensionTimelineTransactionResult => {
      const assetResolution =
        extensionPayloadProviderRegistry.resolveAssetReferences({
          ...clip.extensionPayload,
          data: structuredClone(data),
        });
      if (!assetResolution.ok) {
        return failedUpdate(assetResolution.resolution.error.message);
      }
      return commitExtensionTimelineTransaction(
        `Update ${provider?.definition.label ?? "extension entity"}`,
        clip.extensionPayload.extensionId,
        [
          {
            kind: "update_payload",
            entityId: clip.id,
            payload: assetResolution.payload,
          },
        ],
      );
    },
    [clip.extensionPayload, clip.id, provider?.definition.label],
  );

  if (
    !provider?.definition.inspector ||
    (resolution.status !== "current" && resolution.status !== "migrated")
  ) {
    return null;
  }

  const inspectorProps: ExtensionEntityInspectorProps = {
    entity: Object.freeze({
      id: clip.id,
      name: clip.name,
      trackId: clip.trackId,
      startTicks: clip.start,
      durationTicks: clip.timelineDuration,
    }),
    data: structuredClone(resolution.payload.data),
    schemaVersion: resolution.payload.schemaVersion,
    updateData,
  };

  return (
    <Box
      data-testid={`extension-entity-inspector-${provider.id}`}
      sx={{ px: 1, pt: 1 }}
    >
      <InspectorBoundary provider={provider}>
        <TrustedInspector provider={provider} props={inspectorProps} />
      </InspectorBoundary>
    </Box>
  );
}
