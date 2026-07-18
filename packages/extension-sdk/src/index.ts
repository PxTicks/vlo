/**
 * Contribution metadata reserved for the trusted/restricted dispatch split.
 * SDK 1 records this value but does not enforce isolation.
 */
export type ExtensionExecutionMode = "trusted" | "restricted";

export type ExtensionLifecycleResult = void | ExtensionResource;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Opaque, versioned data owned by one extension contribution. */
export interface ExtensionPayload {
  extensionId: string;
  typeId: string;
  schemaVersion: number;
  data: JsonValue;
  /** Host-readable dependencies retained even when the provider is missing. */
  assetReferences?: readonly string[];
}

export interface ExtensionPayloadMigration {
  schemaVersion: number;
  data: JsonValue;
}

export interface ExtensionBackendArtifact {
  readonly artifactId: string;
  readonly role: "input" | "output";
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
}

export type ExtensionBackendJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ExtensionBackendJobReadiness {
  readonly ready: boolean;
  readonly message: string;
  readonly details?: JsonValue;
}

export interface ExtensionBackendJobType {
  readonly id: string;
  readonly label: string;
  readonly timeoutSeconds: number;
  readonly readiness: ExtensionBackendJobReadiness;
}

export interface ExtensionBackendJobDiagnostic {
  readonly level: "debug" | "info" | "warning" | "error";
  readonly message: string;
  readonly timestamp: number;
  readonly detail?: JsonValue;
}

export interface ExtensionBackendJobSnapshot {
  readonly jobId: string;
  readonly jobType: string;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly status: ExtensionBackendJobStatus;
  readonly progress: number;
  readonly message: string;
  readonly cancelRequested: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly result?: JsonValue;
  readonly error?: string;
  readonly artifacts: readonly ExtensionBackendArtifact[];
  readonly diagnostics: readonly ExtensionBackendJobDiagnostic[];
}

export interface ExtensionBackendArtifactUploadOptions {
  readonly filename: string;
  readonly contentType?: string;
  readonly signal?: AbortSignal;
}

export interface ExtensionBackendJobWaitOptions {
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly onProgress?: (snapshot: ExtensionBackendJobSnapshot) => void;
}

