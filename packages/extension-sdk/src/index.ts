/*
 * How this API reports failure, so a caller can predict it without reading
 * every signature:
 *
 * - Thrown errors are your mistakes. Malformed input, an unknown or unowned
 *   ID, a contribution registered twice, a call after deactivation. These are
 *   bugs in the extension and should surface loudly in development rather than
 *   be caught and swallowed.
 * - Returned results are the editor's answer. A transaction the host refused,
 *   a command whose `when` is false, an `openView` the user has hidden. These
 *   are ordinary states of a running editor, so they come back as typed values
 *   — `ExtensionTimelineTransactionResult`, `false` — worth branching on
 *   rather than treating as errors.
 * - Diagnostics are advisory. A shadowed keybinding or an orphaned menu
 *   placement leaves the extension running; the host reports through
 *   `context.logger` and the extension manager instead of failing activation.
 *
 * Asynchronous work follows the same split: a rejected promise is a mistake, a
 * resolved typed value is an answer.
 */

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
  /**
   * Fires after the asset library changes. Commit-grained and payload-free:
   * pull detached snapshots via `list()`/`get()`. Not a render-loop signal.
   */
  subscribe(listener: () => void): () => void;
  /** Monotonic change token matching `subscribe` notifications. */
  getRevision(): number;
}

// === Extension storage ===

/**
 * One key/value scope owned by this extension. Values are finite JSON,
 * cloned in both directions. Keys are non-empty strings up to 128 chars and
 * must not contain "/".
 */
export interface ExtensionKeyValueStore {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
  /**
   * Fires after this scope changes through this API. Writes made outside the
   * running frontend (e.g. by the extension's backend half to its local
   * scope) do not notify.
   */
  subscribe(listener: () => void): () => void;
  /** Monotonic change token matching `subscribe` notifications. */
  getRevision(): number;
}

/**
 * Extension-owned persistent state (extension-shell-surfaces plan §4).
 * Neither scope participates in undo history — timeline-coupled state
 * belongs in extension payloads, not storage.
 */
