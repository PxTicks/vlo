import type {
  ExtensionApiScope,
  ExtensionPayload,
  ExtensionPayloadProviderApi,
  ExtensionPayloadProviderDefinition,
  ExtensionPayloadProviderRegistration,
  JsonValue,
} from "../types";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionDefinition,
  type RegisteredExtensionContribution,
} from "../registry/ExtensionContributionRegistry";
import {
  extensionPayloadSchema,
  jsonValueSchema,
} from "./extensionPayload";
import type { ExtensionProviderAvailability } from "./extensionRequirements";

type PayloadProviderContributionDefinition =
  ExtensionContributionDefinition & ExtensionPayloadProviderDefinition;

export type ExtensionPayloadResolutionSuccess =
  | {
      status: "current";
      payload: ExtensionPayload;
      originalPayload: ExtensionPayload;
    }
  | {
      status: "migrated";
      payload: ExtensionPayload;
      originalPayload: ExtensionPayload;
    };

export type ExtensionPayloadResolutionFailure =
  | {
      status: "missing";
      payload: ExtensionPayload;
      error: Error;
    }
  | {
      status: "incompatible";
      payload: ExtensionPayload;
      error: Error;
    }
  | {
      status: "invalid";
      payload: ExtensionPayload;
      error: Error;
    }
  | {
      status: "migration_failed";
      payload: ExtensionPayload;
      error: Error;
    };

export type ExtensionPayloadResolution =
  | ExtensionPayloadResolutionSuccess
  | ExtensionPayloadResolutionFailure;

export type ExtensionPayloadAssetReferenceResolution =
  | {
      ok: true;
      payload: ExtensionPayload;
      references: readonly string[];
    }
  | {
      ok: false;
      resolution: ExtensionPayloadResolutionFailure;
    };

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function providerId(payload: ExtensionPayload): string {
  return `${payload.extensionId}/${payload.typeId}`;
}

function validateDefinition(
  definition: ExtensionPayloadProviderDefinition,
): PayloadProviderContributionDefinition {
  if (definition.apiVersion !== 1) {
    throw new Error(
      `Payload provider '${definition.id}' must use apiVersion 1.`,
    );
  }
  if (
    !Number.isInteger(definition.schemaVersion) ||
    definition.schemaVersion < 1
  ) {
    throw new Error(
      `Payload provider '${definition.id}' must declare a positive schemaVersion.`,
    );
  }
  if (typeof definition.validate !== "function") {
    throw new TypeError(
      `Payload provider '${definition.id}' must define validate().`,
    );
  }
  if (
    definition.migrate !== undefined &&
    typeof definition.migrate !== "function"
  ) {
    throw new TypeError(
      `Payload provider '${definition.id}' migrate must be a function.`,
    );
  }
  if (
    definition.getAssetReferences !== undefined &&
    typeof definition.getAssetReferences !== "function"
  ) {
    throw new TypeError(
      `Payload provider '${definition.id}' getAssetReferences must be a function.`,
    );
  }
  return { ...definition };
}

function createFailure(
  status: "missing" | "incompatible" | "invalid" | "migration_failed",
  payload: ExtensionPayload,
  error: unknown,
): ExtensionPayloadResolutionFailure {
  return {
    status,
    payload: structuredClone(payload),
    error: errorFromUnknown(error),
  };
}

export class ExtensionPayloadProviderRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<PayloadProviderContributionDefinition>(
      "payload-provider",
    );

  bind(scope: ExtensionApiScope): ExtensionPayloadProviderApi {
    const boundRegistry = this.registry.bind(scope);
    return Object.freeze({
      register: (
        definition: ExtensionPayloadProviderDefinition,
      ): ExtensionPayloadProviderRegistration => {
        const registration = boundRegistry.register(
          validateDefinition(definition),
        );
        return Object.freeze({
          id: registration.id,
          dispose: () => registration.dispose(),
        });
      },
    });
  }

  get(
    payload: ExtensionPayload,
  ): RegisteredExtensionContribution<PayloadProviderContributionDefinition> | undefined {
    return this.registry.get(providerId(payload));
  }

  getAvailability(payload: ExtensionPayload): ExtensionProviderAvailability {
    const provider = this.get(payload)?.definition;
    if (!provider) return "missing";
    if (payload.schemaVersion > provider.schemaVersion) return "incompatible";
    if (
      payload.schemaVersion < provider.schemaVersion &&
      provider.migrate === undefined
    ) {
      return "incompatible";
    }
    return "available";
  }

  resolve(payloadInput: ExtensionPayload): ExtensionPayloadResolution {
    const parsed = extensionPayloadSchema.safeParse(payloadInput);
    if (!parsed.success) {
      return createFailure(
        "invalid",
        payloadInput,
        new Error(`Invalid extension payload: ${parsed.error.message}`),
      );
    }

    const originalPayload = structuredClone(parsed.data);
    const contribution = this.get(originalPayload);
    if (!contribution) {
      return createFailure(
        "missing",
        originalPayload,
        new Error(`Payload provider '${providerId(originalPayload)}' is missing.`),
      );
    }

    const provider = contribution.definition;
    if (originalPayload.schemaVersion > provider.schemaVersion) {
      return createFailure(
        "incompatible",
        originalPayload,
        new Error(
          `Payload schema ${originalPayload.schemaVersion} is newer than provider schema ${provider.schemaVersion}.`,
        ),
      );
    }

    let schemaVersion = originalPayload.schemaVersion;
    let data: JsonValue = structuredClone(originalPayload.data);
    const needsMigration = schemaVersion < provider.schemaVersion;

    if (schemaVersion < provider.schemaVersion && !provider.migrate) {
      return createFailure(
        "incompatible",
        originalPayload,
        new Error(
          `Payload provider '${contribution.id}' cannot migrate schema ${schemaVersion} to ${provider.schemaVersion}.`,
        ),
      );
    }

    try {
      let migrationCount = 0;
      while (schemaVersion < provider.schemaVersion) {
        if (!provider.migrate) {
          throw new Error("The provider has no migration function.");
        }
        const migrated = provider.migrate(structuredClone(data), schemaVersion);
        if (
          !Number.isInteger(migrated.schemaVersion) ||
          migrated.schemaVersion <= schemaVersion ||
          migrated.schemaVersion > provider.schemaVersion
        ) {
          throw new Error(
            `Migration from schema ${schemaVersion} returned invalid schema ${migrated.schemaVersion}.`,
          );
        }
        data = jsonValueSchema.parse(migrated.data);
        schemaVersion = migrated.schemaVersion;
        migrationCount += 1;
        if (migrationCount > 100) {
          throw new Error("Payload migration exceeded 100 steps.");
        }
      }

      provider.validate(structuredClone(data), schemaVersion);
    } catch (error) {
      return createFailure(
        needsMigration ? "migration_failed" : "invalid",
        originalPayload,
        error,
      );
    }

    const payload = extensionPayloadSchema.parse({
      ...originalPayload,
      schemaVersion,
      data,
    });
    return {
      status:
        schemaVersion === originalPayload.schemaVersion
          ? "current"
          : "migrated",
      payload: structuredClone(payload),
      originalPayload,
    };
  }

  resolveAssetReferences(
    payload: ExtensionPayload,
  ): ExtensionPayloadAssetReferenceResolution {
    const resolution = this.resolve(payload);
    if (resolution.status !== "current" && resolution.status !== "migrated") {
      return { ok: false, resolution };
    }

    const provider = this.get(resolution.payload)?.definition;
    if (!provider?.getAssetReferences) {
      const references = [
        ...new Set(resolution.payload.assetReferences ?? []),
      ].sort();
      return { ok: true, payload: resolution.payload, references };
    }

    try {
      const references = provider.getAssetReferences(
        structuredClone(resolution.payload.data),
        resolution.payload.schemaVersion,
      );
      if (!Array.isArray(references)) {
        throw new Error("Asset references must be an array.");
      }
      const normalized = [...new Set(references)].sort();
      if (
        normalized.some(
          (reference) =>
            typeof reference !== "string" || reference.trim().length === 0,
        )
      ) {
        throw new Error("Asset references must be non-empty strings.");
      }
      return {
        ok: true,
        payload: extensionPayloadSchema.parse({
          ...resolution.payload,
          assetReferences: normalized,
        }),
        references: normalized,
      };
    } catch (error) {
      return {
        ok: false,
        resolution: createFailure(
          "invalid",
          resolution.payload,
          new Error(
            `Payload provider '${providerId(resolution.payload)}' returned invalid asset references: ${errorFromUnknown(error).message}`,
          ),
        ),
      };
    }
  }
}

export const extensionPayloadProviderRegistry =
  new ExtensionPayloadProviderRegistry();
