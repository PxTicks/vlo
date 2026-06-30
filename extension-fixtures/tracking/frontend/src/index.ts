import type {
  ExtensionBackendJobSnapshot,
  ExtensionCompiledSpatialPath,
  ExtensionModule,
  ExtensionPoint2D,
  ExtensionReactRuntime,
  ExtensionSpatialPathParameter,
  ExtensionTimelineApi,
  ExtensionTimelineClipSnapshot,
  ExtensionTimelineTransactionResult,
  JsonValue,
  VloExtensionApi,
} from "@vlo/extension-sdk";

const PATH_TYPE_ID = "tracking-path";

export interface TrackingSample {
  readonly frameIndex: number;
  readonly x: number;
  readonly y: number;
  readonly confidence: number;
}

export interface TrackingResult {
  readonly schemaVersion: 1;
  readonly coordinateSpace: "source-pixels";
  readonly sourceDimensions: Readonly<{ width: number; height: number }>;
  readonly timebase: Readonly<{ kind: "frames"; fps: number }>;
  readonly sourceWindow: Readonly<{ startTicks: number; endTicks: number }>;
  readonly target: Readonly<{ id: string; label: string }>;
  readonly samples: readonly TrackingSample[];
  readonly artifactId: string;
}

interface TrackingPathPoint extends ExtensionPoint2D {
  readonly progress: number;
  readonly sourceFrameIndex: number;
  readonly sourceTimeTicks: number;
  readonly confidence: number;
}

interface TrackingPathData {
  readonly durationTicks: number;
  readonly points: readonly TrackingPathPoint[];
}

export interface TrackingRunCallbacks {
  readonly onSubmitted?: (jobId: string) => void;
  readonly onProgress?: (snapshot: ExtensionBackendJobSnapshot) => void;
}