/** Owner-bound frontend client for one trusted extension's backend half. */
export interface ExtensionBackendApi {
  /** Raw trusted escape hatch, always relative to this extension's `/api`. */
  call(path: string, init?: RequestInit): Promise<Response>;
  listJobs(options?: { readonly signal?: AbortSignal }): Promise<
    readonly ExtensionBackendJobType[]
  >;
  uploadArtifact(
    content: Blob,
    options: ExtensionBackendArtifactUploadOptions,
  ): Promise<ExtensionBackendArtifact>;
  submitJob(
    jobType: string,
    input: JsonValue,
    artifactIds?: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<ExtensionBackendJobSnapshot>;
  getJob(
    jobId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ExtensionBackendJobSnapshot>;
  cancelJob(
    jobId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ExtensionBackendJobSnapshot>;
  waitForJob(
    jobId: string,
    options?: ExtensionBackendJobWaitOptions,
  ): Promise<ExtensionBackendJobSnapshot>;
  getArtifact(
    artifactId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Blob>;
  getArtifactUrl(artifactId: string): string;
}

/** A point in project/canvas coordinates. */
export interface ExtensionPoint2D {
  readonly x: number;
  readonly y: number;
}

/**
 * An arbitrary scalar animation source owned by an extension. Unlike a
 * keyframe interpolation strategy, a source may be procedural and need not
 * expose control points at all.
 */
export interface ExtensionScalarSourceParameter {
  readonly type: "extension-scalar";
  readonly source: ExtensionPayload;
}

/** One scalar keyframe. `outgoing` owns the following segment's mathematics. */
export interface ExtensionScalarKeyframe {
  readonly time: number;
  readonly value: number;
  readonly outgoing?: ExtensionPayload;
}

/**
 * Host-structured keyframes with extension-owned, versioned segment data.
 * Every non-final keyframe must identify an outgoing interpolation provider.
 */
export interface ExtensionKeyframedScalarParameter {
  readonly type: "extension-keyframed-scalar";
  readonly keyframes: readonly ExtensionScalarKeyframe[];
}

export type ExtensionScalarValue =
  | number
  | ExtensionScalarSourceParameter
  | ExtensionKeyframedScalarParameter;

/** Arbitrary 2D geometry plus an independently extensible progress source. */
export interface ExtensionSpatialPathParameter {
  readonly type: "extension-path2d";
  readonly geometry: ExtensionPayload;
  readonly timing: ExtensionScalarValue;
}

export interface ExtensionAnimationDataMigration {
  readonly schemaVersion: number;
  readonly data: JsonValue;
}

export interface ExtensionScalarSampleContext {
  readonly durationTicks?: number;
  readonly extrapolate: boolean;
}

/** Optional mapping needed when a scalar source is used as a speed factor. */
export interface ExtensionScalarTimeMap {
  outputToInput(outputTime: number, extrapolate: boolean): number;
  inputToOutput(inputTime: number): number;
}

export interface ExtensionCompiledScalarSource extends ExtensionDisposable {
  sample(time: number, context: ExtensionScalarSampleContext): number;
  derivative?(
    time: number,
    context: ExtensionScalarSampleContext,
  ): number;
  /** Deliberately opt-in: not every scalar function is a valid time warp. */
  readonly timeMap?: ExtensionScalarTimeMap;
}

export interface ExtensionScalarRemap {
  readonly timeScale: number;
  readonly timeOffset: number;
  readonly valueScale: number;
  readonly valueOffset: number;
}

export interface ExtensionAnimationEditorDomain {
  readonly minTime: number;
  readonly duration: number;
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly softMinValue?: number;
  readonly softMaxValue?: number;
}

export interface ExtensionScalarSourceEditorProps {
  readonly value: ExtensionScalarSourceParameter;
  readonly domain: ExtensionAnimationEditorDomain;
  readonly sample: (time: number) => number;
  /** The host wraps this callback in its normal preview/undo transaction. */
  readonly onChange: (value: ExtensionScalarSourceParameter) => void;
}

export interface ExtensionScalarSourceDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly label: string;
  readonly schemaVersion: number;
  readonly defaultData: JsonValue;
  validate(data: JsonValue, schemaVersion: number): void;
  migrate?(
    data: JsonValue,
    fromSchemaVersion: number,
  ): ExtensionAnimationDataMigration;
  compile(
    data: JsonValue,
    schemaVersion: number,
    context: Readonly<{ ticksPerSecond: number }>,
  ): ExtensionCompiledScalarSource;
  /** Required for reversal/retiming of persisted procedural source data. */
  remap?(
    data: JsonValue,
    schemaVersion: number,
    remap: ExtensionScalarRemap,
  ): ExtensionAnimationDataMigration;
  /** Arbitrary trusted React editor, isolated by a host error boundary. */
  readonly editor?: (props: ExtensionScalarSourceEditorProps) => unknown;
}

export interface ExtensionScalarSourceRegistration extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionScalarSourceApi {
  register(
    definition: ExtensionScalarSourceDefinition,
  ): ExtensionScalarSourceRegistration;
}

export interface ExtensionInterpolationCompileInput {
  readonly keyframes: readonly ExtensionScalarKeyframe[];
  readonly segmentIndex: number;
  readonly data: JsonValue;
  readonly schemaVersion: number;
}

export interface ExtensionCompiledInterpolationSegment
  extends ExtensionDisposable {
  sample(time: number): number;
  derivative?(time: number): number;
}

export interface ExtensionInterpolationEditorProps {
  readonly value: ExtensionKeyframedScalarParameter;
  readonly segmentIndex: number;
  readonly domain: ExtensionAnimationEditorDomain;
  readonly sample: (time: number) => number;
  readonly onChange: (value: ExtensionKeyframedScalarParameter) => void;
}

/** Mathematics and optional trusted UI for one keyframe segment strategy. */
export interface ExtensionInterpolationDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly label: string;
  readonly schemaVersion: number;
  readonly defaultData: JsonValue;
  validate(data: JsonValue, schemaVersion: number): void;
  migrate?(
    data: JsonValue,
    fromSchemaVersion: number,
  ): ExtensionAnimationDataMigration;
  compile(
    input: ExtensionInterpolationCompileInput,
  ): ExtensionCompiledInterpolationSegment;
  /**
   * Remaps provider-owned handles/coefficients when the host reverses or
   * retimes a track. Omit it to make that edit fail closed.
   */
  remap?(
    input: ExtensionInterpolationCompileInput,
    remap: ExtensionScalarRemap,
  ): ExtensionAnimationDataMigration;
  readonly editor?: (props: ExtensionInterpolationEditorProps) => unknown;
}

export interface ExtensionInterpolationRegistration
  extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionInterpolationApi {
  register(
    definition: ExtensionInterpolationDefinition,
  ): ExtensionInterpolationRegistration;
}

export interface ExtensionSpatialPathBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ExtensionCompiledSpatialPath extends ExtensionDisposable {
  /** Random-access sampling; progress normally lies in [0, 1]. */
  pointAt(progress: number): ExtensionPoint2D;
  tangentAt?(progress: number): ExtensionPoint2D;
  getBounds?(): ExtensionSpatialPathBounds;
  getLength?(): number;
  pointAtDistance?(distance: number): ExtensionPoint2D;
  hitTest?(point: ExtensionPoint2D, tolerance: number): boolean;
}

export interface ExtensionSpatialPathEditorProps {
  readonly value: ExtensionSpatialPathParameter;
  readonly domain: ExtensionAnimationEditorDomain;
  readonly currentTime: number;
  readonly onChange: (value: ExtensionSpatialPathParameter) => void;
}

export interface ExtensionSpatialPathOverlayParameters {
  readonly value: ExtensionSpatialPathParameter;
  readonly currentTime: number;
  readonly duration: number;
  readonly selected: boolean;
}

export interface ExtensionSpatialPathOverlayContext {
  readonly viewport: Readonly<{
    width: number;
    height: number;
    projectWidth: number;
    projectHeight: number;
  }>;
}

export type ExtensionTrustedSpatialPathOverlayInstance =
  ExtensionTrustedPixiObjectInstance<
    ExtensionSpatialPathOverlayParameters,
    ExtensionSpatialPathOverlayContext
  >;

/** Geometry, manipulation operations, and optional trusted editor surfaces. */
export interface ExtensionSpatialPathDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly label: string;
  readonly schemaVersion: number;
  readonly defaultData: JsonValue;
  validate(data: JsonValue, schemaVersion: number): void;
  migrate?(
    data: JsonValue,
    fromSchemaVersion: number,
  ): ExtensionAnimationDataMigration;
  compile(
    data: JsonValue,
    schemaVersion: number,
  ): ExtensionCompiledSpatialPath;
  /** Omit to make host reversal fail closed for this geometry. */
  reverse?(
    data: JsonValue,
    schemaVersion: number,
  ): ExtensionAnimationDataMigration;
  readonly editor?: (props: ExtensionSpatialPathEditorProps) => unknown;
  /** Optional host-slotted Pixi handles/overlay using the shared lifecycle. */
  readonly createOverlay?: () => ExtensionTrustedSpatialPathOverlayInstance;
}

export interface ExtensionSpatialPathRegistration extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionSpatialPathApi {
  register(
    definition: ExtensionSpatialPathDefinition,
  ): ExtensionSpatialPathRegistration;
}

export interface ExtensionAnimationApi {
  readonly scalarSources: ExtensionScalarSourceApi;
  readonly interpolations: ExtensionInterpolationApi;
  readonly spatialPaths: ExtensionSpatialPathApi;
}

/**
 * Persistence-only contract for one extension-owned payload type. Rendering
 * and editor UI are separate contribution contracts.
 */
export interface ExtensionPayloadProviderDefinition {
  id: string;
  apiVersion: 1;
  schemaVersion: number;
  validate(data: JsonValue, schemaVersion: number): void;
  migrate?(
    data: JsonValue,
    fromSchemaVersion: number,
  ): ExtensionPayloadMigration;
  getAssetReferences?(
    data: JsonValue,
    schemaVersion: number,
  ): readonly string[];
}

export interface ExtensionPayloadProviderRegistration
  extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionPayloadProviderApi {
  register(
    definition: ExtensionPayloadProviderDefinition,
  ): ExtensionPayloadProviderRegistration;
}

export interface ExtensionEntityAssetSnapshot {
  readonly id: string;
  readonly hash: string;
  readonly name: string;
  readonly type: "video" | "image" | "audio" | "lut";
  readonly src: string;
  readonly durationSeconds?: number;
  readonly fps?: number;
  readonly hasAudio?: boolean;
}

export interface ExtensionAssetIngestInput {
  readonly name: string;
  readonly type: "video" | "image" | "audio" | "lut";
  readonly blob: Blob;
}

export interface ExtensionAssetApi {
  list(): readonly ExtensionEntityAssetSnapshot[];
  get(assetId: string): ExtensionEntityAssetSnapshot | undefined;
  /** Loads browser-selected/project-backed bytes without exposing a file path. */
  readBlob(assetId: string): Promise<Blob>;
  /**
   * Copies bytes into the active project and resolves only after persistence.
   * A hash match returns the existing project asset rather than a sentinel.
   */
  ingest(input: ExtensionAssetIngestInput): Promise<ExtensionEntityAssetSnapshot>;
}

export interface ExtensionEntityRenderParameters {
  /** Detached, provider-validated payload data for this frame. */
  readonly data: JsonValue;
  readonly schemaVersion: number;
}

export interface ExtensionEntityRenderContext {
  readonly entity: Readonly<{
    id: string;
    name: string;
    trackId: string;
    startTicks: number;
    durationTicks: number;
  }>;
  readonly frame: Readonly<{
    projectWidth: number;
    projectHeight: number;
    presentationTimeTicks: number;
    visualTimeTicks: number;
    sourceTimeTicks: number;
    fps: number;
  }>;
  /** The exact host renderer. This is intentionally powerful in trusted mode. */
  readonly renderer: object;
  readonly assets: Readonly<{
    get(assetId: string): ExtensionEntityAssetSnapshot | undefined;
  }>;
}

export type ExtensionTrustedEntityRenderableInstance =
  ExtensionTrustedPixiObjectInstance<
    ExtensionEntityRenderParameters,
    ExtensionEntityRenderContext
  >;

export interface ExtensionEntityInspectorProps {
  readonly entity: Readonly<{
    id: string;
    name: string;
    trackId: string;
    startTicks: number;
    durationTicks: number;
  }>;
  readonly data: JsonValue;
  readonly schemaVersion: number;
  /** Commits one owner-checked, undoable payload update. */
  updateData(data: JsonValue): ExtensionTimelineTransactionResult;
}

/**
 * Primary renderable-entity contract. It deliberately accepts any host-Pixi
 * Container subclass (Graphics, Sprite, custom containers, shader-backed
 * objects). The host owns its render slot, compositing, masks, transforms, and
 * final destruction; the extension owns its contents and update logic.
 */
export interface ExtensionTrustedEntityProviderDefinition
  extends ExtensionPayloadProviderDefinition {
  readonly kind: "trusted-pixi";
  readonly label: string;
  readonly timelineColor?: string;
  readonly defaultPayload: JsonValue;
  readonly createRenderable: () => ExtensionTrustedEntityRenderableInstance;
  /**
   * Optional cache key for the pixels produced by `update`. Return the same
   * string only when every provider-owned pixel input beyond the payload
   * (including time and asset hashes when used) is unchanged. The host always
   * includes payload data, schema, entity identity, and output dimensions.
   * Omitting this callback safely disables texture reuse for time-driven or
   * externally mutable renderers.
   */
  readonly getRenderSignature?: (
    parameters: ExtensionEntityRenderParameters,
    context: ExtensionEntityRenderContext,
  ) => string;
  /** Optional arbitrary React inspector rendered in a host-owned error boundary. */
  readonly inspector?: (props: ExtensionEntityInspectorProps) => unknown;
}

export interface ExtensionEntityProviderRegistration
  extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionEntityProviderApi {
  register(
    definition: ExtensionTrustedEntityProviderDefinition,
  ): ExtensionEntityProviderRegistration;
}

export interface ExtensionTimelineEntitySnapshot {
  readonly id: string;
  readonly trackId: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  readonly payload: ExtensionPayload;
}

export interface ExtensionTimelineTransformSnapshot {
  readonly id: string;
  readonly type: string;
  readonly isEnabled: boolean;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly keyframeTimes?: readonly number[];
  readonly templateId?: string;
  readonly filterName?: string;
}

export interface ExtensionTimelineClipSnapshot {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly trackId: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  readonly assetId?: string;
  readonly transformations: readonly ExtensionTimelineTransformSnapshot[];
}

export interface ExtensionTimelineMaskBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ExtensionTimelineMaskActiveRange {
  readonly startSourceTicks: number;
  readonly endSourceTicks: number;
}

export interface ExtensionTimelineMaskSnapshot {
  readonly id: string;
  readonly parentClipId: string;
  readonly localId: string;
  readonly name: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  readonly maskType: string;
  readonly maskMode: string;
  readonly maskInverted: boolean;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly assetId?: string;
  readonly paintedBounds?: ExtensionTimelineMaskBounds;
  readonly activeRange?: ExtensionTimelineMaskActiveRange;
  readonly transformations: readonly ExtensionTimelineTransformSnapshot[];
}

export interface ExtensionTimelineTransitionSnapshot {
  readonly id: string;
  readonly type: string;
  readonly outgoingClipId: string;
  readonly incomingClipId: string;
  readonly schemaVersion?: number;
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

export interface ExtensionTimelineTransformInput {
  readonly id?: string;
  readonly type: string;
  readonly isEnabled?: boolean;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly keyframeTimes?: readonly number[];
  readonly templateId?: string;
  readonly filterName?: string;
}

export interface ExtensionTimelineProjectSnapshot {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly fitMode: "contain" | "cover";
}

export interface ExtensionSourceDimensions {
  readonly width: number;
  readonly height: number;
}

export interface ExtensionTimelineEntityCreateInput {
  readonly name: string;
  readonly trackId?: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  readonly payload: ExtensionPayload;
}

export interface ExtensionTimelineTransitionCreateInput {
  /** Local transition contribution ID registered by this extension. */
  readonly transitionType: string;
  readonly outgoingClipId: string;
  readonly incomingClipId: string;
  readonly parameters?: Readonly<Record<string, JsonValue>>;
}

export interface ExtensionTimelineTransaction {
  /** Returns the host-generated entity ID used by later commands in this transaction. */
  createEntity(input: ExtensionTimelineEntityCreateInput): string;
  updatePayload(entityId: string, payload: ExtensionPayload): void;
  moveEntity(
    entityId: string,
    placement: { readonly startTicks?: number; readonly trackId?: string },
  ): void;
  removeEntity(entityId: string): void;
  /** Adds or replaces a transform by ID and returns its stable ID. */
  upsertTransform(
    clipId: string,
    transform: ExtensionTimelineTransformInput,
  ): string;
  removeTransform(clipId: string, transformId: string): void;
  /** Creates a first-class transition using one of this extension's transition contributions. */
  createTransition(input: ExtensionTimelineTransitionCreateInput): string;
  updateTransitionParameters(
    transitionId: string,
    parameters: Readonly<Record<string, JsonValue>>,
  ): void;
  removeTransition(transitionId: string): void;
}

export type ExtensionTimelineTransactionFailureCode =
  | "invalid_label"
  | "invalid_command"
  | "entity_not_found"
  | "clip_not_found"
  | "transition_not_found"
  | "transition_type_not_found"
  | "transform_not_found"
  | "wrong_owner"
  | "incompatible_payload"
  | "callback_failed";

export type ExtensionTimelineTransactionResult =
  | { readonly ok: true; readonly changed: boolean; readonly label: string }
  | {
      readonly ok: false;
      readonly code: ExtensionTimelineTransactionFailureCode;
      readonly message: string;
      readonly label: string;
    };

export type ExtensionClipOverlayVisibility = "always" | "selected";
export type ExtensionClipOverlayLane = "top" | "middle" | "bottom";
export type ExtensionClipOverlayEdge = "start" | "end";

/** Anchored to a clip edge; multiple items in the same edge/lane stack. */
export interface ExtensionEndpointOverlayPlacement {
  readonly kind: "endpoint";
  readonly edge: ExtensionClipOverlayEdge;
  readonly lane: ExtensionClipOverlayLane;
  readonly insetPx: number;
  readonly order: number;
}

/** Anchored to a source-time position, tracked through crop/speed. */
export interface ExtensionSourceTimeOverlayPlacement {
  readonly kind: "sourceTime";
  readonly sourceTimeTicks: number;
  readonly lane: ExtensionClipOverlayLane;
  readonly offsetPx: number;
  readonly verticalOffsetPx: number;
}

export type ExtensionClipOverlayPlacement =
  | ExtensionEndpointOverlayPlacement
  | ExtensionSourceTimeOverlayPlacement;

export interface ExtensionClipOverlayRenderContext {
  readonly clip: ExtensionTimelineClipSnapshot;
  readonly isSelected: boolean;
  readonly item: ExtensionClipOverlayItem;
}

/** Pointer-drag context with the host's source/visual/presentation tick maths. */
export interface ExtensionClipOverlayDragContext
  extends ExtensionClipOverlayRenderContext {
  readonly event: PointerEvent;
  /** The overlay item's root element; use for direct effects during drag. */
  readonly targetElement: HTMLElement;
  readonly clipLocalX: number;
  readonly presentationOffsetTicks: number;
  readonly visualTimeTicks: number;
  readonly sourceTimeTicks: number;
  readonly deltaClipX: number;
  readonly deltaPresentationOffsetTicks: number;
  readonly deltaVisualTimeTicks: number;
  readonly deltaSourceTimeTicks: number;
  readonly mapPresentationOffsetToClipOffset: (offsetTicks: number) => number;
  readonly mapClipOffsetToPresentationOffset: (offsetTicks: number) => number;
}

export interface ExtensionClipOverlayItemDrag {
  readonly onDragStart?: (context: ExtensionClipOverlayDragContext) => void;
  readonly onDrag?: (context: ExtensionClipOverlayDragContext) => void;
  readonly onDragEnd?: (context: ExtensionClipOverlayDragContext) => void;
}

export interface ExtensionClipOverlayItem {
  readonly id: string;
  /** Trusted React node rendered inside the host-positioned overlay cell. */
  readonly content: unknown;
  readonly visibility?: ExtensionClipOverlayVisibility;
  readonly placement: ExtensionClipOverlayPlacement;
  readonly minClipWidthPx?: number;
  readonly onClick?: () => void;
  readonly onContextMenu?: (event: unknown) => void;
  readonly drag?: ExtensionClipOverlayItemDrag;
}

export interface ExtensionClipOverlaySourceProps {
  readonly clip: ExtensionTimelineClipSnapshot;
  readonly isSelected: boolean;
}

/**
 * A per-clip timeline overlay. `useItems` is a React hook run on every clip
 * render (obey the Rules of Hooks and keep it cheap — it is on the timeline's
 * hot path). Items are positioned, error-isolated, and disposed by the host.
 */
export interface ExtensionClipOverlayDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly kind: "trusted-overlay";
  readonly useItems: (
    props: ExtensionClipOverlaySourceProps,
  ) => readonly ExtensionClipOverlayItem[];
}

export interface ExtensionClipOverlayRegistration extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionTimelineApi {
  /** Canonical project time base used by all timeline command tick fields. */
  readonly ticksPerSecond: number;
  /**
   * Returns a detached snapshot for commands and UI events. This clones every
   * payload and is not intended as a render-loop or polling accessor.
   */
  listEntities(): readonly ExtensionTimelineEntitySnapshot[];
  /** Detached snapshots for user-driven commands; not a render-loop accessor. */
  listClips(): readonly ExtensionTimelineClipSnapshot[];
  /** Detached transition snapshots for user-driven commands. */
  listTransitions(): readonly ExtensionTimelineTransitionSnapshot[];
  /** Detached mask snapshots attached to a clip. */
  listClipMasks(clipId: string): readonly ExtensionTimelineMaskSnapshot[];
  /** Current render-domain dimensions and timebase, detached from host state. */
  getProject(): ExtensionTimelineProjectSnapshot;
  /** Converts a zero-based source frame index into vlo's canonical tick unit. */
  sourceFrameToTicks(frameIndex: number, sourceFps: number): number;
  /** Maps normalized clip-local visual progress through crop/speed into source time. */
  clipProgressToSourceTicks(clipId: string, progress: number): number;
  /** Inverse crop/speed mapping used to place source-owned results visually. */
  sourceTicksToClipProgress(clipId: string, sourceTimeTicks: number): number;
  /**
   * Maps source-pixel coordinates through the project's centred contain/cover
   * layout into the additive, centre-origin position-transform domain.
   */
  sourcePointToProject(
    point: ExtensionPoint2D,
    source: ExtensionSourceDimensions,
    fitMode?: "contain" | "cover",
  ): ExtensionPoint2D;
  transaction(
    label: string,
    callback: (transaction: ExtensionTimelineTransaction) => void,
  ): ExtensionTimelineTransactionResult;
  /**
   * Registers a per-clip timeline overlay. The registration is owner-scoped and
   * removed on disposal/deactivation.
   */
  registerClipOverlay(
    definition: ExtensionClipOverlayDefinition,
  ): ExtensionClipOverlayRegistration;
}

/** Restricted-ready convenience filters executed entirely by the host. */
export type ExtensionDeclarativeHostFilter =
  | "color-adjustment"
  | "hsl-adjustment"
  | "bloom"
  | "glow"
  | "crt"
  | "old-film"
  | "dot"
  | "ascii"
  | "bulge-pinch";

/** @deprecated Prefer the explicit `ExtensionDeclarativeHostFilter` name. */
export type ExtensionHostFilter = ExtensionDeclarativeHostFilter;

export interface ExtensionTransformationNumberControl {
  readonly type: "slider" | "number";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly supportsSpline?: boolean;
}

export interface ExtensionTransformationCheckboxControl {
  readonly type: "checkbox";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: boolean;
}

export interface ExtensionTransformationTextControl {
  readonly type: "text" | "color";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string;
}

export interface ExtensionTransformationSelectOption {
  readonly label: string;
  readonly value: string | number;
}

export interface ExtensionTransformationSelectControl {
  readonly type: "select";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string | number;
  readonly options: readonly ExtensionTransformationSelectOption[];
}

/**
 * Mounts a rich control registered with `ui.registerPanelControl()` inside this
 * transformation's own group. UI-only: `name` identifies the control, it is not
 * a persisted parameter, and it never appears in `defaultParameters`.
 */
export interface ExtensionTransformationCustomControl {
  readonly type: "custom";
  readonly name: string;
  readonly label: string;
  /** A panel-control ID registered by the same extension. Not owner-qualified. */
  readonly componentId: string;
  readonly config?: Readonly<Record<string, JsonValue>>;
  /**
   * Restricts what the control may commit. Omit to allow every parameter this
   * transformation declares.
   */
  readonly parameterNames?: readonly string[];
}

export type ExtensionTransformationControl =
  | ExtensionTransformationNumberControl
  | ExtensionTransformationCheckboxControl
  | ExtensionTransformationTextControl
  | ExtensionTransformationSelectControl
  | ExtensionTransformationCustomControl;

export interface ExtensionTransformationControlGroup {
  readonly id: string;
  readonly title: string;
  readonly columns?: number;
  readonly controls: readonly ExtensionTransformationControl[];
}

interface ExtensionTransformationBaseDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly label: string;
  readonly adjustmentCompatible?: boolean;
  readonly groups: readonly ExtensionTransformationControlGroup[];
}

