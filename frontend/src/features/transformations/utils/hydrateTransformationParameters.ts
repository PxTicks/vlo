import type { TransformationDefinition } from "../catalogue/types";

/**
 * Add defaults introduced after a transformation was persisted without
 * mutating project state. Explicit authored values, including unknown values
 * that validation may reject, always win over defaults.
 *
 * This is host-owned so native and extension transformations evolve through
 * the same additive-parameter path. The next user edit materializes the
 * hydrated values through the ordinary commit workflow.
 */
export function hydrateTransformationParameters(
  definition: TransformationDefinition,
  parameters: Readonly<Record<string, unknown>>,
  transformType = definition.type,
): Readonly<Record<string, unknown>> {
  if (definition.hydrateMissingParameters !== true) return parameters;

  let hydrated: Record<string, unknown> | null = null;

  const addMissing = (name: string, value: unknown) => {
    if (Object.hasOwn(hydrated ?? parameters, name)) return;
    hydrated ??= { ...parameters };
    hydrated[name] = value;
  };

  const groups = definition.handledTypes?.includes(transformType)
    ? definition.uiConfig.groups.filter((group) => group.id === transformType)
    : definition.uiConfig.groups;
  for (const group of groups) {
    for (const control of group.controls) {
      if (control.type === "custom" || control.type === "spacer") continue;
      const defaultValue =
        definition.defaultParameters?.[control.name] ?? control.defaultValue;
      addMissing(control.name, defaultValue);
    }
  }

  for (const [name, value] of Object.entries(definition.defaultParameters ?? {})) {
    addMissing(name, value);
  }

  return hydrated ?? parameters;
}
