import { Container } from "pixi.js";
import type {
  ExtensionApiScope,
  ExtensionEntityProviderApi,
  ExtensionEntityProviderRegistration,
  ExtensionEntityInspectorProps,
  ExtensionEntityRenderContext,
  ExtensionEntityRenderParameters,
  ExtensionPayload,
  ExtensionPayloadProviderRegistration,
  ExtensionTrustedEntityProviderDefinition,
  JsonValue,
} from "../types";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionDefinition,
  type RegisteredExtensionContribution,
} from "../registry/ExtensionContributionRegistry";
import {
  TrustedHostObjectManager,
  type TrustedHostObjectFailureReporter,
  type TrustedHostObjectSlotAdapter,
} from "../runtime/publicApi";
import { extensionPayloadProviderRegistry } from "../persistence/ExtensionPayloadProviderRegistry";
import type { ExtensionProviderAvailability } from "../persistence/extensionRequirements";
import { jsonValueSchema } from "../persistence/extensionPayload";

const TIMELINE_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export type ExtensionEntityProviderAvailability =
  | ExtensionProviderAvailability
  | "renderer_unavailable";

export interface ExtensionEntityTimelinePresentation {
  readonly label: string;
  readonly color: string;
}

export interface RuntimeEntityProviderDefinition
  extends ExtensionContributionDefinition {
  readonly label: string;
  readonly timelineColor: string;
  readonly defaultPayload: JsonValue;
  readonly inspector?: (props: ExtensionEntityInspectorProps) => unknown;
  readonly report: ExtensionApiScope["report"];
  readonly createRenderable: () => Container | null;
  readonly getRenderSignature?: (
    parameters: ExtensionEntityRenderParameters,
    context: ExtensionEntityRenderContext,
  ) => string | null;
  readonly updateRenderable: (
    object: Container,
    parameters: ExtensionEntityRenderParameters,
    context: ExtensionEntityRenderContext,
    slot: Container,
  ) => boolean;
  readonly releaseRenderable: (object: Container) => void;
  readonly disposeRuntime: () => void;
}

export type RegisteredExtensionEntityProvider =
  RegisteredExtensionContribution<RuntimeEntityProviderDefinition>;

const ENTITY_RENDER_SLOT_ADAPTER: TrustedHostObjectSlotAdapter<
  Container,
  Container,
  undefined
> = {
  slotKind: "Pixi entity renderable",
  validate: (object: object): object is Container => object instanceof Container,
  isSameSlot: (left, right) => left === right,
  attach: (object, slot) => {
    if (object.parent !== slot) {
      slot.addChild(object);
    }
  },
  detach: (object, slot) => {
    if (object.parent === slot) {
      slot.removeChild(object);
    }
  },
  destroy: (object) => {
    if (!object.destroyed) {
      object.destroy({ children: true });
    }
  },
};

function providerId(payload: ExtensionPayload): string {
  return `${payload.extensionId}/${payload.typeId}`;
}