/**
 * Declarative, restricted-ready transformation backed by a host-owned filter.
 * This is a convenience lane, not the authority ceiling for trusted extensions.
 */
export interface ExtensionHostFilterTransformationDefinition
  extends ExtensionTransformationBaseDefinition {
  readonly kind: "host-filter";
  readonly hostFilter: ExtensionDeclarativeHostFilter;
}

/**
 * Extension-facing projection of the host's native filter time dependency.
 *
 * - `none`: the output is a pure function of its parameters and the current
 *   input texture. Stateless filters (e.g. desaturate) omit rendering metadata
 *   and default to this.
 * - `sample`: the output reads the current timeline sample (procedural filters
 *   that animate from canonical visual time) but keep no previous-frame state.
 * - `history`: the output depends on earlier samples through retained feedback
 *   state (e.g. Matrix Rain). The host may replay bounded warm-up frames.
 */
export type ExtensionFilterTimeDependency = "none" | "sample" | "history";

/**
 * Optional authoring/runtime policy describing how a trusted filter consumes
 * time. It is not persisted per transform; it is definition metadata the host
 * uses to schedule replay and to key sample-aware caches.
 */
export interface ExtensionTrustedFilterRenderingDefinition {
  readonly timeDependency: ExtensionFilterTimeDependency;
  /** Maximum earlier presentation time the host may need to replay. */
  readonly maxHistorySeconds?: number;
  /** Largest continuous step the effect accepts without replay/subdivision. */
  readonly maxStepSeconds?: number;
}

