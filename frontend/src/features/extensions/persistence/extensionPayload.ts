import { z } from "zod";
import type { ExtensionPayload, JsonValue } from "../types";

const EXTENSION_IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

const extensionIdentifierSchema = z.string().regex(
  EXTENSION_IDENTIFIER_PATTERN,
  "Expected lowercase letters, numbers, dots, underscores, or hyphens",
);

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

export const extensionPayloadSchema = z
  .object({
    extensionId: extensionIdentifierSchema,
    typeId: extensionIdentifierSchema,
    schemaVersion: z.number().int().positive(),
    data: jsonValueSchema,
    assetReferences: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough() as z.ZodType<ExtensionPayload>;
