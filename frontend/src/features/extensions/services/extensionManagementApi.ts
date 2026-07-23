import { z } from "zod";
import { API_BASE_URL } from "../../../config";

const EXTENSIONS_API_ROOT = `${API_BASE_URL}/app/extensions`;

const frontendEntrySchema = z.object({
  entry: z.string(),
});

const backendEntrySchema = z.object({
  mode: z.literal("in_process"),
  entry: z.string(),
});

const pythonDependencySchema = z.object({
  module: z.string(),
  distribution: z.string().optional(),
  purpose: z.string().optional(),
});

const extensionContributionsSchema = z.object({
  luts: z.string().optional(),
});

const extensionManifestSchema = z.object({
  manifestVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  version: z.string(),
  sdk: z.string(),
  vlo: z.string().optional(),
  frontend: frontendEntrySchema.optional(),
  backend: backendEntrySchema.optional(),
  contributions: extensionContributionsSchema.optional(),
  capabilities: z.array(z.string()),
  pythonDependencies: z.array(pythonDependencySchema).optional(),
});

const extensionApprovalSchema = z.object({
  digest: z.string(),
  version: z.string(),
  approvedAt: z.number(),
  enabled: z.boolean(),
});

const backendRuntimeSchema = z.object({
  status: z.enum([
    "not_declared",
    "inactive",
    "restart_required",
    "active",
    "failed",
  ]),
  message: z.string(),
  digest: z.string().nullable(),
});

const preflightDependencySchema = z.object({
  module: z.string(),
  distribution: z.string().nullable(),
  purpose: z.string().nullable(),
  satisfied: z.boolean(),
  detail: z.string(),
});

const preflightSchema = z.object({
  satisfied: z.boolean(),
  dependencies: z.array(preflightDependencySchema),
  installHints: z.array(z.string()),
  environment: z.string(),
  isolated: z.boolean(),
});

const extensionLutContributionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  order: z.number(),
  resourceUrl: z
    .string()
    .startsWith("/app/extensions/")
    .transform((url) => `${API_BASE_URL}${url}`),
});

export type ExtensionPreflightReport = z.infer<typeof preflightSchema>;

export function prefixExtensionFrontendEntryUrl(
  frontendEntryUrl: string | null,
  apiBaseUrl = API_BASE_URL,
): string | null {
  return frontendEntryUrl === null
    ? null
    : `${apiBaseUrl}${frontendEntryUrl}`;
}

const extensionInventoryItemSchema = z.object({
  id: z.string(),
  sourcePath: z.string(),
  status: z.enum([
    "invalid",
    "pending_approval",
    "approved",
    "changed",
    "disabled",
  ]),
  digest: z.string().nullable(),
  errors: z.array(z.string()),
  manifest: extensionManifestSchema.nullable(),
  approval: extensionApprovalSchema.nullable(),
  backendRuntime: backendRuntimeSchema,
  preflight: preflightSchema.nullable(),
  frontendEntryUrl: z
    .string()
    .startsWith("/app/extensions/")
    .transform((url) => prefixExtensionFrontendEntryUrl(url))
    .nullable(),
  lutContributions: z.array(extensionLutContributionSchema).optional(),
});

const extensionInventoryResponseSchema = z.object({
  extensions: z.array(extensionInventoryItemSchema),
});

const extensionMutationResponseSchema = z.object({
  extension: extensionInventoryItemSchema,
});

export type ExtensionInventoryItem = z.infer<
  typeof extensionInventoryItemSchema
>;
export type ExtensionInventoryStatus = ExtensionInventoryItem["status"];

export interface ExtensionManagementRequestOptions {
  signal?: AbortSignal;
}

export class ExtensionManagementApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ExtensionManagementApiError";
    this.status = status;
    this.payload = payload;
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "object" &&
    payload.error !== null &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return fallback;
}

async function readPayload(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return null;

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

async function requestJson<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  const payload = await readPayload(response);

  if (!response.ok) {
    throw new ExtensionManagementApiError(
      errorMessage(
        payload,
        `Extension management request failed (${response.status}).`,
      ),
      response.status,
      payload,
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ExtensionManagementApiError(
      "The extension manager returned an invalid response.",
      response.status,
      payload,
    );
  }
  return parsed.data;
}

function extensionUrl(extensionId: string, suffix: string): string {
  return `${EXTENSIONS_API_ROOT}/${encodeURIComponent(extensionId)}/${suffix}`;
}

export async function fetchExtensionInventory(
  options: ExtensionManagementRequestOptions = {},
): Promise<ExtensionInventoryItem[]> {
  const response = await requestJson(
    EXTENSIONS_API_ROOT,
    extensionInventoryResponseSchema,
    options.signal ? { signal: options.signal } : undefined,
  );
  return response.extensions;
}

export async function approveExtensionDigest(
  extensionId: string,
  digest: string,
  options: ExtensionManagementRequestOptions = {},
): Promise<ExtensionInventoryItem> {
  const response = await requestJson(
    extensionUrl(extensionId, "approve"),
    extensionMutationResponseSchema,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digest }),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return response.extension;
}

export async function declineExtensionDigest(
  extensionId: string,
  digest: string,
  options: ExtensionManagementRequestOptions = {},
): Promise<ExtensionInventoryItem> {
  const response = await requestJson(
    extensionUrl(extensionId, "decline"),
    extensionMutationResponseSchema,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digest }),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return response.extension;
}

export async function disableExtension(
  extensionId: string,
  options: ExtensionManagementRequestOptions = {},
): Promise<ExtensionInventoryItem> {
  const response = await requestJson(
    extensionUrl(extensionId, "disable"),
    extensionMutationResponseSchema,
    {
      method: "POST",
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return response.extension;
}

export async function revokeExtensionApproval(
  extensionId: string,
  options: ExtensionManagementRequestOptions = {},
): Promise<ExtensionInventoryItem> {
  const response = await requestJson(
    extensionUrl(extensionId, "approval"),
    extensionMutationResponseSchema,
    {
      method: "DELETE",
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return response.extension;
}