export type ExtensionRenderMode = "preview" | "export" | "still";

export type ExtensionRenderContinuity =
  | "initial"
  | "sequential"
  | "repeat"
  | "discontinuous";

/**
 * Immutable extension projection of the host's native render-sample identity
 * and timing. It lets a temporal filter distinguish sequential frames,
 * repeated paused renders, seeks, stills, and exports without reading any
 * global clock.
 */
export interface ExtensionFilterRenderSample {
  /** Changes whenever the host invalidates temporal history. */
  readonly sequenceId: number;
  /** Stable across duplicate GPU submissions for one logical sample. */
  readonly sampleId: number;
  readonly mode: ExtensionRenderMode;
  readonly continuity: ExtensionRenderContinuity;
  readonly presentationTimeTicks: number;
  readonly visualTimeTicks: number;
  readonly sourceTimeTicks: number;
  /** Present only when the host certifies continuity from the previous sample. */
  readonly deltaTimeTicks: number | null;
  readonly fps: number;
  /** Warm-up frames update state but are not presented or encoded. */
  readonly isWarmup: boolean;
}

export interface ExtensionTrustedFilterApplyContext {
  /** The actual host Pixi target. Trusted extensions may narrow this object. */
  readonly target: object;
  /** The authored transform ID this filter instance is bound to. */
  readonly transformId: string;
  readonly contentSize?: Readonly<{ width: number; height: number }>;
  readonly render: ExtensionFilterRenderSample;
}

/**
 * One extension-created object from the injected host Pixi runtime. Domain
 * adapters validate its concrete type and own attachment, detachment, and final
 * Pixi destruction; extensions update it and release only their extra resources.
 */
export interface ExtensionTrustedPixiObjectInstance<
  TParameters = Readonly<Record<string, unknown>>,
  TContext = unknown,
> {
  readonly object: object;
  update(parameters: TParameters, context: TContext): void;
  /** Release resources other than `object`; the host destroys the Pixi object. */
  destroy?(): void;
}

export type ExtensionTrustedFilterInstance =
  ExtensionTrustedPixiObjectInstance<
    Readonly<Record<string, unknown>>,
    ExtensionTrustedFilterApplyContext
  >;

/**
 * Primary trusted filter contract. `createFilter` may construct arbitrary Pixi
 * filters, including custom GLSL/WGSL programs, using `api.runtime.pixi`.
 */
export interface ExtensionTrustedFilterTransformationDefinition
  extends ExtensionTransformationBaseDefinition {
  readonly kind: "trusted-filter";
  readonly defaultParameters?: Readonly<Record<string, JsonValue>>;
  readonly validateParameters?: (
    parameters: Readonly<Record<string, unknown>>,
  ) => boolean;
  /**
   * Optional render-dependency policy. Omitting it means
   * `timeDependency: "none"`, preserving existing stateless extensions.
   */
  readonly rendering?: ExtensionTrustedFilterRenderingDefinition;
  readonly createFilter: () => ExtensionTrustedFilterInstance;
}

export interface ExtensionTrustedTransformationState {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  filters: Array<{
    type: string;
    params: Record<string, unknown>;
  }>;
  blendMode?: string;
}

export interface ExtensionTrustedTransformationApplyContext {
  readonly state: ExtensionTrustedTransformationState;
  readonly transform: Readonly<{
    id: string;
    type: string;
    isEnabled: boolean;
    parameters: Readonly<Record<string, unknown>>;
  }>;
  readonly render: Readonly<{
    container: Readonly<{ width: number; height: number }>;
    content: Readonly<{ width: number; height: number }>;
    time?: number;
    visualTime?: number;
    visualDuration?: number;
  }>;
}

/** Primary trusted contract for arbitrary render-state transformations. */
export interface ExtensionTrustedTransformationDefinition
  extends ExtensionTransformationBaseDefinition {
  readonly kind: "trusted-transformation";
  readonly defaultParameters?: Readonly<Record<string, JsonValue>>;
  readonly validateParameters?: (
    parameters: Readonly<Record<string, unknown>>,
  ) => boolean;
  readonly apply: (context: ExtensionTrustedTransformationApplyContext) => void;
}

export type ExtensionTransformationDefinition =
  | ExtensionTrustedFilterTransformationDefinition
  | ExtensionTrustedTransformationDefinition
  | ExtensionHostFilterTransformationDefinition;

export interface ExtensionTransformationRegistration
  extends ExtensionDisposable {
  readonly id: string;
}

// === Parameter presets ===

/**
 * The transformation a preset patches. The registry is generic, but each target
 * is host-adapted: it needs a declared identity, a parameter validator, merge
 * semantics, and host UI that consumes the registry. `ColorGradeFilter` is the
 * first supported target.
 */
export interface ExtensionParameterPresetTarget {
  readonly kind: "filter";
  readonly filterName: string;
}

export interface ExtensionParameterPresetDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly label: string;
  readonly target: ExtensionParameterPresetTarget;
  /**
   * A partial, static parameter patch, validated and clamped by the target's
   * host schema. Omitted fields keep their authored values, so a preset never
   * resets parameters it does not mention.
   *
   * API version 1 rejects animated values, because transferring them correctly
   * needs a source time range the preset cannot carry, and `lutAssetId`, because
   * an extension package cannot know a durable project asset ID.
   */
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly order?: number;
}

export interface ExtensionParameterPresetRegistration
  extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionParameterPresetApi {
  register(
    definition: ExtensionParameterPresetDefinition,
  ): ExtensionParameterPresetRegistration;
}

