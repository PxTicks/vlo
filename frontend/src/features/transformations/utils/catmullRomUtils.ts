export interface Point2D {
  x: number;
  y: number;
}

export function distanceSq(p1: Point2D, p2: Point2D): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return dx * dx + dy * dy;
}

export function distance(p1: Point2D, p2: Point2D): number {
  return Math.sqrt(distanceSq(p1, p2));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Evaluates a Catmull-Rom spline at parameter t in [0, 1] between p1 and p2.
 * p0 and p3 are the outer control points.
 * alpha: 0.0 for uniform, 0.5 for centripetal (default), 1.0 for chordal.
 */
export function evaluateCatmullRom(
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  t: number,
  alpha: number = 0.5
): Point2D {
  if (t <= 0) return { x: p1.x, y: p1.y };
  if (t >= 1) return { x: p2.x, y: p2.y };

  // Use a small epsilon to prevent division by zero for coincident control points
  const t0 = 0.0;
  const t1 = t0 + Math.max(1e-6, Math.pow(distanceSq(p0, p1), alpha * 0.5));
  const t2 = t1 + Math.max(1e-6, Math.pow(distanceSq(p1, p2), alpha * 0.5));
  const t3 = t2 + Math.max(1e-6, Math.pow(distanceSq(p2, p3), alpha * 0.5));

  const tt = t1 + t * (t2 - t1);

  const A1x = ((t1 - tt) / (t1 - t0)) * p0.x + ((tt - t0) / (t1 - t0)) * p1.x;
  const A1y = ((t1 - tt) / (t1 - t0)) * p0.y + ((tt - t0) / (t1 - t0)) * p1.y;

  const A2x = ((t2 - tt) / (t2 - t1)) * p1.x + ((tt - t1) / (t2 - t1)) * p2.x;
  const A2y = ((t2 - tt) / (t2 - t1)) * p1.y + ((tt - t1) / (t2 - t1)) * p2.y;

  const A3x = ((t3 - tt) / (t3 - t2)) * p2.x + ((tt - t2) / (t3 - t2)) * p3.x;
  const A3y = ((t3 - tt) / (t3 - t2)) * p2.y + ((tt - t2) / (t3 - t2)) * p3.y;

  const B1x = ((t2 - tt) / (t2 - t0)) * A1x + ((tt - t0) / (t2 - t0)) * A2x;
  const B1y = ((t2 - tt) / (t2 - t0)) * A1y + ((tt - t0) / (t2 - t0)) * A2y;

  const B2x = ((t3 - tt) / (t3 - t1)) * A2x + ((tt - t1) / (t3 - t1)) * A3x;
  const B2y = ((t3 - tt) / (t3 - t1)) * A2y + ((tt - t1) / (t3 - t1)) * A3y;

  const Cx = ((t2 - tt) / (t2 - t1)) * B1x + ((tt - t1) / (t2 - t1)) * B2x;
  const Cy = ((t2 - tt) / (t2 - t1)) * B1y + ((tt - t1) / (t2 - t1)) * B2y;

  return { x: Cx, y: Cy };
}

/**
 * Evaluates an open path, creating virtual control points at the ends if needed.
 */
export function evaluateOpenPath(points: Point2D[], segmentIndex: number, t: number, alpha: number = 0.5): Point2D {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { x: points[0].x, y: points[0].y };

  const p1 = points[segmentIndex];
  const p2 = points[segmentIndex + 1];

  const p0 = segmentIndex > 0 
    ? points[segmentIndex - 1] 
    : { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
  
  const p3 = segmentIndex < points.length - 2 
    ? points[segmentIndex + 2] 
    : { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };

  return evaluateCatmullRom(p0, p1, p2, p3, t, alpha);
}

export interface ArcLengthEntry {
  segmentIndex: number;
  t: number;
  length: number;
}

/**
 * Generates an arc-length lookup table to map from distance to (segment, t) pairs.
 */
export function generateArcLengthTable(points: Point2D[], samplesPerSegment: number = 10, alpha: number = 0.5): ArcLengthEntry[] {
  const table: ArcLengthEntry[] = [];
  if (points.length < 2) {
    if (points.length === 1) {
      table.push({ segmentIndex: 0, t: 0, length: 0 });
    }
    return table;
  }

  table.push({ segmentIndex: 0, t: 0, length: 0 });
  let currentLength = 0;
  let prevPoint = points[0];

  for (let i = 0; i < points.length - 1; i++) {
    for (let s = 1; s <= samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const pt = evaluateOpenPath(points, i, t, alpha);
      currentLength += distance(prevPoint, pt);
      table.push({ segmentIndex: i, t, length: currentLength });
      prevPoint = pt;
    }
  }

  return table;
}

/**
 * Samples a point on the path at normalized progress u [0, 1].
 */
export function samplePathAtProgress(points: Point2D[], table: ArcLengthEntry[], u: number, alpha: number = 0.5): Point2D {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { x: points[0].x, y: points[0].y };
  if (table.length === 0) return points[0];

  u = Math.max(0, Math.min(1, u));
  const totalLength = table[table.length - 1].length;
  if (totalLength === 0) return points[0];

  const targetLength = u * totalLength;

  let low = 0;
  let high = table.length - 1;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (table[mid].length < targetLength) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  if (low === 0) return evaluateOpenPath(points, table[0].segmentIndex, table[0].t, alpha);

  const entry0 = table[low - 1];
  const entry1 = table[low];

  const lengthDiff = entry1.length - entry0.length;
  if (lengthDiff === 0) return evaluateOpenPath(points, entry1.segmentIndex, entry1.t, alpha);

  const localFraction = (targetLength - entry0.length) / lengthDiff;

  if (entry0.segmentIndex === entry1.segmentIndex) {
    const interpT = entry0.t + localFraction * (entry1.t - entry0.t);
    return evaluateOpenPath(points, entry0.segmentIndex, interpT, alpha);
  } else {
    // Spanning segments (only happens when crossing from t=1.0 of seg i to t>0 of seg i+1)
    const interpT = localFraction * entry1.t;
    return evaluateOpenPath(points, entry1.segmentIndex, interpT, alpha);
  }
}

export function getInsertionIndexForProgress(
  points: Point2D[],
  table: ArcLengthEntry[],
  u: number,
): number {
  if (points.length < 2 || table.length === 0) {
    return Math.max(0, points.length - 1);
  }

  const normalizedProgress = Math.max(0, Math.min(1, u));
  const totalLength = table[table.length - 1].length;
  const targetLength = normalizedProgress * totalLength;

  let insertIndex = points.length - 1;
  for (let i = 0; i < points.length - 1; i++) {
    let endLength = 0;
    for (let j = table.length - 1; j >= 0; j--) {
      if (table[j].segmentIndex === i && table[j].t === 1.0) {
        endLength = table[j].length;
        break;
      }
    }

    if (targetLength <= endLength) {
      insertIndex = i + 1;
      break;
    }
  }

  return insertIndex;
}

export interface InsertControlPointResult {
  points: Point2D[];
  index: number;
}

export function insertControlPointWithIndex(
  points: Point2D[],
  table: ArcLengthEntry[],
  u: number,
  alpha: number = 0.5,
): InsertControlPointResult {
  if (points.length < 2) {
    return {
      points: [...points],
      index: Math.max(0, points.length - 1),
    };
  }
  if (u <= 0 || u >= 1) {
    return {
      points: [...points],
      index: u <= 0 ? 0 : points.length - 1,
    };
  }

  const insertIndex = getInsertionIndexForProgress(points, table, u);
  const newPt = samplePathAtProgress(points, table, u, alpha);
  const newPoints = [...points];
  newPoints.splice(insertIndex, 0, newPt);

  return {
    points: newPoints,
    index: insertIndex,
  };
}

/**
 * Inserts a control point into the path exactly at normalized progress u.
 * Returns a new array of points.
 */
export function insertControlPoint(points: Point2D[], table: ArcLengthEntry[], u: number, alpha: number = 0.5): Point2D[] {
  return insertControlPointWithIndex(points, table, u, alpha).points;
}

export interface RawDragSample {
  point: Point2D;
  time: number;
}

/**
 * Drops near-duplicate samples that are closer than spatialEpsilon.
 */
export function coarseGrainDragSamples(samples: RawDragSample[], spatialEpsilon: number = 2.0): RawDragSample[] {
  if (samples.length <= 1) return samples;

  const result: RawDragSample[] = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    const prev = result[result.length - 1];
    const curr = samples[i];
    if (distance(prev.point, curr.point) >= spatialEpsilon) {
      result.push(curr);
    }
  }
  
  if (result[result.length - 1] !== samples[samples.length - 1]) {
    if (distance(result[result.length - 1].point, samples[samples.length - 1].point) < spatialEpsilon) {
       result[result.length - 1] = samples[samples.length - 1];
    } else {
       result.push(samples[samples.length - 1]);
    }
  }

  return result;
}

function pointLineDistance(p: Point2D, lineStart: Point2D, lineEnd: Point2D): number {
  const num = Math.abs((lineEnd.y - lineStart.y) * p.x - (lineEnd.x - lineStart.x) * p.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x);
  const den = Math.sqrt(Math.pow(lineEnd.y - lineStart.y, 2) + Math.pow(lineEnd.x - lineStart.x, 2));
  if (den === 0) return distance(p, lineStart);
  return num / den;
}

/**
 * Simplifies a path using the Ramer-Douglas-Peucker algorithm.
 */
export function simplifyPath(samples: RawDragSample[], epsilon: number): RawDragSample[] {
  if (samples.length <= 2) return samples;

  let dmax = 0;
  let index = 0;
  const end = samples.length - 1;

  const p1 = samples[0].point;
  const p2 = samples[end].point;

  for (let i = 1; i < end; i++) {
    const p = samples[i].point;
    const d = pointLineDistance(p, p1, p2);
    if (d > dmax) {
      index = i;
      dmax = d;
    }
  }

  if (dmax > epsilon) {
    const recResults1 = simplifyPath(samples.slice(0, index + 1), epsilon);
    const recResults2 = simplifyPath(samples.slice(index), epsilon);
    return [...recResults1.slice(0, -1), ...recResults2];
  } else {
    return [samples[0], samples[end]];
  }
}

export interface ProcessedPathData {
  points: Point2D[];
  timingSplinePoints: { time: number; value: number }[];
}

function normalizeTimingSplinePoints(
  points: { time: number; value: number }[],
): { time: number; value: number }[] {
  if (points.length === 0) {
    return [];
  }

  const sorted = [...points]
    .map((point, index) => ({
      time: index === 0 ? 0 : index === points.length - 1 ? 1 : clamp01(point.time),
      value:
        index === 0 ? 0 : index === points.length - 1 ? 1 : clamp01(point.value),
    }))
    .sort((left, right) => left.time - right.time);

  const result: { time: number; value: number }[] = [sorted[0]];

  for (let index = 1; index < sorted.length; index += 1) {
    const point = sorted[index];
    const previous = result[result.length - 1];
    const nextValue = Math.max(previous.value, point.value);

    if (Math.abs(point.time - previous.time) <= 0.0001) {
      result[result.length - 1] = {
        time: previous.time,
        value: nextValue,
      };
      continue;
    }

    result.push({
      time: point.time,
      value: nextValue,
    });
  }

  result[0] = { time: 0, value: 0 };
  result[result.length - 1] = { time: 1, value: 1 };
  return result;
}

function buildTimingSplinePoints(
  samples: RawDragSample[],
  simplifyEpsilon: number = 0.025,
  maxPoints: number = 8,
): { time: number; value: number }[] {
  if (samples.length < 2) {
    return [];
  }

  const arcLengths: number[] = [0];
  let currentLength = 0;
  for (let index = 1; index < samples.length; index += 1) {
    currentLength += distance(samples[index].point, samples[index - 1].point);
    arcLengths.push(currentLength);
  }

  const totalLength = currentLength;
  const startTime = samples[0].time;
  const totalTime = samples[samples.length - 1].time - startTime;

  const normalizedPoints = samples.map((sample, index) => ({
    time: totalTime > 0 ? clamp01((sample.time - startTime) / totalTime) : 0,
    value: totalLength > 0 ? clamp01(arcLengths[index] / totalLength) : 0,
  }));

  const timingSamples = normalizedPoints.map((point, index) => ({
    point: { x: point.time, y: point.value },
    time: index,
  }));

  let epsilon = simplifyEpsilon;
  let simplifiedPoints = normalizeTimingSplinePoints(normalizedPoints);

  while (simplifiedPoints.length > maxPoints && epsilon <= 0.25) {
    const simplifiedTimingSamples = simplifyPath(timingSamples, epsilon);
    simplifiedPoints = normalizeTimingSplinePoints(
      simplifiedTimingSamples.map((sample) => ({
        time: sample.point.x,
        value: sample.point.y,
      })),
    );
    epsilon *= 1.5;
  }

  if (simplifiedPoints.length > 2) {
    const simplifiedTimingSamples = simplifyPath(timingSamples, epsilon);
    simplifiedPoints = normalizeTimingSplinePoints(
      simplifiedTimingSamples.map((sample) => ({
        time: sample.point.x,
        value: sample.point.y,
      })),
    );
  }

  return simplifiedPoints;
}

/**
 * Full coarse-graining pipeline:
 * 1. Drop near-duplicates
 * 2. Simplify path
 * 3. Build geometry control points from the simplified path
 * 4. Build timing independently from normalized time -> distance-travelled
 */
export function processRawDragSamples(
  samples: RawDragSample[], 
  spatialEpsilon: number = 2.0, 
  simplifyEpsilon: number = 1.0
): ProcessedPathData {
  const coarse = coarseGrainDragSamples(samples, spatialEpsilon);
  const simplified = simplifyPath(coarse, simplifyEpsilon);

  if (simplified.length < 2) {
      return {
          points: simplified.map(s => s.point),
          timingSplinePoints: []
      };
  }

  return {
      points: simplified.map(s => s.point),
      timingSplinePoints: buildTimingSplinePoints(coarse)
  };
}