export interface ExtensionStorageApi {
  /** Per-machine, per-extension; survives project switches. */
  readonly local: ExtensionKeyValueStore;
  /**
   * Travels with the project; persisted beside the other project documents
   * and retained even while the extension is uninstalled. Null when no
   * project is open.
   */
  readonly project: ExtensionKeyValueStore | null;
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

/**
 * A boolean mask equation over a clip's masks, as the host stores it. Leaves
 * name masks by their clip-local ID, matching
 * `ExtensionTimelineMaskSnapshot.localId`.
 */
export type ExtensionMaskExpression =
  | { readonly kind: "mask"; readonly maskId: string }
  | {
      readonly kind: "operation";
      readonly operator: "union" | "intersect" | "subtract";
      readonly left: ExtensionMaskExpression;
      readonly right: ExtensionMaskExpression;
    };

/** How a clip's masks combine. */
export interface ExtensionMaskCompositionSnapshot {
  /**
   * Three distinct states, spelled out rather than encoded as null vs.
   * undefined so neither can be mistaken for the other:
   *
   * - `"auto"` — no equation was authored; the host unions the clip's masks.
   *   A clip can reach this state while still carrying a composition (edge
   *   transforms or a non-default algebra), so it is not the same as having
   *   no `maskComposition` at all.
   * - `"none"` — composed masking was explicitly turned off.
   * - an expression — the authored equation.
   *
   * Narrow with `typeof expression === "string"` before walking the tree.
   */
  readonly expression: ExtensionMaskExpression | "auto" | "none";
  /**
   * The separate on/off switch: false renders the clip unmasked while keeping
   * the equation intact, so it is reversible in a way `"none"` is not.
   */
  readonly isEnabled: boolean;
  /** Whether operations evaluate in coverage or inverse ("hole") space. */
  readonly algebra: "normal" | "inverse";
}

/** A source-time window of transparency carried on the clip. */
export interface ExtensionRangeMaskSnapshot {
  readonly id: string;
  readonly startSourceTicks: number;
  readonly endSourceTicks: number;
  readonly isActive: boolean;
  readonly name?: string;
}

export interface ExtensionTimelineClipSnapshot {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly trackId: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  readonly assetId?: string;
  /**
   * Source ticks trimmed from the head — the clip's in-point. Pair with
   * `sourceDurationTicks` to know how much media is left to trim into.
   */
  readonly sourceOffsetTicks: number;
  /** Full source length, or null for unbounded media (stills, adjustments). */
  readonly sourceDurationTicks: number | null;
  /**
   * Source span this clip covers, excluding speed. Comparing it with
   * `durationTicks` tells you the clip is retimed without re-deriving the
   * speed transform.
   */
  readonly croppedSourceDurationTicks: number;
  /** Per-clip audio mute. */
  readonly isMuted: boolean;
  /** Present when the clip is a placement of a composite. */
  readonly compositeId?: string;
  /** Present when the clip's masks carry an explicit equation. */
  readonly maskComposition?: ExtensionMaskCompositionSnapshot;
  readonly rangeMasks: readonly ExtensionRangeMaskSnapshot[];
  readonly transformations: readonly ExtensionTimelineTransformSnapshot[];
}

/**
 * One timeline track, in the project's visual order. Tracks are host-owned:
 * this is a read projection, and `trackId` values on clips and entities resolve
 * against it.
 */
export interface ExtensionTimelineTrackSnapshot {
  readonly id: string;
  /** Position in the project's track order, top to bottom. */
  readonly index: number;
  readonly label: string;
  /**
   * The content class a track accepts. Legacy tracks may carry no type, which
   * the host treats as `"visual"`; those report `null` rather than guessing.
   */
  readonly type: string | null;
  readonly isVisible: boolean;
  readonly isMuted: boolean;
  readonly isLocked: boolean;
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

/** Creates one host-supported mask attached to an ordinary timeline clip. */
export interface ExtensionTimelineMaskCreateInput {
  /** Host mask type discovered through current host documentation. */
  readonly maskType: string;
  readonly name?: string;
  readonly mode?: "apply" | "preview";
  readonly inverted?: boolean;
  /** Host-owned mask parameters; currently finite positive baseWidth/baseHeight. */
  readonly parameters: Readonly<Record<string, JsonValue>>;
  /** Required for bitmap-backed mask types; ingest bytes through assets first. */
  readonly assetId?: string;
  readonly paintedBounds?: ExtensionTimelineMaskBounds;
  readonly activeRange?: ExtensionTimelineMaskActiveRange;
}

/**
 * Places one ordinary clip from a project asset. The host builds the clip from
 * the asset's own media properties; an extension supplies placement only.
 */
export interface ExtensionTimelineClipCreateInput {
  /** A project asset ID, from `assets.list()`/`get()`/`ingest()`. */
  readonly assetId: string;
  /** Optional override for the host's name (defaults to the asset's). */
  readonly name?: string;
  /**
   * Target track. Omit to let the host choose a compatible one, creating a
   * track when none fits. A named track must accept the asset's media class.
   */
  readonly trackId?: string;
  /**
   * Requested start. The host resolves overlaps exactly as it does for a user
   * drag — snapping off a neighbour's edge, refusing to land on top of one — so
   * the committed start may differ. Read it back with `listClips()`.
   */
  readonly startTicks: number;
}

/** Requested placement. Omitted fields keep their current value. */
export interface ExtensionTimelineClipPlacement {
  readonly startTicks?: number;
  readonly trackId?: string;
}

/**
 * Requested clip edges, in timeline ticks. Omitted edges are left alone.
 * Trimming changes which part of the source plays, unlike `moveClip`, which
 * slides the same content. The host clamps both edges to the media's own
 * bounds, the neighbouring clips, and the minimum clip duration.
 */
export interface ExtensionTimelineClipTrim {
  readonly startTicks?: number;
  readonly endTicks?: number;
}

/** Clip properties an extension may set. Omitted fields are left alone. */
export interface ExtensionTimelineClipUpdate {
  /** Per-clip audio mute; the audio renderer bypasses a muted clip. */
  readonly isMuted?: boolean;
}

/** Host track classes. A track's class fixes what media it accepts. */
export type ExtensionTimelineTrackType = "visual" | "audio";

export interface ExtensionTimelineTrackCreateInput {
  readonly label?: string;
  /** Omit to leave the track untyped until its first clip fixes the class. */
  readonly type?: ExtensionTimelineTrackType;
  /** Insertion position in track order; clamped. Appends when omitted. */
  readonly index?: number;
}

/** Track properties an extension may set. Omitted fields are left alone. */
export interface ExtensionTimelineTrackUpdate {
  readonly label?: string;
  readonly isVisible?: boolean;
  readonly isMuted?: boolean;
  readonly isLocked?: boolean;
}

export interface ExtensionTimelineCoalescingOptions {
  /** Fresh extension-local key for one interaction, such as one brush stroke. */
  readonly key: string;
  /** `end` closes the interaction after this transaction is committed. */
  readonly phase: "continue" | "end";
}

export interface ExtensionTimelineTransactionOptions {
  /**
   * Merge consecutive commits from one interaction into a bounded undo entry.
   * End every interaction explicitly; unrelated intervening edits split it.
   */
  readonly coalesce?: ExtensionTimelineCoalescingOptions;
}

/**
 * Commands stage *intent*; the host decides the outcome. Every structural rule
 * that keeps a project coherent — overlap resolution, trim limits, track-class
 * compatibility, mask and transition cascades — is enforced inside the host's
 * own mutation layer, using the same code paths a user's drag goes through. An
 * extension therefore cannot author an invalid timeline, and cannot opt out.
 *
 * Two consequences worth designing around:
 *
 * - A request may be **adjusted**. A placement that clips the head or tail of a
 *   neighbour snaps to that neighbour's edge, and a trim is clamped to the
 *   media's own bounds — exactly what dragging there would do. Re-read
 *   `listClips()` after the commit rather than assuming the requested value.
 * - A request may be **refused**. Where the host has no sensible correction it
 *   fails the whole transaction with a specific
 *   {@link ExtensionTimelineTransactionFailureCode} and commits nothing. Note
 *   that landing a clip *on top of* another is refused rather than adjusted
 *   (`no_free_slot`): the host blocks that for a user drag too, because any
 *   "correction" would be a guess about which side you meant.
 */
export interface ExtensionTimelineTransaction {
  /** Returns the host-generated entity ID used by later commands in this transaction. */
  createEntity(input: ExtensionTimelineEntityCreateInput): string;
  updatePayload(entityId: string, payload: ExtensionPayload): void;
  moveEntity(
    entityId: string,
    placement: { readonly startTicks?: number; readonly trackId?: string },
  ): void;
  removeEntity(entityId: string): void;
  /**
   * Places an ordinary clip from a project asset and returns its host-generated
   * ID for later commands in this transaction. The host builds the clip and
   * decides the final position; see `ExtensionTimelineClipCreateInput`.
   */
  createClip(input: ExtensionTimelineClipCreateInput): string;
  /**
   * Slides a clip without changing which part of the source plays. A start that
   * clips a neighbour snaps to that neighbour's edge; one that lands on top of
   * a clip fails with `no_free_slot`. Extension entities keep their owner
   * check — use `moveEntity` for those.
   */
  moveClip(clipId: string, placement: ExtensionTimelineClipPlacement): void;
  /**
   * Retimes a clip's edges, clamped by the host to the media bounds, the
   * neighbouring clips, and the minimum clip duration.
   */
  trimClip(clipId: string, trim: ExtensionTimelineClipTrim): void;
  /**
   * Sets clip properties that carry no structural consequences. Declarative,
   * not a toggle: state the value you want rather than reading first.
   */
  updateClip(clipId: string, update: ExtensionTimelineClipUpdate): void;
  /**
   * Cuts a clip in two at a timeline tick strictly inside it. The right-hand
   * clip is host-generated; read it back with `listClips()` after the commit.
   */
  splitClip(clipId: string, atTicks: number): void;
  /**
   * Removes an ordinary clip and its attached masks. Extension entities keep
   * their owner check — use `removeEntity` for those.
   */
  removeClip(clipId: string): void;
  /** Adds a track and returns its host-generated ID. */
  createTrack(input?: ExtensionTimelineTrackCreateInput): string;
  updateTrack(trackId: string, update: ExtensionTimelineTrackUpdate): void;
  /** Removes a track. The track must hold no clips. */
  removeTrack(trackId: string): void;
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
  /** Returns the host-generated mask-local ID used by later mask commands. */
  addClipMask(clipId: string, input: ExtensionTimelineMaskCreateInput): string;
  updateMaskParameters(
    clipId: string,
    maskId: string,
    parameters: Readonly<Record<string, JsonValue>>,
  ): void;
  setMaskActiveRange(
    clipId: string,
    maskId: string,
    range: ExtensionTimelineMaskActiveRange | null,
  ): void;
  removeMask(clipId: string, maskId: string): void;
}

export type ExtensionTimelineTransactionFailureCode =
  | "invalid_label"
  | "invalid_command"
  | "entity_not_found"
  | "clip_not_found"
  | "transition_not_found"
  | "transition_type_not_found"
  | "transform_not_found"
  | "mask_not_found"
  | "mask_type_not_supported"
  | "asset_not_found"
  | "track_not_found"
  /** The destination track's class does not accept this clip's media. */
  | "track_type_mismatch"
  /** A track must be empty before it can be removed. */
  | "track_not_empty"
  /** The clip has no legal position or size on its track. */
  | "no_free_slot"
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
  /**
   * Detached track snapshots in the project's visual order. Resolves the
   * `trackId` carried by clips, entities, and placement commands.
   */
  listTracks(): readonly ExtensionTimelineTrackSnapshot[];
  /** Detached transition snapshots for user-driven commands. */
  listTransitions(): readonly ExtensionTimelineTransitionSnapshot[];
  /** Detached mask snapshots attached to a clip. */
  listClipMasks(clipId: string): readonly ExtensionTimelineMaskSnapshot[];
  /**
   * Current render-domain dimensions and timebase, detached from host state.
   * Changes to these values signal through `subscribe`/`getRevision`, so a
   * cached copy can be refreshed rather than re-read every frame.
   */
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
    options?: ExtensionTimelineTransactionOptions,
  ): ExtensionTimelineTransactionResult;
  /**
   * Registers a per-clip timeline overlay. The registration is owner-scoped and
   * removed on disposal/deactivation.
   */
  registerClipOverlay(
    definition: ExtensionClipOverlayDefinition,
  ): ExtensionClipOverlayRegistration;
  /**
   * Fires after any committed timeline model change (undo/redo included) and
   * after any change to the values `getProject()` reports. Commit-grained and
   * payload-free: selection or in-progress interaction state does not signal
   * (use `api.selection` for that); pull detached snapshots on demand.
   * Per-frame and time-driven work belongs in the render contracts, not here.
   */
  subscribe(listener: () => void): () => void;
  /** Monotonic change token matching `subscribe` notifications. */
  getRevision(): number;
}