export interface ExtensionTransformationApi {
  register(
    definition: ExtensionTransformationDefinition,
  ): ExtensionTransformationRegistration;
  /** Static parameter patches offered by host panels that support a target. */
  readonly presets: ExtensionParameterPresetApi;
}

export interface ExtensionTransitionNumberControl {
  readonly type: "slider" | "number";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
}

export interface ExtensionTransitionCheckboxControl {
  readonly type: "checkbox";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: boolean;
}

export interface ExtensionTransitionTextControl {
  readonly type: "text" | "color";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string;
}

export interface ExtensionTransitionSelectOption {
  readonly label: string;
  readonly value: string | number | boolean;
}

export interface ExtensionTransitionSelectControl {
  readonly type: "select";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string | number | boolean;
  readonly options: readonly ExtensionTransitionSelectOption[];
}

export type ExtensionTransitionControl =
  | ExtensionTransitionNumberControl
  | ExtensionTransitionCheckboxControl
  | ExtensionTransitionTextControl
  | ExtensionTransitionSelectControl;

export interface ExtensionTransitionControlGroup {
  readonly id: string;
  readonly title: string;
  readonly columns?: number;
  readonly controls: readonly ExtensionTransitionControl[];
}

export type ExtensionTransitionZOrder =
  | "default"
  | "outgoing-on-top"
  | "incoming-on-top";

export interface ExtensionTransitionTransform {
  readonly id?: string;
  readonly type: string;
  readonly isEnabled?: boolean;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly templateId?: string;
  readonly filterName?: string;
}

export interface ExtensionTransitionColorLayer {
  readonly id?: string;
  readonly color: string;
  readonly zIndexOffset?: number;
}

export interface ExtensionTransitionRenderInput {
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly schemaVersion: number;
  readonly progress: number;
  readonly transition: Readonly<{
    readonly id: string;
    readonly startTicks: number;
    readonly endTicks: number;
    readonly durationTicks: number;
  }>;
  readonly outgoingClip: ExtensionTimelineClipSnapshot;
  readonly incomingClip: ExtensionTimelineClipSnapshot;
  readonly frame: Readonly<{
    readonly projectWidth: number;
    readonly projectHeight: number;
    readonly fps: number;
    readonly presentationTimeTicks: number;
  }>;
}

export interface ExtensionTransitionFrame {
  readonly outgoingTransforms?: readonly ExtensionTransitionTransform[];
  readonly incomingTransforms?: readonly ExtensionTransitionTransform[];
  readonly colorLayers?: readonly ExtensionTransitionColorLayer[];
  readonly zOrder?: ExtensionTransitionZOrder;
}

export interface ExtensionTransitionParameterMigration {
  readonly schemaVersion: number;
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

export interface ExtensionTransitionDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly label: string;
  readonly glyph: string;
  readonly schemaVersion: number;
  readonly defaultParameters?: Readonly<Record<string, JsonValue>>;
  readonly groups?: readonly ExtensionTransitionControlGroup[];
  readonly zOrder?: ExtensionTransitionZOrder;
  validateParameters?(
    parameters: Readonly<Record<string, JsonValue>>,
    schemaVersion: number,
  ): boolean;
  migrateParameters?(
    parameters: Readonly<Record<string, JsonValue>>,
    fromSchemaVersion: number,
  ): ExtensionTransitionParameterMigration;
  renderFrame(input: ExtensionTransitionRenderInput): ExtensionTransitionFrame;
}

export interface ExtensionTransitionRegistration extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionTransitionApi {
  register(
    definition: ExtensionTransitionDefinition,
  ): ExtensionTransitionRegistration;
}

export interface ExtensionPixiShaderSource {
  readonly vertex: string;
  readonly fragment: string;
  readonly name?: string;
}

/**
 * Deliberately open Pixi filter options. The common shader fields are typed;
 * trusted extensions may use any other host-version-specific Pixi option.
 */
export interface ExtensionPixiFilterOptions {
  readonly gl?: ExtensionPixiShaderSource;
  readonly gpu?: Readonly<Record<string, unknown>>;
  readonly resources?: Readonly<Record<string, unknown>>;
  readonly padding?: number;
  readonly resolution?: number | "inherit";
  readonly antialias?: boolean | "on" | "off" | "inherit";
  readonly blendRequired?: boolean;
  readonly clipToViewport?: boolean;
  readonly [option: string]: unknown;
}

/**
 * The actual host `pixi.js` module namespace. Frequently used Filter APIs are
 * typed here; authors may narrow other exports with type-only Pixi imports.
 */
export interface ExtensionPixiRuntime {
  readonly Filter: {
    new (options: ExtensionPixiFilterOptions): object;
    from(options: ExtensionPixiFilterOptions): object;
  };
  readonly [exportName: string]: unknown;
}

export interface ExtensionReactRuntime {
  createElement(
    type: unknown,
    props: Readonly<Record<string, unknown>> | null,
    ...children: unknown[]
  ): unknown;
  readonly [exportName: string]: unknown;
}

/** Host-curated MUI controls without a duplicate emotion/theme tree. */
export interface ExtensionMuiRuntime {
  readonly [exportName: string]: unknown;
}

/**
 * Complete, version-coupled host panelUI barrel for trusted extensions.
 * Prefer scoped contribution APIs where available; this runtime remains the
 * unscoped authority escape hatch and is not restricted-mode compatible.
 */
export interface ExtensionPanelUiRuntime {
  readonly [exportName: string]: unknown;
}

/** Exact host singleton runtimes supplied to trusted frontend extensions. */
export interface ExtensionHostRuntimeApi {
  readonly pixi: ExtensionPixiRuntime;
  readonly react: ExtensionReactRuntime;
  readonly mui: ExtensionMuiRuntime;
  readonly panelUi: ExtensionPanelUiRuntime;
}

/** One discoverable, version-coupled live host reference. */
export interface ExtensionTrustedHostEntry {
  readonly id: string;
  readonly available: boolean;
  /** Session entries retain identity; availability entries may be replaced. */
  readonly lifetime: "session" | "availability";
}

/**
 * Stable reachability mechanism for trusted extensions. Entry IDs and returned
 * shapes are raw host internals and are not SDK compatibility promises.
 */
export interface ExtensionTrustedHostApi {
  /** VLO application/build version, distinct from the extension SDK version. */
  readonly hostVersion: string | null;
  /** Discovery is isolated: one invalid host entry is reported as unavailable. */
  list(): readonly ExtensionTrustedHostEntry[];
  /** Return the live reference, or undefined when unavailable or shape-invalid. */
  get(id: string): unknown;
  /** Return the live reference or throw an extension-labelled diagnostic error. */
  require(id: string): unknown;
  /** Monotonic change token for availability-scoped entries. */
  getRevision(): number;
  subscribe(listener: () => void): () => void;
  /**
   * Install an owner-tracked descriptor-factory patch. Factories may be run
   * repeatedly and must be synchronous, deterministic, and side-effect free.
   */
  patchProperty(
    target: object,
    property: PropertyKey,
    createDescriptor: (
      previous: PropertyDescriptor | undefined,
    ) => PropertyDescriptor,
  ): ExtensionDisposable;
}

export interface ExtensionTrustedApi {
  readonly host: ExtensionTrustedHostApi;
}

/** Open string type; the host still accepts only slot regions it declares. */
export type ExtensionUiSlotId = string;
export type ExtensionUiNoticeTone = "info" | "success" | "warning";
export type ExtensionUiModalSize = "small" | "medium" | "large";
export type ExtensionUiWorkspaceLocation = "right-sidebar" | "left-sidebar";

export interface ExtensionUiComponentProps {
  readonly slot: ExtensionUiSlotId;
}

export interface ExtensionUiModalComponentProps {
  readonly input?: JsonValue;
  close(result?: JsonValue): void;
}

export interface ExtensionUiWorkspaceComponentProps {
  /** Globally owner-qualified contribution ID. */
  readonly workspaceId: string;
  readonly location: ExtensionUiWorkspaceLocation;
  /** Once opened, inactive workspaces remain mounted so editor state survives. */
  readonly active: boolean;
}

/** Declarative native UI contribution suitable for future restricted mode. */
export interface ExtensionUiNoticeDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly slot: ExtensionUiSlotId;
  readonly kind: "notice";
  readonly title: string;
  readonly message: string;
  readonly tone?: ExtensionUiNoticeTone;
  readonly order?: number;
}

export interface ExtensionUiRegistration extends ExtensionDisposable {
  readonly id: string;
}

// === Panel controls ===

/**
 * Props handed to a rich panel control. Values crossing this boundary are cloned
 * in both directions, so mutating them has no effect on host state; commit
 * instead.
 */
