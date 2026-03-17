export interface MoveSnapCandidate {
  snapTick: number;
  snappedStartTicks: number;
  distancePx: number;
}

export interface EdgeSnapCandidate {
  snapTick: number;
  distancePx: number;
}

export const getMoveSnapCandidate = (
  startTicks: number,
  durationTicks: number,
  snapPoints: number[],
  ticksToPx: (ticks: number) => number,
  thresholdPx: number,
): MoveSnapCandidate | null => {
  if (snapPoints.length === 0) return null;

  let best: MoveSnapCandidate | null = null;
  const endTicks = startTicks + durationTicks;

  snapPoints.forEach((snapTick) => {
    const startDistancePx = Math.abs(ticksToPx(startTicks - snapTick));
    if (startDistancePx <= thresholdPx) {
      if (!best || startDistancePx < best.distancePx) {
        best = {
          snapTick,
          snappedStartTicks: snapTick,
          distancePx: startDistancePx,
        };
      }
    }

    const endDistancePx = Math.abs(ticksToPx(endTicks - snapTick));
    if (endDistancePx <= thresholdPx) {
      if (!best || endDistancePx < best.distancePx) {
        best = {
          snapTick,
          snappedStartTicks: snapTick - durationTicks,
          distancePx: endDistancePx,
        };
      }
    }
  });

  return best;
};

export const getEdgeSnapCandidate = (
  edgeTicks: number,
  snapPoints: number[],
  ticksToPx: (ticks: number) => number,
  thresholdPx: number,
): EdgeSnapCandidate | null => {
  if (snapPoints.length === 0) return null;

  let best: EdgeSnapCandidate | null = null;

  snapPoints.forEach((snapTick) => {
    const distancePx = Math.abs(ticksToPx(edgeTicks - snapTick));
    if (distancePx > thresholdPx) return;

    if (!best || distancePx < best.distancePx) {
      best = { snapTick, distancePx };
    }
  });

  return best;
};
