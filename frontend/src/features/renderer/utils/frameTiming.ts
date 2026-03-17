const FRAME_TIMESTAMP_TOLERANCE_SECONDS = 0.002;

export function isFrameTimestampReady(
  nextFrameTimestamp: number,
  requestedTime: number,
): boolean {
  return (
    nextFrameTimestamp <=
    requestedTime + FRAME_TIMESTAMP_TOLERANCE_SECONDS
  );
}

