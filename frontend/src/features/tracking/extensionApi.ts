import type {
  ExtensionApiScope,
  ExtensionAssetApi,
  ExtensionResource,
  ExtensionTimelineApi,
} from "../extensions/types";
import { createExtensionAssetApi } from "../extensions/assets/createExtensionAssetApi";
import { createExtensionTimelineApi } from "../extensions/timeline/createExtensionTimelineApi";

export const NATIVE_TRACKING_EXTENSION_ID = "vlo.core.tracking";

export interface NativeTrackingExtensionApis {
  timeline: ExtensionTimelineApi;
  assets: ExtensionAssetApi;
}

export function createNativeTrackingExtensionApis(): NativeTrackingExtensionApis {
  const scope: ExtensionApiScope = {
    extension: {
      id: NATIVE_TRACKING_EXTENSION_ID,
      version: "1.0.0",
    },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: () => undefined,
  };

  return Object.freeze({
    timeline: createExtensionTimelineApi(scope),
    assets: createExtensionAssetApi(scope),
  });
}