interface ReactHooksRuntime extends ExtensionReactRuntime {
  useState<T>(initial: T): [T, (next: T | ((current: T) => T)) => void];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite.`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result <= 0) throw new Error(`${label} must be positive.`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (!Number.isInteger(result) || result < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return result;
}

export function parseTrackingResult(
  value: unknown,
  artifactId?: string,
): TrackingResult {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Tracking result must use schemaVersion 1.");
  }
  if (value.coordinateSpace !== "source-pixels") {
    throw new Error("Tracking result uses an unsupported coordinate space.");
  }
  if (
    !isRecord(value.sourceDimensions) ||
    !isRecord(value.timebase) ||
    !isRecord(value.sourceWindow)
  ) {
    throw new Error("Tracking result has no source dimensions or timebase.");
  }
  if (value.timebase.kind !== "frames") {
    throw new Error("Tracking result uses an unsupported timebase.");
  }
  if (!isRecord(value.target) || typeof value.target.id !== "string") {
    throw new Error("Tracking result target is invalid.");
  }
  if (typeof value.target.label !== "string" || !Array.isArray(value.samples)) {
    throw new Error("Tracking result samples are invalid.");
  }
  const samples = value.samples.map((sample, index): TrackingSample => {
    if (!isRecord(sample)) throw new Error(`Tracking sample ${index} is invalid.`);
    const confidence = finiteNumber(
      sample.confidence,
      `Tracking sample ${index} confidence`,
    );
    if (confidence < 0 || confidence > 1) {
      throw new Error(`Tracking sample ${index} confidence must be in [0, 1].`);
    }
    return Object.freeze({
      frameIndex: nonNegativeInteger(
        sample.frameIndex,
        `Tracking sample ${index} frameIndex`,
      ),
      x: finiteNumber(sample.x, `Tracking sample ${index} x`),
      y: finiteNumber(sample.y, `Tracking sample ${index} y`),
      confidence,
    });
  });
  if (samples.length < 2) throw new Error("Tracking requires at least two samples.");
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].frameIndex < samples[index - 1].frameIndex) {
      throw new Error("Tracking frame indices must be ordered.");
    }
  }
  const inlineArtifactId =
    typeof value.artifactId === "string" ? value.artifactId : undefined;
  const resolvedArtifactId = artifactId ?? inlineArtifactId;
  if (!resolvedArtifactId || !/^[0-9a-f]{32}$/.test(resolvedArtifactId)) {
    throw new Error("Tracking result has no valid result artifact.");
  }
  const sourceStartTicks = nonNegativeInteger(
    value.sourceWindow.startTicks,
    "Source window start",
  );
  const sourceEndTicks = positiveNumber(
    value.sourceWindow.endTicks,
    "Source window end",
  );
  if (sourceEndTicks <= sourceStartTicks) {
    throw new Error("Source window end must be after its start.");
  }
  return Object.freeze({
    schemaVersion: 1,
    coordinateSpace: "source-pixels",
    sourceDimensions: Object.freeze({
      width: positiveNumber(value.sourceDimensions.width, "Source width"),
      height: positiveNumber(value.sourceDimensions.height, "Source height"),
    }),
    timebase: Object.freeze({
      kind: "frames",
      fps: positiveNumber(value.timebase.fps, "Source FPS"),
    }),
    sourceWindow: Object.freeze({
      startTicks: sourceStartTicks,
      endTicks: sourceEndTicks,
    }),
    target: Object.freeze({ id: value.target.id, label: value.target.label }),
    samples: Object.freeze(samples),
    artifactId: resolvedArtifactId,
  });
}

function trackingPathData(value: JsonValue): TrackingPathData {
  if (!isRecord(value) || !Array.isArray(value.points)) {
    throw new Error("Tracking path data must contain points.");
  }
  const durationTicks = positiveNumber(value.durationTicks, "Path duration");
  const points = value.points.map((point, index): TrackingPathPoint => {
    if (!isRecord(point)) throw new Error(`Path point ${index} is invalid.`);
    const progress = finiteNumber(point.progress, `Path point ${index} progress`);
    if (progress < 0 || progress > 1) {
      throw new Error(`Path point ${index} progress must be in [0, 1].`);
    }
    return {
      progress,
      x: finiteNumber(point.x, `Path point ${index} x`),
      y: finiteNumber(point.y, `Path point ${index} y`),
      sourceFrameIndex: nonNegativeInteger(
        point.sourceFrameIndex,
        `Path point ${index} sourceFrameIndex`,
      ),
      sourceTimeTicks: nonNegativeInteger(
        point.sourceTimeTicks,
        `Path point ${index} sourceTimeTicks`,
      ),
      confidence: finiteNumber(
        point.confidence,
        `Path point ${index} confidence`,
      ),
    };
  });
  if (points.length < 2) throw new Error("Tracking path requires two points.");
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].progress < points[index - 1].progress) {
      throw new Error("Tracking path progress must be ordered.");
    }
  }
  return { durationTicks, points };
}

function interpolatePath(
  points: readonly TrackingPathPoint[],
  requestedProgress: number,
): ExtensionPoint2D {
  const progress = Math.max(0, Math.min(1, requestedProgress));
  const upperIndex = points.findIndex((point) => point.progress >= progress);
  if (upperIndex <= 0) return { x: points[0].x, y: points[0].y };
  const lower = points[upperIndex - 1];
  const upper = points[upperIndex];
  const span = upper.progress - lower.progress;
  const fraction = span > 0 ? (progress - lower.progress) / span : 0;
  return {
    x: lower.x + (upper.x - lower.x) * fraction,
    y: lower.y + (upper.y - lower.y) * fraction,
  };
}

export function createTrackingPath(
  timeline: ExtensionTimelineApi,
  clipId: string,
  result: TrackingResult,
): ExtensionSpatialPathParameter {
  const clip = timeline.listClips().find((candidate) => candidate.id === clipId);
  if (!clip) throw new Error(`Timeline clip '${clipId}' was not found.`);
  const points = result.samples.map((sample): TrackingPathPoint => {
    const sourceTimeTicks = timeline.sourceFrameToTicks(
      sample.frameIndex,
      result.timebase.fps,
    );
    const point = timeline.sourcePointToProject(
      sample,
      result.sourceDimensions,
    );
    return {
      ...point,
      progress: timeline.sourceTicksToClipProgress(clipId, sourceTimeTicks),
      sourceFrameIndex: sample.frameIndex,
      sourceTimeTicks,
      confidence: sample.confidence,
    };
  });
  return {
    type: "extension-path2d",
    geometry: {
      extensionId: "example.tracking",
      typeId: PATH_TYPE_ID,
      schemaVersion: 1,
      data: {
        durationTicks: clip.durationTicks,
        points: points.map((point) => ({
          progress: point.progress,
          x: point.x,
          y: point.y,
          sourceFrameIndex: point.sourceFrameIndex,
          sourceTimeTicks: point.sourceTimeTicks,
          confidence: point.confidence,
        })),
      },
    },
    timing: {
      type: "extension-keyframed-scalar",
      keyframes: [
        {
          time: 0,
          value: 0,
          outgoing: {
            extensionId: "vlo.core",
            typeId: "monotone-cubic",
            schemaVersion: 1,
            data: null,
          },
        },
        { time: 1, value: 1 },
      ],
    },
  };
}

export function commitTrackingResult(
  timeline: ExtensionTimelineApi,
  clipId: string,
  result: TrackingResult,
): ExtensionTimelineTransactionResult {
  const clip = timeline.listClips().find((candidate) => candidate.id === clipId);
  if (!clip) {
    return {
      ok: false,
      code: "clip_not_found",
      message: `Timeline clip '${clipId}' was not found.`,
      label: "Apply tracking path",
    };
  }
  const existing = clip.transformations.find(
    (transform) => transform.type === "position",
  );
  // The SDK's nominal path interfaces are narrower than its JSON index type;
  // this value has just been constructed entirely from finite JSON fields.
  const extensionPath = JSON.parse(
    JSON.stringify(createTrackingPath(timeline, clipId, result)),
  ) as JsonValue;
  return timeline.transaction("Apply tracking path", (transaction) => {
    transaction.upsertTransform(clipId, {
      id: existing?.id ?? `tracking-position-${clipId}`,
      type: "position",
      isEnabled: existing?.isEnabled ?? true,
      parameters: {
        ...(existing?.parameters ?? {}),
        x: existing?.parameters.x ?? 0,
        y: existing?.parameters.y ?? 0,
        extensionPath,
      },
    });
  });
}

export async function runTrackingJob(
  api: VloExtensionApi,
  clip: ExtensionTimelineClipSnapshot,
  callbacks: TrackingRunCallbacks = {},
): Promise<TrackingResult> {
  if (!clip.assetId) throw new Error("Tracking requires an asset-backed clip.");
  const asset = api.assets.get(clip.assetId);
  if (!asset) throw new Error(`Asset '${clip.assetId}' was not found.`);
  const jobType = (await api.backend.listJobs()).find(
    (candidate) => candidate.id === "track",
  );
  if (!jobType) throw new Error("Tracking backend job is unavailable.");
  if (!jobType.readiness.ready) throw new Error(jobType.readiness.message);
  const project = api.timeline.getProject();
  const source = await api.assets.readBlob(asset.id);
  const uploaded = await api.backend.uploadArtifact(source, {
    filename: asset.name,
    contentType: source.type || "application/octet-stream",
  });
  const submitted = await api.backend.submitJob(
    "track",
    {
      schemaVersion: 1,
      sampleCount: 24,
      source: {
        width: project.width,
        height: project.height,
        fps: asset.fps ?? project.fps,
        startTicks: api.timeline.clipProgressToSourceTicks(clip.id, 0),
        endTicks: api.timeline.clipProgressToSourceTicks(clip.id, 1),
        ticksPerSecond: api.timeline.ticksPerSecond,
      },
      target: { id: "fixture-object", label: "Fixture object" },
    },
    [uploaded.artifactId],
  );
  callbacks.onSubmitted?.(submitted.jobId);
  const completed = await api.backend.waitForJob(submitted.jobId, {
    onProgress: callbacks.onProgress,
  });
  if (completed.status !== "succeeded") {
    throw new Error(completed.error ?? `Tracking ${completed.status}.`);
  }
  const inline = parseTrackingResult(completed.result);
  const artifact = await api.backend.getArtifact(inline.artifactId);
  const persisted = parseTrackingResult(
    JSON.parse(await artifact.text()) as unknown,
    inline.artifactId,
  );
  if (JSON.stringify(persisted) !== JSON.stringify(inline)) {
    throw new Error("Tracking artifact does not match the validated job result.");
  }
  return persisted;
}

function previewPolyline(
  timeline: ExtensionTimelineApi,
  clipId: string,
  result: TrackingResult,
): string {
  const project = timeline.getProject();
  const path = createTrackingPath(timeline, clipId, result);
  const data = trackingPathData(path.geometry.data);
  return data.points
    .map((point) => {
      const x = ((point.x + project.width / 2) / project.width) * 220;
      const y = ((point.y + project.height / 2) / project.height) * 120;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function createTrackingPanel(api: VloExtensionApi, React: ReactHooksRuntime) {
  return function TrackingPanel(): unknown {
    const [status, setStatus] = React.useState("Ready to track");
    const [progress, setProgress] = React.useState(0);
    const [activeJobId, setActiveJobId] = React.useState<string | null>(null);
    const [preview, setPreview] = React.useState<TrackingResult | null>(null);
    const clip = api.timeline.listClips().find((candidate) => candidate.assetId);

    const start = async () => {
      if (!clip) {
        setStatus("Add an asset-backed clip before tracking.");
        return;
      }
      setPreview(null);
      setProgress(0);
      setStatus("Uploading source…");
      try {
        const result = await runTrackingJob(api, clip, {
          onSubmitted: (jobId) => {
            setActiveJobId(jobId);
            setStatus("Tracking…");
          },
          onProgress: (snapshot) => {
            setProgress(snapshot.progress);
            setStatus(snapshot.message);
          },
        });
        setPreview(result);
        setStatus("Preview ready; the timeline is unchanged.");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        setActiveJobId(null);
      }
    };

    const cancel = async () => {
      if (!activeJobId) return;
      const snapshot = await api.backend.cancelJob(activeJobId);
      setStatus(snapshot.message);
    };

    const apply = () => {
      if (!clip || !preview) return;
      const committed = commitTrackingResult(api.timeline, clip.id, preview);
      setStatus(committed.ok ? "Tracking path committed." : committed.message);
    };

    return React.createElement(
      "section",
      { "data-extension": "example.tracking" },
      React.createElement("strong", null, "Tracking conformance fixture"),
      React.createElement("p", null, status),
      React.createElement("progress", { max: 1, value: progress }),
      React.createElement(
        "button",
        { type: "button", disabled: Boolean(activeJobId), onClick: () => void start() },
        "Run tracking",
      ),
      activeJobId
        ? React.createElement(
            "button",
            { type: "button", onClick: () => void cancel() },
            "Cancel",
          )
        : null,
      preview && clip
        ? React.createElement(
            "div",
            { "data-tracking-preview": true },
            React.createElement(
              "svg",
              { viewBox: "0 0 220 120", width: 220, height: 120 },
              React.createElement("polyline", {
                points: previewPolyline(api.timeline, clip.id, preview),
                fill: "none",
                stroke: "currentColor",
                strokeWidth: 2,
              }),
            ),
            React.createElement(
              "button",
              { type: "button", onClick: apply },
              "Apply path as one undoable change",
            ),
          )
        : null,
    );
  };
}

export const activate: ExtensionModule["activate"] = (context) => {
  context.api.animation.spatialPaths.register({
    id: PATH_TYPE_ID,
    apiVersion: 1,
    label: "Tracked motion samples",
    schemaVersion: 1,
    defaultData: {
      durationTicks: 1,
      points: [
        { progress: 0, x: 0, y: 0, sourceFrameIndex: 0, sourceTimeTicks: 0, confidence: 1 },
        { progress: 1, x: 0, y: 0, sourceFrameIndex: 1, sourceTimeTicks: 1, confidence: 1 },
      ],
    },
    validate: (data) => {
      trackingPathData(data);
    },
    compile: (data): ExtensionCompiledSpatialPath => {
      const path = trackingPathData(data);
      return {
        pointAt: (progress) => interpolatePath(path.points, progress),
        getBounds: () => {
          const xs = path.points.map((point) => point.x);
          const ys = path.points.map((point) => point.y);
          const x = Math.min(...xs);
          const y = Math.min(...ys);
          return {
            x,
            y,
            width: Math.max(...xs) - x,
            height: Math.max(...ys) - y,
          };
        },
        dispose: () => undefined,
      };
    },
    reverse: (data) => {
      const path = trackingPathData(data);
      return {
        schemaVersion: 1,
        data: {
          durationTicks: path.durationTicks,
          points: [...path.points]
            .reverse()
            .map((point) => ({ ...point, progress: 1 - point.progress })),
        },
      };
    },
  });

  const React = context.api.runtime.react as ReactHooksRuntime;
  context.api.ui.registerComponent({
    id: "tracking-panel",
    apiVersion: 1,
    slot: "transformation-panel.before",
    kind: "trusted-react",
    component: createTrackingPanel(context.api, React),
  });
  context.logger.info("Tracking conformance frontend activated.");
};