// === Playback ===

export type ExtensionTransportFailureCode =
  /** No player is mounted — the projects page, or an editor still booting. */
  | "no_transport"
  /**
   * Another flow owns the transport: an export or extraction is running, or a
   * frame/range capture is armed and waiting on the user.
   *
   * This is deliberately stricter than what the host allows the *user* to do —
   * the play button and the ruler stay live during a capture, because someone
   * who armed the mode can see it and decide to move anyway. An extension
   * acting in the background cannot, and moving the playhead under an armed
   * capture would silently change what gets captured.
   */
  | "transport_busy";

/** The editor's answer to a transport write. */
export type ExtensionTransportResult =
  | { readonly ok: true; readonly changed: boolean }
  | {
      readonly ok: false;
      readonly code: ExtensionTransportFailureCode;
      readonly message: string;
    };

/**
 * The transport. Reads are free; writes are requests the player may refuse,
 * because the host — not the extension — arbitrates frame snapping, the audio
 * clock, and export runs. Writes route through the same player entry points a
 * user's click uses, so an extension cannot reach a transport state the UI
 * cannot.
 */
export interface ExtensionPlaybackApi {
  /**
   * The playhead, in the canonical tick unit (`timeline.ticksPerSecond`).
   * Continuous while scrubbing — it is not snapped to a frame boundary.
   */
  getTime(): number;
  /**
   * The tick the renderer is currently presenting — what a frame-accurate
   * reader wants. During playback the displayed frame is snapped to the frame
   * grid while the playhead runs continuously, so this trails `getTime()`;
   * while paused the two agree, because a paused frame is drawn at the
   * playhead itself.
   */
  getFrameTime(): number;
  isPlaying(): boolean;
  /**
   * Moves the playhead. The tick is clamped at zero and snapped to the
   * project's frame grid, as every host seek is, so `getTime()` afterwards may
   * differ from the tick you asked for. Seeking during playback is allowed and
   * resyncs audio, matching a user scrub.
   *
   * Throws for a non-finite tick — that is a bug in the caller, not a state of
   * the editor.
   */
  seek(timeTicks: number): ExtensionTransportResult;
  /** Starts playback from the playhead. Already playing reports `changed: false`. */
  play(): ExtensionTransportResult;
  /**
   * Stops playback. Like the host's own pause, this settles the playhead on a
   * frame boundary, so a pause can move `getTime()`.
   */
  pause(): ExtensionTransportResult;
  /**
   * Fires when the playhead moves or the transport starts/stops. Unlike the
   * other domains this is **not** commit-grained: during playback it fires once
   * per frame. Keep the listener trivial — read `getTime()` and schedule your
   * own work — and prefer the render contracts for anything per-frame.
   */
  subscribe(listener: () => void): () => void;
}

