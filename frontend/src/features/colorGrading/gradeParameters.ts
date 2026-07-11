export type GradeParameterJson = Readonly<Record<string, unknown>>;

let copiedGrade: GradeParameterJson | null = null;

function clone(parameters: GradeParameterJson): GradeParameterJson {
  return JSON.parse(JSON.stringify(parameters)) as GradeParameterJson;
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

export function copyGradeParameters(parameters: GradeParameterJson): void {
  copiedGrade = clone(parameters);
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(
      JSON.stringify({ type: "vlo-color-grade", version: 1, parameters }),
    ).catch(() => undefined);
  }
}

export function readCopiedGradeParameters(): GradeParameterJson | null {
  return copiedGrade ? clone(copiedGrade) : null;
}

export function clearCopiedGradeParameters(): void {
  copiedGrade = null;
}
