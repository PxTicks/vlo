/**
 * Shared position-path drag helpers.
 *
 * Both clip and mask interaction controllers share the same path
 * record/edit semantics: a drag captures samples, on release we either
 * commit a brand-new path or update an existing one. This module owns
 * the state shape, sample collection, build/finalize step, and overlay
 * drawing — keeping the controllers free of duplicated math.
 */

import type { Graphics } from "pixi.js";
import type { PositionPathParameter } from "../types";
import {
  evaluateOpenPath,
  processRawDragSamples,
  type Point2D,
  type RawDragSample,
} from "./catmullRomUtils";
import {
  createDefaultPathTiming,
  upsertPathControlPointAtProgress,
} from "./positionPathEditing";

export interface PositionPathDragState {
  /** Raw samples collected during a record drag. */
  rawPathSamples: RawDragSample[];
  /** Performance.now() of first sample after motion exceeded the move epsilon. */
  recordStartedAtMs: number | null;
  /** Path being edited (snapshot taken at drag start). */
  activePath: PositionPathParameter | null;
  /** Progress (0..1) into the active path corresponding to the playhead. */
  pathProgress: number | null;
  /** Index of the control point being dragged (or inserted) during edit. */
  pathEditIndex: number | null;
  /** Working copy of control points during edit. */
  draftPathControlPoints: Point2D[] | null;
  /** Live position params during the drag, in path-local coords. */
  lastPositionParams: Point2D | null;
}

export function createInitialPositionPathDragState(): PositionPathDragState {
  return {
    rawPathSamples: [],
    recordStartedAtMs: null,
    activePath: null,
    pathProgress: null,
    pathEditIndex: null,
    draftPathControlPoints: null,
    lastPositionParams: null,
  };
}

interface RecordSampleParams {
  /** Position the drag started from, in path-local coords. */
  startPosition: Point2D;
  /** Current pointer position projected into path-local coords. */
  currentPosition: Point2D;
  /** Pixi event timestamp (`e.timeStamp`). */
  eventTimeStamp: number;
  /** Whether the drag has crossed the move epsilon (caller computes). */
  hasMoved: boolean;
}

/** Append a sample during recordPath. */
export function appendRecordPathSample(
  state: PositionPathDragState,
  params: RecordSampleParams,
): void {
  state.lastPositionParams = params.currentPosition;

  if (params.hasMoved && state.recordStartedAtMs === null) {
    state.recordStartedAtMs = params.eventTimeStamp;
    state.rawPathSamples = [{ point: { ...params.startPosition }, time: 0 }];
  }

  if (state.recordStartedAtMs !== null) {
    state.rawPathSamples.push({
      point: { ...params.currentPosition },
      time: Math.max(0, params.eventTimeStamp - state.recordStartedAtMs),
    });
  }
}

interface EditSampleParams {
  /** Current pointer position projected into path-local coords. */
  currentPosition: Point2D;
  /** Allowed slack between playhead progress and a control-point's progress. */
  progressEpsilon: number;
}

/** Update the in-flight edit draft during editPath. */
export function applyEditPathSample(
  state: PositionPathDragState,
  params: EditSampleParams,
): void {
  state.lastPositionParams = params.currentPosition;
  if (!state.activePath || state.pathProgress === null) return;

  if (
    state.pathEditIndex !== null &&
    state.draftPathControlPoints &&
    state.pathEditIndex < state.draftPathControlPoints.length
  ) {
    const next = [...state.draftPathControlPoints];
    next[state.pathEditIndex] = { ...params.currentPosition };
    state.draftPathControlPoints = next;
    return;
  }

  const result = upsertPathControlPointAtProgress(
    state.activePath,
    state.pathProgress,
    { ...params.currentPosition },
    params.progressEpsilon,
  );
  state.draftPathControlPoints = result.points;
  state.pathEditIndex = result.index;
}

interface FinalizeRecordingParams {
  /** Position the drag started from. */
  startPosition: Point2D;
  /** Final position at pointer-up time. */
  finalPosition: Point2D;
  /** Catmull-Rom sample-spacing tightness in path-local units. */
  spatialEpsilon: number;
  /** Ramer-Douglas-Peucker simplification tolerance in path-local units. */
  simplifyEpsilon: number;
}

