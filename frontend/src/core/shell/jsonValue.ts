import { z } from "zod";
import type { JsonValue } from "@vlo/extension-sdk";

/**
 * Finite-JSON validator shared across the shell registries and the extension
 * persistence layer. Shell-owned (extension-shell-surfaces plan §3.10) so
 * feature-free machinery can validate values without importing features.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