export interface ExtensionPanelControlProps {
  /** Live parameter values of the transformation this control is mounted in. */
  readonly values: Readonly<Record<string, JsonValue>>;
  readonly transformId?: string;
  readonly disabled: boolean;
  /** Source-media time domain, for controls that transfer animated values. */
  readonly sourceTimeRange?: {
    readonly minTime: number;
    readonly duration: number;
  };
  /** Placement config, or the custom control's `config`. Empty when unset. */
  readonly config: Readonly<Record<string, JsonValue>>;

  /**
   * Commits through the host panel's own path, so live preview, undo, history,
   * and keyframe handling all behave as they do for built-in controls. Commits
   * to parameters outside the control's allowlist are rejected and reported.
   */
  commitParameter(name: string, value: JsonValue): void;
  commitParameters(values: Readonly<Record<string, JsonValue>>): void;
}

/**
 * Mounts a control into a host-declared panel zone. The host owns the placement
 * catalogue; an extension cannot invent a target.
 */
export interface ExtensionPanelControlPlacement {
  readonly target: {
    readonly kind: "filter";
    readonly filterName: string;
    readonly zone: string;
  };
  readonly order?: number;
  readonly config?: Readonly<Record<string, JsonValue>>;
}

export interface ExtensionPanelControlDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly kind: "trusted-react";
  readonly component: (props: ExtensionPanelControlProps) => unknown;
  /** Omit to use the control only inside this extension's own transformations. */
  readonly placements?: readonly ExtensionPanelControlPlacement[];
}

export interface ExtensionPanelControlRegistration extends ExtensionDisposable {
  readonly id: string;
}

// === Commands and keybindings ===

/**
 * Declarative predicate over host-published context keys (e.g. `project.open`,
 * `focus.region`, `selection.clipCount`). Keys are host-curated; an unknown key
 * evaluates as `undefined`. A bare `{ key }` tests JavaScript truthiness.
 */
export type ExtensionContextKeyExpression =
  | { readonly key: string }
  | { readonly key: string; readonly equals: JsonValue }
  | { readonly not: ExtensionContextKeyExpression }
  | { readonly and: readonly ExtensionContextKeyExpression[] }
  | { readonly or: readonly ExtensionContextKeyExpression[] };

export type ExtensionCommandSource =
  | "menu"
  | "keybinding"
  | "palette"
  | "toolbar"
  | "api";

/**
 * One command invocation. `subject` is the detached, JSON-serialisable subject
 * of the invoking surface (a menu's subject, a palette argument), never a live
 * host object.
 */
export interface ExtensionCommandInvocation {
  readonly subject?: JsonValue;
  readonly source: ExtensionCommandSource;
}

/**
 * A declarative command in the host's single command table. Menus, keybindings,
 * and future palette/toolbar surfaces are projections of this table. `when`
 * gates enablement declaratively so it stays evaluable in a future restricted
 * profile; a command whose `when` is false is not executed.
 */
export interface ExtensionCommandDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly title: string;
  /** Optional trusted icon component rendered by command-projecting surfaces. */
  readonly icon?: () => unknown;
  readonly when?: ExtensionContextKeyExpression;
  readonly run: (
    invocation: ExtensionCommandInvocation,
  ) => void | Promise<void>;
}

/**
 * A requested chord for one of this extension's commands, e.g. "Mod+Shift+K"
 * ("Mod" is Ctrl, or Cmd on macOS). Bindings that collide with an existing
 * active binding — including chords the host has reserved for its own
 * shortcuts — register as inactive with a diagnostic instead of failing
 * activation; the host arbitrates dispatch through its editor focus regions.
 */
export interface ExtensionKeybindingRequest {
  readonly id: string;
  readonly apiVersion: 1;
  readonly chord: string;
  /**
   * Local command ID registered by the same extension. The command must
   * already be registered when the keybinding is requested.
   */
  readonly command: string;
  /** Editor focus regions the binding is active in; omit for global. */
  readonly regions?: readonly string[];
}

export interface ExtensionCommandApi {
  register(definition: ExtensionCommandDefinition): ExtensionUiRegistration;
  registerKeybinding(
    request: ExtensionKeybindingRequest,
  ): ExtensionUiRegistration;
  /**
   * Executes one of this extension's own commands by local ID, or an
   * explicitly allowlisted host command by its full dotted ID. Executing any
   * other host command rejects: host commands are an authority surface, and
   * contributing a menu item the *user* invokes is the intended path.
   */
  execute(commandId: string, subject?: JsonValue): Promise<void>;
  /** Reads one host context key, detached. Unknown keys return `undefined`. */
  getContextKey(key: string): JsonValue | undefined;
}

export interface ExtensionUiApi {
  /** The host command table and chord requests (see `ExtensionCommandApi`). */
  readonly commands: ExtensionCommandApi;
  /**
   * Registers a rich React control. Use it in an extension transformation's own
   * groups via a `custom` control, or place it in a host panel zone, or both.
   */
  registerPanelControl(
    definition: ExtensionPanelControlDefinition,
  ): ExtensionPanelControlRegistration;
  registerNotice(
    definition: ExtensionUiNoticeDefinition,
  ): ExtensionUiRegistration;
  registerComponent(
    definition: ExtensionTrustedUiComponentDefinition,
  ): ExtensionUiRegistration;
  registerModal(
    definition: ExtensionTrustedUiModalDefinition,
  ): ExtensionUiRegistration;
  registerWorkspace(
    definition: ExtensionTrustedUiWorkspaceDefinition,
  ): ExtensionUiRegistration;
  /** Adds a command to a host-owned context/action menu (see menu slots). */
  registerMenuItem(
    definition: ExtensionUiMenuItemDefinition,
  ): ExtensionUiRegistration;
  /** Opens one modal registered by the calling extension. */
  openModal(id: string, input?: JsonValue): Promise<JsonValue | undefined>;
  /** Selects one workspace registered by the calling extension. */
  openWorkspace(id: string): boolean;
}

/** Arbitrary React component rendered inside a host-owned, isolated slot. */
export interface ExtensionTrustedUiComponentDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly slot: ExtensionUiSlotId;
  readonly kind: "trusted-react";
  readonly order?: number;
  readonly component: (props: ExtensionUiComponentProps) => unknown;
}

/** Arbitrary trusted React rendered inside a host-owned MUI dialog. */
export interface ExtensionTrustedUiModalDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly kind: "trusted-modal";
  readonly title: string;
  readonly size?: ExtensionUiModalSize;
  readonly component: (props: ExtensionUiModalComponentProps) => unknown;
}

/** Arbitrary trusted React rendered in a host-owned editor workspace. */
export interface ExtensionTrustedUiWorkspaceDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly kind: "trusted-workspace";
  readonly title: string;
  readonly location: ExtensionUiWorkspaceLocation;
  readonly order?: number;
  readonly component: (props: ExtensionUiWorkspaceComponentProps) => unknown;
}

/**
 * Open string type; the host accepts only the menu regions it declares. Current
 * host catalogue: `timeline.clip.context` (timeline clip right-click) and
 * `library.item.actions` (asset three-dot menu).
 */
export type ExtensionUiMenuSlotId = string;

/** Detached, JSON-serialisable subject of the menu the user opened. */
export type ExtensionUiMenuItemContext =
  | {
      readonly slot: "timeline.clip.context";
      readonly clip: ExtensionTimelineClipSnapshot;
    }
  | {
      readonly slot: "library.item.actions";
      readonly asset: ExtensionEntityAssetSnapshot;
    };

/**
 * A declarative command in a host-owned menu. The host renders the native menu
 * item; the extension supplies the label, an optional trusted icon, and the
 * action invoked with the clicked subject. Keeping this declarative preserves
 * restricted-mode reachability.
 */
export interface ExtensionUiMenuItemDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly slot: ExtensionUiMenuSlotId;
  readonly kind: "menu-item";
  readonly label: string;
  readonly order?: number;
  /** Optional trusted icon component rendered before the label. */
  readonly icon?: () => unknown;
  /** Hide the item for a given subject (e.g. only for video clips). */
  readonly isVisible?: (context: ExtensionUiMenuItemContext) => boolean;
  readonly onSelect: (context: ExtensionUiMenuItemContext) => void;
}

export interface ExtensionGenerationInputSnapshot {
  readonly id: string;
  readonly nodeId: string;
  readonly param: string;
  readonly label: string;
  readonly description?: string;
  readonly inputType: "text" | "image" | "video" | "audio";
  readonly value?: JsonValue;
}

export interface ExtensionGenerationTransaction {
  setTextInput(inputId: string, value: string): void;
}