/** Build a finalized PositionPathParameter from a recordPath drag. */
export function finalizePositionPathRecording(
  state: PositionPathDragState,
  params: FinalizeRecordingParams,
): PositionPathParameter | null {
  const samples =
    state.rawPathSamples.length > 0
      ? [...state.rawPathSamples]
      : [{ point: { ...params.startPosition }, time: 0 }];

  const lastSample = samples[samples.length - 1];
  if (
    !lastSample ||
    lastSample.point.x !== params.finalPosition.x ||
    lastSample.point.y !== params.finalPosition.y
  ) {
    samples.push({
      point: { ...params.finalPosition },
      time: lastSample?.time ?? 0,
    });
  }

  const processed = processRawDragSamples(
    samples,
    params.spatialEpsilon,
    params.simplifyEpsilon,
  );
  if (processed.points.length < 2) return null;

  const defaultTiming = createDefaultPathTiming();
  const candidateTimingPoints = processed.timingSplinePoints;
  const timingPoints =
    candidateTimingPoints.length >= 2 &&
    candidateTimingPoints[0]?.time === 0 &&
    candidateTimingPoints[0]?.value === 0 &&
    candidateTimingPoints[candidateTimingPoints.length - 1]?.time === 1 &&
    candidateTimingPoints[candidateTimingPoints.length - 1]?.value === 1
      ? candidateTimingPoints
      : defaultTiming.points;

  return {
    type: "path2d",
    curve: "centripetal_catmull_rom",
    controlPoints: processed.points,
    timing: {
      type: "spline",
      points: timingPoints,
    },
  };
}

interface FinalizeEditParams {
  finalPosition: Point2D;
  progressEpsilon: number;
}

/** Compute the final control-point list after an editPath drag. */
export function finalizePositionPathEdit(
  state: PositionPathDragState,
  params: FinalizeEditParams,
): Point2D[] | null {
  if (!state.activePath || state.pathProgress === null) return null;

  if (
    state.draftPathControlPoints &&
    state.pathEditIndex !== null &&
    state.pathEditIndex < state.draftPathControlPoints.length
  ) {
    const next = [...state.draftPathControlPoints];
    next[state.pathEditIndex] = { ...params.finalPosition };
    return next;
  }

  return upsertPathControlPointAtProgress(
    state.activePath,
    state.pathProgress,
    { ...params.finalPosition },
    params.progressEpsilon,
  ).points;
}

export const PATH_OVERLAY_DEFAULTS = {
  samplesPerSegment: 18,
  curveColor: 0x60a5fa,
  provisionalColor: 0xf59e0b,
  controlPointColor: 0x1d4ed8,
  controlPointActiveColor: 0xf97316,
  markerColor: 0xffffff,
} as const;

interface DrawOverlayParams {
  controlPoints: Point2D[];
  /** Position to draw the playhead-marker dot at, in path-local coords. */
  currentPoint: Point2D;
  /** Translation applied to every drawn point — typically (0,0) for
   *  containers already aligned to the path's local space. */
  baseOrigin?: Point2D;
  /** When true, paints in provisional/orange to signal an in-flight edit. */
  isProvisional: boolean;
}

/** Draw the path overlay: curve, control points, and the playhead marker. */
export function drawPositionPathOverlay(
  graphics: Graphics,
  params: DrawOverlayParams,
): void {
  const { controlPoints, currentPoint, isProvisional } = params;
  const baseOrigin = params.baseOrigin ?? { x: 0, y: 0 };
  const curveColor = isProvisional
    ? PATH_OVERLAY_DEFAULTS.provisionalColor
    : PATH_OVERLAY_DEFAULTS.curveColor;
  const controlPointColor = isProvisional
    ? PATH_OVERLAY_DEFAULTS.controlPointActiveColor
    : PATH_OVERLAY_DEFAULTS.controlPointColor;

  if (controlPoints.length === 0) return;

  if (controlPoints.length === 1) {
    graphics
      .circle(
        baseOrigin.x + controlPoints[0].x,
        baseOrigin.y + controlPoints[0].y,
        2,
      )
      .fill({ color: curveColor, alpha: 0.9 });
    return;
  }

  let didMove = false;
  for (
    let segmentIndex = 0;
    segmentIndex < controlPoints.length - 1;
    segmentIndex += 1
  ) {
    for (
      let sampleIndex = 0;
      sampleIndex <= PATH_OVERLAY_DEFAULTS.samplesPerSegment;
      sampleIndex += 1
    ) {
      const t = sampleIndex / PATH_OVERLAY_DEFAULTS.samplesPerSegment;
      const point = evaluateOpenPath(controlPoints, segmentIndex, t, 0.5);
      const x = baseOrigin.x + point.x;
      const y = baseOrigin.y + point.y;
      if (!didMove) {
        graphics.moveTo(x, y);
        didMove = true;
      } else {
        graphics.lineTo(x, y);
      }
    }
  }

  if (didMove) {
    graphics.stroke({
      width: 2,
      color: curveColor,
      alpha: 0.9,
      cap: "round",
      join: "round",
    });
  }

  controlPoints.forEach((point) => {
    graphics
      .circle(baseOrigin.x + point.x, baseOrigin.y + point.y, 4)
      .fill({ color: controlPointColor, alpha: 1 })
      .stroke({ width: 1, color: 0xffffff, alpha: 0.9 });
  });

  graphics
    .circle(
      baseOrigin.x + currentPoint.x,
      baseOrigin.y + currentPoint.y,
      5,
    )
    .fill({ color: PATH_OVERLAY_DEFAULTS.markerColor, alpha: 1 })
    .stroke({ width: 1, color: curveColor, alpha: 1 });
}