// === Selection ===

/** The host's current editor selection, detached. */
export interface ExtensionSelectionSnapshot {
  /** Selected timeline clip IDs, in host selection order. */
  readonly clipIds: readonly string[];
  /** The selected transition, or null. Clips and transitions are exclusive. */
  readonly transitionId: string | null;
}

export type ExtensionSelectionFailureCode =
  | "clip_not_found"
  /** Mask clips are edited through the mask contracts, never selected. */
  | "clip_not_selectable"
  | "transition_not_found";

/** The editor's answer to a selection write. */
export type ExtensionSelectionResult =
  | { readonly ok: true; readonly changed: boolean }
  | {
      readonly ok: false;
      readonly code: ExtensionSelectionFailureCode;
      readonly message: string;
    };

/**
 * The editor selection. Kept off `api.timeline` because the timeline's signal
 * is deliberately commit-grained: selection changes are not model changes and
 * must not wake timeline subscribers.
 *
 * Writes replace the whole selection rather than adding to it — an extension
 * naming what it wants selected is predictable, while an extension toggling
 * whatever the user had selected is not. Selection is not undoable and does
 * not persist.
 */
export interface ExtensionSelectionApi {
  get(): ExtensionSelectionSnapshot;
  /**
   * Replaces the selection with these clips; an empty array clears it. IDs are
   * deduplicated, order is preserved, and any unknown or unselectable ID
   * refuses the whole request — a selection never partially applies.
   */
  setClips(clipIds: readonly string[]): ExtensionSelectionResult;
  /**
   * Selects one transition, clearing any clip selection; `null` clears the
   * selection entirely.
   */
  setTransition(transitionId: string | null): ExtensionSelectionResult;
  /** Fires after the selection changes. Payload-free; pull with `get()`. */
  subscribe(listener: () => void): () => void;
  /** Monotonic change token matching `subscribe` notifications. */
  getRevision(): number;
}

// === Project ===

/**
 * The open project's identity, detached. Deliberately path-free: an extension
 * addresses project-scoped state through `api.storage.project`, not through
 * the filesystem.
 */
export interface ExtensionProjectSnapshot {
  /** Stable across renames and reopens; the key project storage is scoped by. */
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  /** As recorded in the project manifest when it was loaded. */
  readonly lastModified: number;
  /**
   * When the project document was last written *since this project opened*, or
   * null if it has not been saved yet. Moves on every save, which is what makes
   * a save observable through the shared `subscribe`/`getRevision` pair, and
   * resets when the project closes — reopening the same project starts null
   * again rather than reporting the previous session.
   */
  readonly lastSavedAt: number | null;
}

/**
 * Project identity and lifecycle. `api.timeline.getProject()` is the
 * neighbouring read for the *render* domain — dimensions, fps, fit mode; this
 * one answers "which project, and is one open at all".
 *
 * `subscribe` also covers `api.storage.project` becoming available, so one
 * subscription is enough to watch both. They are not the same condition,
 * though: the storage document hydrates asynchronously, so a project can be
 * open while `storage.project` is still null. Re-read it inside the listener
 * rather than caching what it was when the project opened.
 */
export interface ExtensionProjectApi {
  /** The open project, or null when the editor has none. */
  get(): ExtensionProjectSnapshot | null;
  /**
   * Fires when a project opens or closes, when its identity changes, after
   * every successful save, and when project storage finishes hydrating or is
   * torn down. Payload-free; pull with `get()`.
   */
  subscribe(listener: () => void): () => void;
  /** Monotonic change token matching `subscribe` notifications. */
  getRevision(): number;
  /**
   * Runs before the host writes the project document, which is where an
   * extension flushes in-memory state into `api.storage.project` so the save
   * that follows includes it. It also runs at the head of a project switch,
   * while the outgoing project's storage is still open — that is the last
   * moment unwritten state can be saved.
   *
   * The host awaits the hook, so keep it short: a hook that throws is reported
   * as a diagnostic and skipped, and one that outlives the host's budget is
   * abandoned so a save can never hang on an extension.
   */
  onBeforeSave(hook: ExtensionProjectSaveHook): () => void;
}

export type ExtensionProjectSaveHook = () => void | Promise<void>;

// === Audio ===

/** One placed clip whose source contains audio. */
export interface ExtensionAudioClipSnapshot {
  readonly id: string;
  readonly assetId: string;
  readonly type: "audio" | "video";
  readonly trackId: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  /** Source-media in-point, before timeline retiming. */
  readonly sourceOffsetTicks: number;
  /** Cropped source-media span used by this placement, before retiming. */
  readonly croppedSourceDurationTicks: number;
  readonly isMuted: boolean;
}

/** One track that can currently produce audio. */
export interface ExtensionAudioTrackSnapshot
  extends ExtensionTimelineTrackSnapshot {
  /** Audio-bearing clip IDs on this track, in timeline order. */
  readonly clipIds: readonly string[];
}

/** Decoder metadata for one project asset's primary audio stream. */
export interface ExtensionAudioSourceSnapshot {
  readonly assetId: string;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  /**
   * True stream span (`endTimestampSeconds - firstTimestampSeconds`). This is
   * not the zero-anchored source-tick extent when the first timestamp is nonzero.
   */
  readonly durationSeconds: number;
  /** Timestamp of the first decoded sample; this may be non-zero or negative. */
  readonly firstTimestampSeconds: number;
  /**
   * Exclusive stream end and the asset's zero-anchored source-tick extent in
   * seconds. Use this field when comparing against source ticks.
   */
  readonly endTimestampSeconds: number;
  /** Maximum source frames accepted by one `readPcm()` request. */
  readonly maxPcmFramesPerRead: number;
}

