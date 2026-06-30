import {
  useCallback,
  useSyncExternalStore,
  type ComponentType,
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
} from "./ExtensionEntityProviderRegistry";
import { ExtensionTrustedReactMount } from "../ui/ExtensionTrustedReactMount";

function failedUpdate(message: string): ExtensionTimelineTransactionResult {
  return {
    ok: false,
    code: "incompatible_payload",
    message,
    label: "Update extension entity",
  };
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
  const Inspector = provider.definition.inspector as ComponentType<
    ExtensionEntityInspectorProps
  >;

  return (
    <Box
      data-testid={`extension-entity-inspector-${provider.id}`}
      sx={{ px: 1, pt: 1 }}
    >
      <ExtensionTrustedReactMount
        contributionId={provider.id}
        surface="Entity inspector"
        report={provider.definition.report}
        component={Inspector}
        componentProps={inspectorProps}
        fallback={
          <Alert severity="error">Extension property UI failed to render.</Alert>
        }
      />
    </Box>
  );
}