function assertText(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters.`);
  }
  return normalized;
}

function compileDefinition(
  ownerId: string,
  definition: ExtensionTrustedEntityProviderDefinition,
  report: ExtensionApiScope["report"],
): RuntimeEntityProviderDefinition {
  if (definition.apiVersion !== 1) {
    throw new Error(`Entity provider '${definition.id}' must use apiVersion 1.`);
  }
  if (definition.kind !== "trusted-pixi") {
    throw new Error(
      `Entity provider '${definition.id}' has an unsupported render kind.`,
    );
  }
  if (
    !Number.isInteger(definition.schemaVersion) ||
    definition.schemaVersion < 1
  ) {
    throw new Error(
      `Entity provider '${definition.id}' must declare a positive schemaVersion.`,
    );
  }
  if (typeof definition.validate !== "function") {
    throw new TypeError(
      `Entity provider '${definition.id}' must define validate().`,
    );
  }
  if (
    definition.migrate !== undefined &&
    typeof definition.migrate !== "function"
  ) {
    throw new TypeError(
      `Entity provider '${definition.id}' migrate must be a function.`,
    );
  }
  if (
    definition.getAssetReferences !== undefined &&
    typeof definition.getAssetReferences !== "function"
  ) {
    throw new TypeError(
      `Entity provider '${definition.id}' getAssetReferences must be a function.`,
    );
  }
  if (typeof definition.createRenderable !== "function") {
    throw new TypeError(
      `Entity provider '${definition.id}' must define createRenderable().`,
    );
  }
  if (
    definition.inspector !== undefined &&
    typeof definition.inspector !== "function"
  ) {
    throw new TypeError(
      `Entity provider '${definition.id}' inspector must be a component function.`,
    );
  }
  if (
    definition.getRenderSignature !== undefined &&
    typeof definition.getRenderSignature !== "function"
  ) {
    throw new TypeError(
      `Entity provider '${definition.id}' getRenderSignature must be a function.`,
    );
  }
  if (
    definition.timelineColor !== undefined &&
    !TIMELINE_COLOR_PATTERN.test(definition.timelineColor)
  ) {
    throw new Error(
      `Entity provider '${definition.id}' timelineColor must be a six-digit hex color.`,
    );
  }

  const defaultPayload = jsonValueSchema.parse(
    structuredClone(definition.defaultPayload),
  );
  definition.validate(structuredClone(defaultPayload), definition.schemaVersion);

  const contributionId = `${ownerId}/${definition.id}`;
  const reportedFailures = new Set<string>();
  const reportFailureOnce: TrustedHostObjectFailureReporter = (
    key,
    level,
    message,
    detail,
  ) => {
    if (reportedFailures.has(key)) return;
    reportedFailures.add(key);
    report(level, message, detail);
  };
  const manager = new TrustedHostObjectManager<
    Container,
    ExtensionEntityRenderParameters,
    ExtensionEntityRenderContext,
    Container,
    undefined
  >({
    contributionId,
    create: definition.createRenderable,
    adapter: ENTITY_RENDER_SLOT_ADAPTER,
    reportFailureOnce,
  });

  return Object.freeze({
    id: definition.id,
    apiVersion: definition.apiVersion,
    execution: "trusted" as const,
    label: assertText(
      definition.label,
      `Entity provider '${definition.id}' label`,
      120,
    ),
    timelineColor: definition.timelineColor ?? "#2563eb",
    defaultPayload,
    inspector: definition.inspector,
    report,
    createRenderable: () => manager.create(),
    getRenderSignature: definition.getRenderSignature
      ? (
          parameters: ExtensionEntityRenderParameters,
          context: ExtensionEntityRenderContext,
        ) => {
          try {
            const signature = definition.getRenderSignature?.(
              parameters,
              context,
            );
            if (typeof signature !== "string") {
              reportFailureOnce(
                "render-signature-invalid",
                "error",
                `Entity provider '${contributionId}' returned a non-string render signature.`,
              );
              return null;
            }
            return signature;
          } catch (error) {
            reportFailureOnce(
              "render-signature",
              "error",
              `Entity provider '${contributionId}' failed to compute its render signature.`,
              error,
            );
            return null;
          }
        }
      : undefined,
    updateRenderable: (
      object: Container,
      parameters: ExtensionEntityRenderParameters,
      context: ExtensionEntityRenderContext,
      slot: Container,
    ) =>
      manager.update(object, parameters, context, slot, undefined),
    releaseRenderable: (object: Container) => manager.release(object),
    disposeRuntime: () => manager.dispose(),
  });
}

export class ExtensionEntityProviderRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<RuntimeEntityProviderDefinition>(
      "entity-provider",
    );

  bind(scope: ExtensionApiScope): ExtensionEntityProviderApi {
    const boundRuntimeRegistry = this.registry.bind(scope);
    const payloadProviders = extensionPayloadProviderRegistry.bind(scope);

    return Object.freeze({
      register: (
        definition: ExtensionTrustedEntityProviderDefinition,
      ): ExtensionEntityProviderRegistration => {
        const compiled = compileDefinition(
          scope.extension.id,
          definition,
          scope.report,
        );
        let payloadRegistration: ExtensionPayloadProviderRegistration;
        try {
          payloadRegistration = payloadProviders.register({
            id: definition.id,
            apiVersion: definition.apiVersion,
            schemaVersion: definition.schemaVersion,
            validate: definition.validate,
            migrate: definition.migrate,
            getAssetReferences: definition.getAssetReferences,
          });
        } catch (error) {
          compiled.disposeRuntime();
          throw error;
        }

        let runtimeRegistration: ReturnType<typeof boundRuntimeRegistry.register>;
        try {
          runtimeRegistration = boundRuntimeRegistry.register(compiled);
        } catch (error) {
          payloadRegistration.dispose();
          compiled.disposeRuntime();
          throw error;
        }

        let disposed = false;
        const registration: ExtensionEntityProviderRegistration = Object.freeze({
          id: runtimeRegistration.id,
          dispose: () => {
            if (disposed) return;
            disposed = true;
            compiled.disposeRuntime();
            runtimeRegistration.dispose();
            payloadRegistration.dispose();
          },
        });
        scope.own(registration);
        return registration;
      },
    });
  }

  get(
    payload: ExtensionPayload,
  ): RegisteredExtensionEntityProvider | undefined {
    return this.registry.get(providerId(payload));
  }

  getAvailability(
    payload: ExtensionPayload,
  ): ExtensionEntityProviderAvailability {
    const payloadAvailability =
      extensionPayloadProviderRegistry.getAvailability(payload);
    if (payloadAvailability !== "available") return payloadAvailability;
    return this.get(payload) ? "available" : "renderer_unavailable";
  }

  getTimelinePresentation(
    payload: ExtensionPayload,
  ): ExtensionEntityTimelinePresentation | null {
    const provider = this.get(payload)?.definition;
    if (!provider) return null;
    return Object.freeze({
      label: provider.label,
      color: provider.timelineColor,
    });
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener);
  }

  getRevision(): number {
    return this.registry.getRevision();
  }
}

export const extensionEntityProviderRegistry =
  new ExtensionEntityProviderRegistry();