export interface ExtensionAudioReadRequest {
  /** Decoder timestamp. Defaults to the stream's first timestamp. */
  readonly startSeconds?: number;
  /** Decoder timestamp. Defaults to the stream's end timestamp. */
  readonly endSeconds?: number;
  readonly signal?: AbortSignal;
}

export interface ExtensionAudioWaveformRequest extends ExtensionAudioReadRequest {
  /** Source frames summarized by each min/max pair. Defaults to 256. */
  readonly samplesPerPeak?: number;
}

export type ExtensionAudioReadFailureCode =
  | "asset_not_found"
  | "no_audio"
  | "invalid_range"
  | "range_too_large"
  | "decode_failed";

export type ExtensionAudioSourceResult =
  | { readonly ok: true; readonly source: ExtensionAudioSourceSnapshot }
  | {
      readonly ok: false;
      readonly code: ExtensionAudioReadFailureCode;
      readonly message: string;
    };

/**
 * Freshly allocated planar PCM copies. Every channel array is independently
 * owned by the caller and is never retained or reused by the host.
 */
export type ExtensionAudioPcmResult =
  | {
      readonly ok: true;
      readonly source: ExtensionAudioSourceSnapshot;
      readonly startSeconds: number;
      readonly durationSeconds: number;
      readonly channels: readonly Float32Array[];
    }
  | {
      readonly ok: false;
      readonly code: ExtensionAudioReadFailureCode;
      readonly message: string;
    };

export interface ExtensionAudioWaveformChannel {
  readonly min: Float32Array;
  readonly max: Float32Array;
}

/** Peak envelope in source order; each index covers `samplesPerPeak` frames. */
export type ExtensionAudioWaveformResult =
  | {
      readonly ok: true;
      readonly source: ExtensionAudioSourceSnapshot;
      readonly startSeconds: number;
      readonly durationSeconds: number;
      readonly samplesPerPeak: number;
      readonly channels: readonly ExtensionAudioWaveformChannel[];
    }
  | {
      readonly ok: false;
      readonly code: ExtensionAudioReadFailureCode;
      readonly message: string;
    };

/**
 * Audio model discovery and raw-source analysis. Analysis addresses assets,
 * not timeline clips: PCM is decoded before clip mute, effects, or retiming are
 * applied. Use `listClips()` to map an asset analysis back to placements.
 */
export interface ExtensionAudioApi {
  listClips(): readonly ExtensionAudioClipSnapshot[];
  getClip(clipId: string): ExtensionAudioClipSnapshot | undefined;
  listTracks(): readonly ExtensionAudioTrackSnapshot[];
  /** Commit-grained; fires when the timeline or asset library changes. */
  subscribe(listener: () => void): () => void;
  getRevision(): number;
  /**
   * Reports a typed failure when valid input cannot be inspected. A malformed
   * asset ID throws, and cancellation rejects with `AbortError`, including
   * cancellation caused by extension deactivation.
   */
  inspect(
    assetId: string,
    request?: { readonly signal?: AbortSignal },
  ): Promise<ExtensionAudioSourceResult>;
  /**
   * Decodes a bounded source range. One call is capped by the host; split long
   * analyses at `source.maxPcmFramesPerRead`, or use `readWaveform` for an
   * overview. Valid requests the host cannot satisfy return a typed failure;
   * malformed IDs/ranges throw, and cancellation rejects with `AbortError`.
   */
  readPcm(
    assetId: string,
    request?: ExtensionAudioReadRequest,
  ): Promise<ExtensionAudioPcmResult>;
  /**
   * Summarizes a bounded source range. Valid host refusals are typed results;
   * malformed IDs/ranges/peak sizes throw, and cancellation rejects with
   * `AbortError`, including cancellation caused by extension deactivation.
   */
  readWaveform(
    assetId: string,
    request?: ExtensionAudioWaveformRequest,
  ): Promise<ExtensionAudioWaveformResult>;
}

// === Export and render ===

export type ExtensionExportRunKind =
  /** The whole timeline, written to a file the user picked. */
  | "project"
  /** A tick range, landing in the asset library as a new asset. */
  | "range";

export type ExtensionExportRunStatus =
  | "running"
  | "completed"
  /** The renderer aborted — the user pressed Cancel, or a caller cancelled. */
  | "cancelled"
  | "failed";

/** One render the editor has performed or is performing, detached. */
export interface ExtensionExportRunSnapshot {
  readonly id: string;
  readonly kind: ExtensionExportRunKind;
  readonly status: ExtensionExportRunStatus;
  /** The rendered range, in the canonical tick unit. */
  readonly startTicks: number;
  readonly endTicks: number;
  /** Option ID from the `export.formats` catalogue, when the run named one. */
  readonly formatId: string | null;
  /** 0 to 1. Held at its last value once the run settles. */
  readonly progress: number;
  readonly startedAt: number;
  /** When it settled, or null while it is still running. */
  readonly endedAt: number | null;
  /**
   * The extension that started it, or null for a run the user started. Compare
   * against your own ID rather than assuming a run is yours.
   */
  readonly startedByExtension: string | null;
  /**
   * The asset the render produced, readable through `api.assets`. Null for a
   * project export, which writes to the user's file rather than the library,
   * and for any run that did not complete.
   */
  readonly assetId: string | null;
  /** Why it failed, for a failed run. */
  readonly error: string | null;
}

export type ExtensionExportFailureCode =
  /** No renderer is mounted — the projects page, or an editor still booting. */
  | "no_renderer"
  /** A render is already in flight. Renders are exclusive and nothing queues. */
  | "export_busy"
  | "no_project"
  /** Non-positive range, or one that falls outside the timeline. */
  | "invalid_range"
  /** No such option in the `export.formats` catalogue. */
  | "unknown_format"
  /** The renderer produced no frame. `message` carries what it reported. */
  | "render_failed";

