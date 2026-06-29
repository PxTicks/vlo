import type {
  ExtensionApiScope,
  ExtensionUiApi,
  ExtensionUiNoticeDefinition,
  ExtensionUiRegistration,
  ExtensionUiSlotId,
} from "../types";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionDefinition,
  type RegisteredExtensionContribution,
} from "../registry/ExtensionContributionRegistry";

interface RuntimeUiNoticeDefinition extends ExtensionContributionDefinition {
  slot: ExtensionUiSlotId;
  kind: "notice";
  title: string;
  message: string;
  tone: "info" | "success" | "warning";
  report: ExtensionApiScope["report"];
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

function compileNotice(
  definition: ExtensionUiNoticeDefinition,
  report: ExtensionApiScope["report"],
): RuntimeUiNoticeDefinition {
  if (definition.apiVersion !== 1) {
    throw new Error(`UI notice '${definition.id}' must use apiVersion 1.`);
  }
  if (definition.kind !== "notice") {
    throw new Error(
      `UI contribution '${definition.id}' has an unsupported kind.`,
    );
  }
  if (definition.slot !== "transformation-panel.before") {
    throw new Error(`UI notice '${definition.id}' targets an unknown slot.`);
  }
  if (
    definition.tone !== undefined &&
    !["info", "success", "warning"].includes(definition.tone)
  ) {
    throw new Error(`UI notice '${definition.id}' has an invalid tone.`);
  }
  return Object.freeze({
    id: definition.id,
    apiVersion: definition.apiVersion,
    slot: definition.slot,
    kind: definition.kind,
    title: assertText(
      definition.title,
      `UI notice '${definition.id}' title`,
      120,
    ),
    message: assertText(
      definition.message,
      `UI notice '${definition.id}' message`,
      500,
    ),
    tone: definition.tone ?? "info",
    report,
  });
}

export type RegisteredExtensionUiNotice = RegisteredExtensionContribution<
  RuntimeUiNoticeDefinition
>;

export class ExtensionUiSlotRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<RuntimeUiNoticeDefinition>("ui-slot");

  bind(scope: ExtensionApiScope): ExtensionUiApi {
    const bound = this.registry.bind(scope);
    return Object.freeze({
      registerNotice: (
        definition: ExtensionUiNoticeDefinition,
      ): ExtensionUiRegistration =>
        bound.register(compileNotice(definition, scope.report)),
    });
  }

  list(slot: ExtensionUiSlotId): readonly RegisteredExtensionUiNotice[] {
    return this.registry
      .list()
      .filter((entry) => entry.definition.slot === slot);
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener);
  }

  getRevision(): number {
    return this.registry.getRevision();
  }
}

export const extensionUiSlotRegistry = new ExtensionUiSlotRegistry();