export type ExtensionGenerationTransactionResult =
  | { readonly ok: true; readonly changed: boolean; readonly label: string }
  | {
      readonly ok: false;
      readonly code:
        | "unavailable"
        | "invalid_label"
        | "invalid_command"
        | "input_not_found"
        | "input_type_mismatch"
        | "callback_failed";
      readonly message: string;
      readonly label: string;
    };

/** User-event API for the currently mounted generation/workflow panel. */
export interface ExtensionGenerationApi {
  listInputs(): readonly ExtensionGenerationInputSnapshot[];
  transaction(
    label: string,
    callback: (transaction: ExtensionGenerationTransaction) => void,
  ): ExtensionGenerationTransactionResult;
}

// === Color ===

export type ColorGradingSpace = "srgb-rec709";

/** The color model a grade was authored against. V1 is the only model today. */
export interface AuthoredColorModelV1 {
  readonly version: 1;
  readonly gradingSpace: ColorGradingSpace;
}

export type ColorRgb = readonly [number, number, number];
/** Premultiplied RGBA, matching the renderer's compositing convention. */
export type ColorRgba = readonly [number, number, number, number];

export interface ColorCurvePoint {
  readonly x: number;
  readonly y: number;
}

/** A parsed `.cube` LUT. Produced by `parseCubeLut` and `bakeColorGradeCube`. */
export interface CubeLut {
  readonly title: string | null;
  readonly dimensions: 1 | 3;
  readonly size: number;
  readonly domainMin: ColorRgb;
  readonly domainMax: ColorRgb;
  /** rgb triples; length = size * 3 (1D) or size³ * 3 (3D). */
  readonly data: Float32Array;
}

/** The seven grade curves. Each is optional; omitted curves are identity. */
export interface ColorCurveSet {
  readonly curveMaster?: readonly ColorCurvePoint[];
  readonly curveR?: readonly ColorCurvePoint[];
  readonly curveG?: readonly ColorCurvePoint[];
  readonly curveB?: readonly ColorCurvePoint[];
  readonly curveHueHue?: readonly ColorCurvePoint[];
  readonly curveHueSat?: readonly ColorCurvePoint[];
  readonly curveLumaSat?: readonly ColorCurvePoint[];
}

export interface ColorCurveSampler {
  at(value: number): number;
}

/**
 * Grade values ready for numeric evaluation: every animatable field is a plain
 * number. Obtain one from `resolve()` or `normalize()`, never by casting
 * persisted parameters.
 */
export interface ColorGradeResolvedParametersV1 {
  readonly colorModel: AuthoredColorModelV1;

  readonly exposure: number;
  readonly temperature: number;
  readonly tint: number;
  readonly contrast: number;
  readonly pivot: number;
  readonly kneeThreshold: number;
  readonly kneeSoftness: number;
  readonly toeAmount: number;
  readonly toeSoftness: number;
  readonly saturation: number;
  readonly vibrance: number;
  readonly hueRotate: number;

  readonly liftR: number;
  readonly liftG: number;
  readonly liftB: number;
  readonly liftMaster: number;
  readonly gammaR: number;
  readonly gammaG: number;
  readonly gammaB: number;
  readonly gammaMaster: number;
  readonly gainR: number;
  readonly gainG: number;
  readonly gainB: number;
  readonly gainMaster: number;
  readonly offsetR: number;
  readonly offsetG: number;
  readonly offsetB: number;
  readonly offsetMaster: number;

  readonly curveMaster: readonly ColorCurvePoint[];
  readonly curveR: readonly ColorCurvePoint[];
  readonly curveG: readonly ColorCurvePoint[];
  readonly curveB: readonly ColorCurvePoint[];
  readonly curveHueHue: readonly ColorCurvePoint[];
  readonly curveHueSat: readonly ColorCurvePoint[];
  readonly curveLumaSat: readonly ColorCurvePoint[];

  readonly qualifierEnabled: boolean;
  readonly hueCenter: number;
  readonly hueWidth: number;
  readonly hueSoftLo: number;
  readonly hueSoftHi: number;
  readonly satLo: number;
  readonly satHi: number;
  readonly satSoftLo: number;
  readonly satSoftHi: number;
  readonly lumaLo: number;
  readonly lumaHi: number;
  readonly lumaSoftLo: number;
  readonly lumaSoftHi: number;
  readonly qualifierInvert: boolean;
  readonly mattePreview: boolean;

  /** Creative LUT slot. References a project asset; the bytes live out of band. */
  readonly lutAssetId: string | null;
  readonly lutIntensity: number;

  readonly ditherStrength: number;
}

export interface ColorGradeSplinePointV1 {
  readonly time: number;
  readonly value: number;
}

/** Legacy host-authored animation retained for grade round trips. */
export interface ColorGradeSplineParameterV1 {
  readonly type: "spline";
  readonly points: readonly ColorGradeSplinePointV1[];
}

export type ColorGradeAuthoredScalarV1 =
  | ExtensionScalarValue
  | ColorGradeSplineParameterV1;

/**
 * Grade values as persisted. An animatable field may hold an authored animation
 * object rather than a number, so these must be resolved at a source time
 * before evaluation. Passing them to `normalize()` throws rather than silently
 * replacing the animation with a default.
 */
export interface ColorGradeAuthoredParametersV1 {
  readonly colorModel: AuthoredColorModelV1;

  readonly exposure?: ColorGradeAuthoredScalarV1;
  readonly temperature?: ColorGradeAuthoredScalarV1;
  readonly tint?: ColorGradeAuthoredScalarV1;
  readonly contrast?: ColorGradeAuthoredScalarV1;
  readonly pivot?: ColorGradeAuthoredScalarV1;
  readonly kneeThreshold?: ColorGradeAuthoredScalarV1;
  readonly kneeSoftness?: ColorGradeAuthoredScalarV1;
  readonly toeAmount?: ColorGradeAuthoredScalarV1;
  readonly toeSoftness?: ColorGradeAuthoredScalarV1;
  readonly saturation?: ColorGradeAuthoredScalarV1;
  readonly vibrance?: ColorGradeAuthoredScalarV1;
  readonly hueRotate?: ColorGradeAuthoredScalarV1;

  readonly liftR?: ColorGradeAuthoredScalarV1;
  readonly liftG?: ColorGradeAuthoredScalarV1;
  readonly liftB?: ColorGradeAuthoredScalarV1;
  readonly liftMaster?: ColorGradeAuthoredScalarV1;
  readonly gammaR?: ColorGradeAuthoredScalarV1;
  readonly gammaG?: ColorGradeAuthoredScalarV1;
  readonly gammaB?: ColorGradeAuthoredScalarV1;
  readonly gammaMaster?: ColorGradeAuthoredScalarV1;
  readonly gainR?: ColorGradeAuthoredScalarV1;
  readonly gainG?: ColorGradeAuthoredScalarV1;
  readonly gainB?: ColorGradeAuthoredScalarV1;
  readonly gainMaster?: ColorGradeAuthoredScalarV1;
  readonly offsetR?: ColorGradeAuthoredScalarV1;
  readonly offsetG?: ColorGradeAuthoredScalarV1;
  readonly offsetB?: ColorGradeAuthoredScalarV1;
  readonly offsetMaster?: ColorGradeAuthoredScalarV1;

  readonly curveMaster?: readonly ColorCurvePoint[];
  readonly curveR?: readonly ColorCurvePoint[];
  readonly curveG?: readonly ColorCurvePoint[];
  readonly curveB?: readonly ColorCurvePoint[];
  readonly curveHueHue?: readonly ColorCurvePoint[];
  readonly curveHueSat?: readonly ColorCurvePoint[];
  readonly curveLumaSat?: readonly ColorCurvePoint[];

  readonly qualifierEnabled?: boolean;
  readonly hueCenter?: ColorGradeAuthoredScalarV1;
  readonly hueWidth?: ColorGradeAuthoredScalarV1;
  readonly hueSoftLo?: ColorGradeAuthoredScalarV1;
  readonly hueSoftHi?: ColorGradeAuthoredScalarV1;
  readonly satLo?: ColorGradeAuthoredScalarV1;
  readonly satHi?: ColorGradeAuthoredScalarV1;
  readonly satSoftLo?: ColorGradeAuthoredScalarV1;
  readonly satSoftHi?: ColorGradeAuthoredScalarV1;
  readonly lumaLo?: ColorGradeAuthoredScalarV1;
  readonly lumaHi?: ColorGradeAuthoredScalarV1;
  readonly lumaSoftLo?: ColorGradeAuthoredScalarV1;
  readonly lumaSoftHi?: ColorGradeAuthoredScalarV1;
  readonly qualifierInvert?: boolean;
  readonly mattePreview?: boolean;

  readonly lutAssetId?: string | null;
  readonly lutIntensity?: ColorGradeAuthoredScalarV1;
  readonly ditherStrength?: ColorGradeAuthoredScalarV1;
}