export interface ExtensionExportStartRequest {
  /**
   * Option ID from the `export.formats` catalogue — enumerate it through
   * `api.ui.catalogues`. The host default is used when omitted.
   */
  readonly formatId?: string;
  /** Defaults to the whole timeline. */
  readonly startTicks?: number;
  readonly endTicks?: number;
  /** Render frame rate. The project's own rate when omitted. */
  readonly fps?: number;
  /** Renders every Nth frame; 1 renders them all. */
  readonly frameStep?: number;
  /** Restricts the render to these tracks. All tracks when omitted. */
  readonly trackIds?: readonly string[];
}

/**
 * The editor's answer to a start request — whether a run *began*, not how it
 * ended. A render takes minutes; watch the run through `subscribe`.
 */
export type ExtensionExportStartResult =
  | { readonly ok: true; readonly run: ExtensionExportRunSnapshot }
  | {
      readonly ok: false;
      readonly code: ExtensionExportFailureCode;
      readonly message: string;
    };

export interface ExtensionExportFrameRequest {
  readonly mimeType?: "image/png" | "image/webp";
  /** Encoder quality, 0 to 1, where the format honours it. */
  readonly quality?: number;
}

export type ExtensionExportFrameResult =
  | {
      readonly ok: true;
      readonly blob: Blob;
      /** The project's output dimensions, rounded to even pixels. */
      readonly width: number;
      readonly height: number;
      /** The tick that was rendered, after frame snapping. */
      readonly timeTicks: number;
    }
  | {
      readonly ok: false;
      readonly code: ExtensionExportFailureCode;
      readonly message: string;
    };

/**
 * Rendering: observing the editor's renders, reading single composited frames,
 * and asking for a render of your own.
 *
 * Renders are **exclusive** — one GPU context and one decoder pool — so this
 * domain has no queue. A request made while the renderer is busy is refused
 * with `export_busy` rather than deferred, and a run therefore never sits in a
 * pending state you have to wait through.
 *
 * `renderFrame` is a request and answers with a promise; `start` begins a run
 * and answers immediately with the run itself. That difference is deliberate:
 * a frame is a value, while a render is a long-lived thing the user can cancel
 * and other observers can watch, so its outcome arrives through the same
 * `subscribe`/`getRevision` pair every other domain uses.
 */
export interface ExtensionExportApi {
  /** The run in flight, or the most recent one to finish. Null before any. */
  getRun(): ExtensionExportRunSnapshot | null;
  /**
   * This session's runs, newest first and capped — the log is for reporting on
   * a session, not an audit trail. Persist anything you need to keep.
   */
  listRuns(): readonly ExtensionExportRunSnapshot[];
  /**
   * Fires when a run starts, reports progress, or settles, and again when the
   * renderer becomes free — the editor can still be busy for a moment after a
   * run settles, so a `start()` from inside a completion notification may be
   * refused with `export_busy`. Wait for the next notification rather than
   * treating the refusal as final. Progress-grained: during a render this
   * fires repeatedly. Payload-free; pull with `getRun()`.
   */
  subscribe(listener: () => void): () => void;
  /** Monotonic change token matching `subscribe` notifications. */
  getRevision(): number;
  /**
   * Composites one frame at `timeTicks` and returns its pixels, at the
   * project's output dimensions. This is a full render of that instant — every
   * track, mask, and effect — so it costs roughly what one export frame costs;
   * it is for thumbnails and spot checks, not for scrubbing.
   *
   * The tick is clamped at zero and snapped to the project's frame grid, as
   * every host seek is, and the result reports which tick was composited. It
   * is *not* clamped to the timeline's end: a tick past the last clip renders
   * the empty frame that is genuinely there, exactly as parking the playhead
   * beyond the content does. Derive the end from `timeline.listClips()` if you
   * need to stay inside it.
   *
   * Refused with `export_busy` while a run — or another frame render — is in
   * flight, because compositing owns the decoders. Throws for a non-finite
   * tick, which is a bug in the caller rather than a state of the editor.
   */
  renderFrame(
    timeTicks: number,
    request?: ExtensionExportFrameRequest,
  ): Promise<ExtensionExportFrameResult>;
  /**
   * Renders a range into a new library asset, reported on the run as
   * `assetId`. The user sees the host's own progress dialog and can cancel it,
   * because a background render that holds the editor for minutes with nothing
   * on screen is indistinguishable from a hang.
   *
   * Throws for a malformed request; refuses with a code when the editor cannot
   * take it.
   */
  start(request?: ExtensionExportStartRequest): ExtensionExportStartResult;
  /**
   * Cancels a run you started. The renderer aborts asynchronously, so
   * `changed: true` means a cancel was issued against a live run, not that it
   * has already settled — watch `subscribe` for that. `changed: false` means
   * the run had settled before you asked. Runs started by the user or another
   * extension are refused; the host's dialog is where those get cancelled.
   */
  cancel(runId: string): ExtensionExportCancelResult;
}

export type ExtensionExportCancelFailureCode =
  | "run_not_found"
  /** The run belongs to the user or another extension. */
  | "run_not_owned"
  | "no_renderer";

export type ExtensionExportCancelResult =
  | { readonly ok: true; readonly changed: boolean }
  | {
      readonly ok: false;
      readonly code: ExtensionExportCancelFailureCode;
      readonly message: string;
    };

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

/** Timing and parameter-resolution seam for one scheduled audio chunk. */
export interface ExtensionTrustedAudioEffectApplyContext {
  readonly audioContext: BaseAudioContext;
  readonly startContextTime: number;
  readonly wallDurationSeconds: number;
  readonly startPresentationTimeTicks: number;
  readonly durationTicks: number;
  readonly sampleCount: number;
  /** Maps presentation time through clip crop/retiming into source time. */
  sourceTimeTicksAt(presentationTimeTicks: number): number;
  /**
   * Resolves one authored parameter at a presentation tick. Numeric controls
   * that support splines are sampled in source-media time; other JSON values
   * are returned detached and unchanged.
   */
  resolveParameter(
    name: string,
    presentationTimeTicks: number,
  ): JsonValue | undefined;
}

