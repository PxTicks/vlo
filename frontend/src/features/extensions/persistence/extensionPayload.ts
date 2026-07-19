import { z } from "zod";
import type { ExtensionPayload } from "../types";
import { jsonValueSchema } from "../../../core/shell/jsonValue";

const EXTENSION_IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

const extensionIdentifierSchema = z.string().regex(
  EXTENSION_IDENTIFIER_PATTERN,
  "Expected lowercase letters, numbers, dots, underscores, or hyphens",
);

// Moved to the shell layer (plan §3.10); re-exported for existing imports.
export { jsonValueSchema };

export const extensionPayloadSchema = z
  .object({
    extensionId: extensionIdentifierSchema,
    typeId: extensionIdentifierSchema,
    schemaVersion: z.number().int().positive(),
    data: jsonValueSchema,
    assetReferences: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough() as z.ZodType<ExtensionPayload>;