/** A static partial grade, suitable for presets and direct normalization. */
export type ColorGradeParameterPatchV1 = Readonly<
  Partial<Omit<ColorGradeResolvedParametersV1, "colorModel">>
>;

/** Static grade input; a missing model is interpreted as legacy V1. */
export type ColorGradeStaticInputV1 = ColorGradeParameterPatchV1 &
  Readonly<{ colorModel?: AuthoredColorModelV1 }>;

export interface ColorGradeEvaluatorOptions {
  /** Creative-LUT bytes. Without them the evaluator skips the LUT stage. */
  readonly lut?: CubeLut | null;
}

/** Stage-wise CPU evaluation of a grade, matching the renderer's pipeline. */
export interface ColorGradeEvaluator {
  beforeCurves(color: ColorRgb): ColorRgb;
  curves(color: ColorRgb): ColorRgb;
  afterCurves(color: ColorRgb): ColorRgb;
  composite(input: ColorRgb, graded: ColorRgb): ColorRgb;
  lut(color: ColorRgb): ColorRgb;
  apply(color: ColorRgb): ColorRgb;
}

export type ColorHistogramKind = "luma" | "red" | "green" | "blue" | "hue";
/** Each channel holds `COLOR_HISTOGRAM_BIN_COUNT` normalized bins. */
export type ColorHistograms = Readonly<Record<ColorHistogramKind, Float32Array>>;

export type ColorMatrix3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Reading, computing, and writing V1 color grades. */
export interface ExtensionColorGradeApi {
  /** Catalogue identity of the host's color grade. */
  readonly filterName: "ColorGradeFilter";
  readonly defaults: ColorGradeResolvedParametersV1;

  /**
   * Returns the authored grade carried by a transform, or `null` if the
   * transform is not a color grade. Fails closed on an unsupported color model
   * rather than coercing a future grade into V1.
   */
  parseTransform(
    transform: ExtensionTimelineTransformSnapshot,
  ): ColorGradeAuthoredParametersV1 | null;

  /** Fills defaults and clamps. Throws if any value is an animation object. */
  normalize(partial: ColorGradeStaticInputV1): ColorGradeResolvedParametersV1;

  /**
   * Clamps only the fields present, leaving the rest of a grade untouched.
   * Unknown keys are rejected. Use for partial patches such as presets.
   */
  normalizePatch(
    patch: ColorGradeParameterPatchV1,
  ): Partial<ColorGradeResolvedParametersV1>;

  /** Resolves authored animation at a source-media time, then normalizes. */
  resolve(
    authored: ColorGradeAuthoredParametersV1,
    options: { readonly sourceTime: number },
  ): ColorGradeResolvedParametersV1;

  /**
   * Builds an input for `timeline.transaction().upsertTransform()`. Pass the
   * existing `transformId` when updating a grade; omitting it creates a second
   * grade transform on the clip rather than replacing the first.
   */
  toTransformInput(
    grade: ColorGradeAuthoredParametersV1 | ColorGradeResolvedParametersV1,
    options?: {
      readonly transformId?: string;
      readonly isEnabled?: boolean;
    },
  ): ExtensionTimelineTransformInput;
}

/**
 * The host's own color implementation. Calculations performed here match the
 * renderer because they run the same code, not a reimplementation of it.
 *
 * A grade's creative LUT is referenced by asset ID only. To evaluate one with
 * full renderer parity, load the bytes out of band first:
 *
 * ```ts
 * const grade = api.color.grade.resolve(authored, { sourceTime });
 * const blob = grade.lutAssetId
 *   ? await api.assets.readBlob(grade.lutAssetId)
 *   : null;
 * const lut = blob ? api.color.parseCubeLut(await blob.text()) : null;
 * const evaluator = api.color.createReferenceColorGradeEvaluator(grade, { lut });
 * ```
 *
 * Evaluating without the LUT bytes intentionally applies only the non-LUT
 * portion of the grade.
 */
export interface ExtensionColorApi {
  readonly grade: ExtensionColorGradeApi;

  createReferenceColorGradeEvaluator(
    grade: ColorGradeResolvedParametersV1,
    options?: ColorGradeEvaluatorOptions,
  ): ColorGradeEvaluator;
  /** Grades one premultiplied RGBA pixel. */
  applyReferenceColorGradePixel(
    premultipliedColor: ColorRgba,
    grade: ColorGradeResolvedParametersV1,
    options?: ColorGradeEvaluatorOptions,
  ): ColorRgba;

  /** Bakes a grade into a `.cube` LUT that the fused grade pass can run directly. */
  bakeColorGradeCube(
    grade: ColorGradeResolvedParametersV1,
    options?: {
      readonly size?: number;
      readonly title?: string | null;
      readonly lut?: CubeLut | null;
    },
  ): CubeLut;
  parseCubeLut(text: string): CubeLut;
  serializeCubeLut(lut: CubeLut): string;
  sampleCubeLut(lut: CubeLut, color: ColorRgb): ColorRgb;
  createIdentityCubeLut(size: number): CubeLut;

  readonly COLOR_HISTOGRAM_BIN_COUNT: number;
  buildColorHistograms(pixels: ArrayLike<number>): ColorHistograms;

  createColorCurveSampler(
    points: readonly ColorCurvePoint[],
    cyclic?: boolean,
  ): ColorCurveSampler;
  bakeColorCurveLut(curves: ColorCurveSet, width?: number): Float32Array;

  srgbToLinear(color: ColorRgb): ColorRgb;
  linearToSrgb(color: ColorRgb): ColorRgb;
  whiteBalanceMatrix(temperature: number, tint: number): ColorMatrix3;
  applyMatrix3(matrix: ColorMatrix3, value: ColorRgb): ColorRgb;
}

export interface VloExtensionApi {
  /**
   * Canonical trusted fallback when scoped contributions cannot express the
   * feature. This is version-coupled host access, not a restricted facade.
   */
  readonly trusted: ExtensionTrustedApi;
  readonly runtime: ExtensionHostRuntimeApi;
  readonly backend: ExtensionBackendApi;
  readonly assets: ExtensionAssetApi;
  readonly generation: ExtensionGenerationApi;
  /** Curated color math shared with the renderer, and the V1 grade contract. */
  readonly color: ExtensionColorApi;
  /** Trusted-first scalar, keyframe-segment, and spatial-path contributions. */
  readonly animation: ExtensionAnimationApi;
  readonly payloadProviders: ExtensionPayloadProviderApi;
  /** Trusted-first, executable Pixi entity providers. */
  readonly entityProviders: ExtensionEntityProviderApi;
  readonly timeline: ExtensionTimelineApi;
  readonly transitions: ExtensionTransitionApi;
  readonly transformations: ExtensionTransformationApi;
  readonly ui: ExtensionUiApi;
}

export interface ExtensionIdentity {
  id: string;
  version: string;
}

export interface ExtensionDisposable {
  dispose(): void | Promise<void>;
}

export type ExtensionCleanup = () => void | Promise<void>;
export type ExtensionResource = ExtensionDisposable | ExtensionCleanup;

export type ExtensionDiagnosticLevel = "debug" | "info" | "warning" | "error";
export type ExtensionDiagnosticPhase =
  | "activation"
  | "runtime"
  | "deactivation";

export interface ExtensionDiagnostic {
  extensionId: string;
  level: ExtensionDiagnosticLevel;
  phase: ExtensionDiagnosticPhase;
  message: string;
  timestamp: number;
  detail?: unknown;
}

export interface ExtensionLogger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface ExtensionContext<TApi extends object = VloExtensionApi> {
  readonly extension: Readonly<ExtensionIdentity>;
  readonly sdkVersion: string;
  readonly signal: AbortSignal;
  readonly api: TApi;
  readonly logger: ExtensionLogger;
  onDispose(resource: ExtensionResource): void;
}

export interface ExtensionModule<TApi extends object = VloExtensionApi> {
  activate(
    context: ExtensionContext<TApi>,
  ): ExtensionLifecycleResult | Promise<ExtensionLifecycleResult>;
}

export type ExtensionActivationStatus =
  | "inactive"
  | "activating"
  | "active"
  | "deactivating"
  | "failed";

export interface ExtensionActivationState extends ExtensionIdentity {
  status: ExtensionActivationStatus;
  error?: unknown;
}

export interface ExtensionApiScope {
  readonly extension: Readonly<ExtensionIdentity>;
  readonly signal: AbortSignal;
  /** Application/build version shared by host compatibility and API binding. */
  readonly hostVersion?: string | null;
  own<TResource extends ExtensionResource>(resource: TResource): TResource;
  report(
    level: ExtensionDiagnosticLevel,
    message: string,
    detail?: unknown,
  ): void;
}

export type ExtensionApiFactory<TApi extends object> = (
  scope: ExtensionApiScope,
) => TApi;