/** One context-bound Web Audio effect occurrence owned by the host chain. */
export interface ExtensionTrustedAudioEffectInstance {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  /**
   * `parameters` is a detached snapshot of the raw authored values and must be
   * narrowed by the extension. Prefer `context.resolveParameter()` for values
   * described by controls, especially animated numeric parameters.
   */
  apply(
    parameters: Readonly<Record<string, unknown>>,
    context: ExtensionTrustedAudioEffectApplyContext,
  ): void;
  /** Releases internal resources; the host disconnects the two endpoints. */
  destroy?(): void;
}

/** Trusted Web Audio contribution, authored and placed like any other effect. */
export interface ExtensionTrustedAudioEffectTransformationDefinition
  extends ExtensionTransformationBaseDefinition {
  readonly kind: "trusted-audio-effect";
  /** Audio effects do not apply to visual adjustment groups. */
  readonly adjustmentCompatible?: false;
  readonly defaultParameters?: Readonly<Record<string, JsonValue>>;
  readonly validateParameters?: (
    parameters: Readonly<Record<string, unknown>>,
  ) => boolean;
  /** Conservative lifecycle/export preroll bound, from 0 through 60 seconds. */
  readonly maxTailSeconds?: number;
  readonly createEffect: (
    audioContext: BaseAudioContext,
  ) => ExtensionTrustedAudioEffectInstance;
}

export type ExtensionTransformationDefinition =
  | ExtensionTrustedFilterTransformationDefinition
  | ExtensionTrustedTransformationDefinition
  | ExtensionTrustedAudioEffectTransformationDefinition
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
export type ExtensionUiViewRegion =
  | "right-sidebar"
  | "left-sidebar"
  | "projects-page.main";

export interface ExtensionUiComponentProps {
  readonly slot: ExtensionUiSlotId;
}

export interface ExtensionUiModalComponentProps {
  readonly input?: JsonValue;
  close(result?: JsonValue): void;
}

export interface ExtensionUiViewComponentProps {
  /** Globally owner-qualified contribution ID. */
  readonly viewId: string;
  readonly region: ExtensionUiViewRegion;
  /** Once opened, inactive views remain mounted so local state survives. */
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
   * Executes one of this extension's own commands by local ID, or a host
   * command the host has opted in, by its full dotted ID. Resolves `true` when
   * the command ran and `false` when its `when` clause was false — a disabled
   * command is a state of the editor, not an error.
   *
   * Throws for an unregistered ID, or for a host command that has not opted
   * in: host commands are an authority surface, and contributing a menu item
   * the *user* invokes remains the intended path. No host command opts in
   * today; each grant is reviewed individually at its definition site.
   */
  execute(commandId: string, subject?: JsonValue): Promise<boolean>;
  /** Reads one host context key, detached. Unknown keys return `undefined`. */
  getContextKey(key: string): JsonValue | undefined;
  /**
   * Fires when any host context key changes. Payload-free: re-read the keys
   * you care about with `getContextKey`. Prefer a declarative `when` on the
   * command itself — this is for extension-owned UI that has to mirror host
   * enablement, not for gating execution.
   */
  subscribeContextKeys(listener: () => void): () => void;
}

/**
 * One option contributed to a host-declared catalogue (a named, extensible
 * option list behind a host dropdown). `value` must satisfy the catalogue's
 * declared value schema — catalogues are not a generic data bus — and is
 * cloned and frozen on registration. `when` gates visibility over host
 * context keys.
 */
export interface ExtensionCatalogueOptionContribution {
  /** Local ID; the host qualifies it as `extensionId/id`. */
  readonly id: string;
  readonly apiVersion: 1;
  /** Host catalogue ID; discover catalogues via `catalogues.listCatalogues()`. */
  readonly catalogueId: string;
  readonly label: string;
  readonly value: JsonValue;
  readonly order?: number;
  readonly when?: ExtensionContextKeyExpression;
}

/** A catalogue option as read back through the API, detached. */
export interface ExtensionCatalogueOptionView {
  readonly id: string;
  readonly label: string;
  readonly value: JsonValue;
  readonly order: number;
}

/** One host catalogue extensions can contribute to, with value discovery. */
export interface ExtensionCatalogueInfo {
  readonly id: string;
  /**
   * Host-owned, serialisable structural description of the catalogue's
   * option values. Documentation-grade: the host's value validation is
   * authoritative.
   */
  readonly valueSchema: JsonValue;
}

export interface ExtensionCatalogueApi {
  /** Contribute one option to a host catalogue. */
  addOption(
    option: ExtensionCatalogueOptionContribution,
  ): ExtensionUiRegistration;
  /** Currently visible options of one catalogue (host and extension), detached. */
  list(catalogueId: string): readonly ExtensionCatalogueOptionView[];
  /** Enumerate catalogue IDs the host has declared, with value schema info. */
  listCatalogues(): readonly ExtensionCatalogueInfo[];
  /**
   * Fires when any catalogue's contents change — including options registered
   * by *other* extensions, which is why polling `list()` is not enough for UI
   * built on a catalogue.
   */
  subscribe(listener: () => void): () => void;
  /** Monotonic change token matching `subscribe` notifications. */
  getRevision(): number;
}

export interface ExtensionCanvasPointerEvent {
  readonly kind: "down" | "move" | "up" | "cancel";
  /** Project pixels in the player viewport's top-left-origin coordinate space. */
  readonly projectPoint: ExtensionPoint2D;
  readonly screenPoint: ExtensionPoint2D;
  readonly pressure: number;
  readonly buttons: number;
  readonly modifiers: {
    readonly shift: boolean;
    readonly alt: boolean;
    readonly ctrl: boolean;
    readonly meta: boolean;
  };
}

