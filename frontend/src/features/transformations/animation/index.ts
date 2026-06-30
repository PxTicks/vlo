export {
  CORE_CATMULL_ROM_PATH_ID,
  CORE_MONOTONE_INTERPOLATION_ID,
  ExtensionInterpolationRegistry,
  ExtensionScalarSourceRegistry,
  ExtensionSpatialPathRegistry,
  createExtensionAnimationApi,
  extensionInterpolationRegistry,
  extensionScalarSourceRegistry,
  extensionSpatialPathRegistry,
} from "./ExtensionAnimationRegistry";
export type {
  RegisteredInterpolation,
  RegisteredScalarSource,
  RegisteredSpatialPath,
  ResolvedAnimationPayload,
} from "./ExtensionAnimationRegistry";
export { TrustedSpatialPathOverlayRenderer } from "./TrustedSpatialPathOverlayRenderer";
