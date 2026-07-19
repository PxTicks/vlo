type TimelineTimeDomain =
  | "presentation"
  | "stored-track"
  | "clip-offset"
  | "duration";

type TimelineTimeValue<Domain extends TimelineTimeDomain> = number & {
  readonly __timelineTimeDomain: Domain;
};

export type PresentationTick = TimelineTimeValue<"presentation">;
export type StoredTrackTick = TimelineTimeValue<"stored-track">;
export type ClipOffsetTick = TimelineTimeValue<"clip-offset">;
export type TimelineTickDuration = TimelineTimeValue<"duration">;

export function presentationTick(value: number): PresentationTick {
  return value as PresentationTick;
}

export function storedTrackTick(value: number): StoredTrackTick {
  return value as StoredTrackTick;
}

export function clipOffsetTick(value: number): ClipOffsetTick {
  return value as ClipOffsetTick;
}

export function timelineTickDuration(value: number): TimelineTickDuration {
  return value as TimelineTickDuration;
}

/** Explicit escape hatch for APIs that have not yet adopted domain types. */
export function timelineTimeValue(
  value: TimelineTimeValue<TimelineTimeDomain>,
): number {
  return value;
}