export interface ExtensionCanvasToolSession {
  /** Host-owned transient Pixi container, emptied when the tool deactivates. */
  readonly overlay: object;
  /** Clip selected when this tool became active, before host selection paused. */
  readonly targetClipId: string | null;
  projectToScreen(point: ExtensionPoint2D): ExtensionPoint2D;
  screenToProject(point: ExtensionPoint2D): ExtensionPoint2D;
  requestRender(): void;
}

export interface ExtensionCanvasToolDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly label: string;
  readonly icon?: () => unknown;
  readonly cursor?: string;
  readonly when?: ExtensionContextKeyExpression;
  activate(session: ExtensionCanvasToolSession): void;
  deactivate(): void;
  onPointer(event: ExtensionCanvasPointerEvent): void;
}

export interface ExtensionCanvasToolRegistration extends ExtensionUiRegistration {
  /** Local command ID for keybinding requests. */
  readonly command: string;
}

export interface ExtensionCanvasToolApi {
  register(
    definition: ExtensionCanvasToolDefinition,
  ): ExtensionCanvasToolRegistration;
}

export interface ExtensionUiApi {
  /** The host command table and chord requests (see `ExtensionCommandApi`). */
  readonly commands: ExtensionCommandApi;
  /** Command placements in host menus (see `ExtensionMenuApi`). */
  readonly menus: ExtensionMenuApi;
  /** Option contributions to host dropdown catalogues (see `ExtensionCatalogueApi`). */
  readonly catalogues: ExtensionCatalogueApi;
  /** Exclusive trusted interaction modes over the player canvas. */
  readonly canvasTools: ExtensionCanvasToolApi;
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
  /** Registers a trusted view in one host-owned shell region. */
  registerView(
    definition: ExtensionTrustedUiViewDefinition,
  ): ExtensionUiRegistration;
  /** Opens one modal registered by the calling extension. */
  openModal(id: string, input?: JsonValue): Promise<JsonValue | undefined>;
  /** Selects one visible view registered by the calling extension. */
  openView(id: string): boolean;
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

/** Arbitrary trusted React rendered in a host-owned shell region. */
export interface ExtensionTrustedUiViewDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly kind: "trusted-view";
  readonly title: string;
  readonly icon?: () => unknown;
  readonly defaultRegion: ExtensionUiViewRegion;
  readonly order?: number;
  readonly when?: ExtensionContextKeyExpression;
  readonly component: (props: ExtensionUiViewComponentProps) => unknown;
}

/**
 * Declarative visibility predicate for one menu placement, evaluated by the
 * host against context keys and the menu's detached subject. Menu placements
 * never carry executable visibility callbacks, so conditions stay evaluable
 * in a future restricted profile.
 */
export type ExtensionMenuCondition =
  | { readonly context: ExtensionContextKeyExpression }
  | {
      readonly subject: {
        /** JSON object path; a missing path makes the predicate false. */
        readonly path: readonly string[];
        readonly equals?: JsonValue; // omitted means a truthy test
      };
    }
  | { readonly not: ExtensionMenuCondition }
  | { readonly all: readonly ExtensionMenuCondition[] }
  | { readonly any: readonly ExtensionMenuCondition[] };

/**
 * Places one of this extension's registered commands in a host menu. The host
 * renders the native item from the command definition (title, icon,
 * enablement via the command's `when`); invoking it executes the command with
 * the menu's schema-validated subject as detached `JsonValue`. Registration
 * rejects unknown menu IDs and commands not registered by the same extension;
 * disposing the command makes a remaining placement inert with a diagnostic
 * until the placement is disposed.
 */
export interface ExtensionMenuCommandContribution {
  readonly id: string;
  readonly apiVersion: 1;
  /** Host menu ID; discover catalogued menus via `menus.listMenus()`. */
  readonly menuId: string;
  readonly kind: "command";
  /** Local ID of a command already registered by this extension. */
  readonly command: string;
  /** Ordering group, e.g. "9_extensions". Groups sort lexically. */
  readonly group: string;
  readonly order?: number;
  /** Visibility only; command-level `when` still governs enablement everywhere. */
  readonly when?: ExtensionMenuCondition;
}

/** One host menu extensions can contribute to, with subject discovery info. */
export interface ExtensionMenuInfo {
  readonly id: string;
  /**
   * Host-owned, serialisable structural description of the menu's detached
   * subject (field paths to type-name strings). Documentation-grade: the
   * host's subject schema validation is authoritative.
   */
  readonly subjectSchema: JsonValue;
}

export interface ExtensionMenuApi {
  /** Place one of this extension's registered commands in a host menu. */
  addItem(definition: ExtensionMenuCommandContribution): ExtensionUiRegistration;
  /** Enumerate menu IDs the host has catalogued, with subject schema info. */
  listMenus(): readonly ExtensionMenuInfo[];
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
  /** Extension-owned persistent key/value state (local and project scopes). */
  readonly storage: ExtensionStorageApi;
  readonly generation: ExtensionGenerationApi;
  /** Curated color math shared with the renderer, and the V1 grade contract. */
  readonly color: ExtensionColorApi;
  /** Trusted-first scalar, keyframe-segment, and spatial-path contributions. */
  readonly animation: ExtensionAnimationApi;
  readonly payloadProviders: ExtensionPayloadProviderApi;
  /** Trusted-first, executable Pixi entity providers. */
  readonly entityProviders: ExtensionEntityProviderApi;
  readonly timeline: ExtensionTimelineApi;
  /** The transport: playhead, presented frame, running state, and writes. */
  readonly playback: ExtensionPlaybackApi;
  /** The editor selection, readable and settable. */
  readonly selection: ExtensionSelectionApi;
  /** Project identity and lifecycle; the scope `storage.project` follows. */
  readonly project: ExtensionProjectApi;
  /** Audio-bearing model projection and raw-source analysis. */
  readonly audio: ExtensionAudioApi;
  /** Renders: observing them, reading frames, and starting one. */
  readonly export: ExtensionExportApi;
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
