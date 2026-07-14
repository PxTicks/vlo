import { jsonValueSchema } from "../persistence/extensionPayload";
import type { JsonValue } from "../types";

/**
 * Contribution payloads that an extension hands to the host and the host later
 * hands back to UI. Registries validate finite JSON, copy defensively, and
 * deep-freeze, so neither side can mutate the other's state after publication.
 */
export function cloneAndFreezeJsonValue<TValue extends JsonValue>(
  value: TValue,
): TValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreezeJsonValue)) as TValue;
  }
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          cloneAndFreezeJsonValue(entry),
        ]),
      ),
    ) as TValue;
  }
  return value;
}

export function cloneFrozenJsonObject(
  value: unknown,
  label: string,
): Readonly<Record<string, JsonValue>> {
  const parsed = jsonValueSchema.safeParse(value);
  if (
    !parsed.success ||
    typeof parsed.data !== "object" ||
    parsed.data === null ||
    Array.isArray(parsed.data)
  ) {
    throw new Error(`${label} must be a finite JSON object.`);
  }
  return cloneAndFreezeJsonValue(
    structuredClone(parsed.data) as Record<string, JsonValue>,
  );
}
