export type GradeParameterJson = Readonly<Record<string, unknown>>;

export interface GradeTimeRange {
  readonly minTime: number;
  readonly duration: number;
}

let copiedGrade: GradeClipboardEnvelope | null = null;

function clone(parameters: GradeParameterJson): GradeParameterJson {
  return structuredClone(parameters);
}

interface GradeClipboardEnvelope {
  readonly type: "vlo-color-grade";
  readonly version: 1;
  readonly parameters: GradeParameterJson;
  readonly sourceTimeRange?: GradeTimeRange;
}

function parseClipboardEnvelope(text: string): GradeClipboardEnvelope | null {
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== "object" ||
      value === null ||
      !("type" in value) ||
      value.type !== "vlo-color-grade" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("parameters" in value) ||
      typeof value.parameters !== "object" ||
      value.parameters === null ||
      Array.isArray(value.parameters)
    ) {
      return null;
    }
    const envelope = value as GradeClipboardEnvelope;
    return {
      type: "vlo-color-grade",
      version: 1,
      parameters: clone(envelope.parameters),
      ...(envelope.sourceTimeRange
        ? { sourceTimeRange: structuredClone(envelope.sourceTimeRange) }
        : {}),
    };
  } catch {
    return null;
  }
}

export function captureGradeParameters(
  values: Readonly<Record<string, unknown>>,
): GradeParameterJson {
  return clone(
    Object.fromEntries(
      Object.entries(values).filter(([name]) => !name.startsWith("_")),
    ),
  );
}

export function copyGradeParameters(
  parameters: GradeParameterJson,
  sourceTimeRange?: GradeTimeRange,
): void {
  copiedGrade = {
    type: "vlo-color-grade",
    version: 1,
    parameters: clone(parameters),
    ...(sourceTimeRange ? { sourceTimeRange: { ...sourceTimeRange } } : {}),
  };
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard
      .writeText(JSON.stringify(copiedGrade))
      .catch(() => undefined);
  }
}

export function remapGradeParameterTimes(
  parameters: GradeParameterJson,
  source: GradeTimeRange | undefined,
  target: GradeTimeRange | undefined,
): GradeParameterJson {
  if (!source || !target || source.duration <= 0 || target.duration <= 0) {
    return clone(parameters);
  }
  return Object.fromEntries(
    Object.entries(parameters).map(([name, value]) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("type" in value) ||
        value.type !== "spline" ||
        !("points" in value) ||
        !Array.isArray(value.points)
      ) {
        return [name, structuredClone(value)];
      }
      return [
        name,
        {
          ...structuredClone(value),
          points: value.points.map((point: unknown) => {
            if (
              typeof point !== "object" ||
              point === null ||
              !("time" in point) ||
              typeof point.time !== "number"
            ) {
              return structuredClone(point);
            }
            return {
              ...structuredClone(point),
              time:
                target.minTime +
                ((point.time - source.minTime) / source.duration) *
                  target.duration,
            };
          }),
        },
      ];
    }),
  );
}

export async function readCopiedGradeParameters(
  targetTimeRange?: GradeTimeRange,
): Promise<GradeParameterJson | null> {
  let envelope = copiedGrade;
  if (!envelope && typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    try {
      envelope = parseClipboardEnvelope(await navigator.clipboard.readText());
    } catch {
      return null;
    }
  }
  if (!envelope) return null;
  return remapGradeParameterTimes(
    envelope.parameters,
    envelope.sourceTimeRange,
    targetTimeRange,
  );
}

export function clearCopiedGradeParameters(): void {
  copiedGrade = null;
}
