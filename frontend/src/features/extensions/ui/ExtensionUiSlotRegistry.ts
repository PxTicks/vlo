import type {
  ExtensionApiScope,
  ExtensionTrustedUiComponentDefinition,
  ExtensionTrustedUiModalDefinition,
  ExtensionUiApi,
  ExtensionUiNoticeDefinition,
  ExtensionUiRegistration,
  ExtensionUiSlotId,
  JsonValue,
} from "../types";
import { jsonValueSchema } from "../persistence/extensionPayload";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionDefinition,
  type RegisteredExtensionContribution,
} from "../registry/ExtensionContributionRegistry";

const SLOT_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;
const HOST_UI_SLOTS = [
  "transformation-panel.before",
  "generation.toolbar",
  "generation.inputs.after",
] as const;

interface RuntimeUiNoticeDefinition extends ExtensionContributionDefinition {
  readonly slot: ExtensionUiSlotId;
  readonly kind: "notice";
  readonly title: string;
  readonly message: string;
  readonly tone: "info" | "success" | "warning";
  readonly order: number;
  readonly report: ExtensionApiScope["report"];
}

interface RuntimeTrustedUiComponentDefinition
  extends ExtensionContributionDefinition {
  readonly slot: ExtensionUiSlotId;
  readonly kind: "trusted-react";
  readonly order: number;
  readonly component: ExtensionTrustedUiComponentDefinition["component"];
  readonly report: ExtensionApiScope["report"];
}

interface RuntimeTrustedUiModalDefinition
  extends ExtensionContributionDefinition {
  readonly kind: "trusted-modal";
  readonly title: string;
  readonly size: "small" | "medium" | "large";
  readonly component: ExtensionTrustedUiModalDefinition["component"];
  readonly report: ExtensionApiScope["report"];
}

type RuntimeUiSlotDefinition =
  | RuntimeUiNoticeDefinition
  | RuntimeTrustedUiComponentDefinition;

type RuntimeUiContributionDefinition =
  | RuntimeUiSlotDefinition
  | RuntimeTrustedUiModalDefinition;

interface ActiveModalRequest {
  readonly contributionId: string;
  readonly input?: JsonValue;
  readonly resolve: (result: JsonValue | undefined) => void;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

export interface ActiveExtensionModal {
  readonly contribution: RegisteredExtensionUiContribution;
  readonly input?: JsonValue;
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

function assertOrder(order: number | undefined, contributionId: string): number {
  const normalized = order ?? 0;
  if (!Number.isFinite(normalized)) {
    throw new Error(`UI contribution '${contributionId}' order must be finite.`);
  }
  return normalized;
}

function cloneJson(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) throw new Error("Modal values must be finite JSON.");
  return structuredClone(parsed.data);
}

export type RegisteredExtensionUiContribution =
  RegisteredExtensionContribution<RuntimeUiContributionDefinition>;

export class ExtensionUiContributionRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<RuntimeUiContributionDefinition>(
      "ui-contribution",
    );
  private readonly declaredSlots = new Set<string>(HOST_UI_SLOTS);
  private readonly listeners = new Set<() => void>();
  private activeModal: ActiveModalRequest | null = null;
  private modalRevision = 0;

  constructor(additionalSlots: readonly string[] = []) {
    for (const slot of additionalSlots) this.declareSlot(slot);
    this.registry.subscribe(() => {
      if (
        this.activeModal &&
        !this.registry.has(this.activeModal.contributionId)
      ) {
        this.finishActiveModal(undefined);
        return;
      }
      this.emitChange();
    });
  }

  /** Host-only declaration; extensions still receive only the bound facade. */
  declareSlot(slot: ExtensionUiSlotId): void {
    if (!SLOT_ID_PATTERN.test(slot)) {
      throw new Error(`Invalid host UI slot '${slot}'.`);
    }
    this.declaredSlots.add(slot);
  }

  bind(scope: ExtensionApiScope): ExtensionUiApi {
    const bound = this.registry.bind(scope);
    return Object.freeze({
      registerNotice: (
        definition: ExtensionUiNoticeDefinition,
      ): ExtensionUiRegistration =>
        bound.register(this.compileNotice(definition, scope.report)),
      registerComponent: (
        definition: ExtensionTrustedUiComponentDefinition,
      ): ExtensionUiRegistration =>
        bound.register(this.compileComponent(definition, scope.report)),
      registerModal: (
        definition: ExtensionTrustedUiModalDefinition,
      ): ExtensionUiRegistration =>
        bound.register(this.compileModal(definition, scope.report)),
      openModal: (id: string, input?: JsonValue) =>
        this.openModal(scope, id, input),
    });
  }

  list(slot: ExtensionUiSlotId): readonly RegisteredExtensionUiContribution[] {
    return this.registry
      .list()
      .filter(
        (entry) =>
          "slot" in entry.definition && entry.definition.slot === slot,
      )
      .sort(
        (left, right) =>
          (left.definition as RuntimeUiSlotDefinition).order -
            (right.definition as RuntimeUiSlotDefinition).order ||
          left.id.localeCompare(right.id),
      );
  }

  getActiveModal(): ActiveExtensionModal | null {
    const active = this.activeModal;
    if (!active) return null;
    const contribution = this.registry.get(active.contributionId);
    if (!contribution || contribution.definition.kind !== "trusted-modal") {
      this.finishActiveModal(undefined);
      return null;
    }
    return Object.freeze({
      contribution,
      input: cloneJson(active.input),
    });
  }

  closeActiveModal(result?: JsonValue): void {
    try {
      this.finishActiveModal(cloneJson(result));
    } catch (error) {
      const active = this.activeModal
        ? this.registry.get(this.activeModal.contributionId)
        : undefined;
      active?.definition.report(
        "error",
        `Extension modal '${active.id}' returned an invalid result.`,
        error,
      );
      this.finishActiveModal(undefined);
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.registry.getRevision() + this.modalRevision;
  }

  private compileNotice(
    definition: ExtensionUiNoticeDefinition,
    report: ExtensionApiScope["report"],
  ): RuntimeUiNoticeDefinition {
    this.assertCommonSlotDefinition(definition, "notice");
    if (
      definition.tone !== undefined &&
      !["info", "success", "warning"].includes(definition.tone)
    ) {
      throw new Error(`UI notice '${definition.id}' has an invalid tone.`);
    }
    return Object.freeze({
      id: definition.id,
      apiVersion: 1,
      slot: definition.slot,
      kind: "notice",
      title: assertText(definition.title, `UI notice '${definition.id}' title`, 120),
      message: assertText(
        definition.message,
        `UI notice '${definition.id}' message`,
        500,
      ),
      tone: definition.tone ?? "info",
      order: assertOrder(definition.order, definition.id),
      report,
    });
  }

  private compileComponent(
    definition: ExtensionTrustedUiComponentDefinition,
    report: ExtensionApiScope["report"],
  ): RuntimeTrustedUiComponentDefinition {
    this.assertCommonSlotDefinition(definition, "trusted-react");
    if (typeof definition.component !== "function") {
      throw new Error(
        `UI component '${definition.id}' must provide a component function.`,
      );
    }
    return Object.freeze({
      id: definition.id,
      apiVersion: 1,
      slot: definition.slot,
      kind: "trusted-react",
      component: definition.component,
      order: assertOrder(definition.order, definition.id),
      execution: "trusted",
      report,
    });
  }

  private compileModal(
    definition: ExtensionTrustedUiModalDefinition,
    report: ExtensionApiScope["report"],
  ): RuntimeTrustedUiModalDefinition {
    if (definition.apiVersion !== 1 || definition.kind !== "trusted-modal") {
      throw new Error(`UI modal '${definition.id}' must use trusted-modal API 1.`);
    }
    if (typeof definition.component !== "function") {
      throw new Error(`UI modal '${definition.id}' must provide a component.`);
    }
    if (
      definition.size !== undefined &&
      !["small", "medium", "large"].includes(definition.size)
    ) {
      throw new Error(`UI modal '${definition.id}' has an invalid size.`);
    }
    return Object.freeze({
      id: definition.id,
      apiVersion: 1,
      kind: "trusted-modal",
      title: assertText(definition.title, `UI modal '${definition.id}' title`, 120),
      size: definition.size ?? "medium",
      component: definition.component,
      execution: "trusted",
      report,
    });
  }

  private assertCommonSlotDefinition(
    definition: ExtensionUiNoticeDefinition | ExtensionTrustedUiComponentDefinition,
    kind: "notice" | "trusted-react",
  ): void {
    if (definition.apiVersion !== 1 || definition.kind !== kind) {
      throw new Error(`UI contribution '${definition.id}' must use ${kind} API 1.`);
    }
    if (!this.declaredSlots.has(definition.slot)) {
      throw new Error(
        `UI contribution '${definition.id}' targets undeclared host slot '${definition.slot}'.`,
      );
    }
  }

  private openModal(
    scope: ExtensionApiScope,
    localId: string,
    input?: JsonValue,
  ): Promise<JsonValue | undefined> {
    if (scope.signal.aborted) return Promise.resolve(undefined);
    const contributionId = `${scope.extension.id}/${localId}`;
    const contribution = this.registry.get(contributionId);
    if (!contribution || contribution.definition.kind !== "trusted-modal") {
      throw new Error(`UI modal '${contributionId}' is not registered.`);
    }
    this.finishActiveModal(undefined);
    return new Promise((resolve) => {
      const abort = () => {
        if (this.activeModal?.contributionId === contributionId) {
          this.finishActiveModal(undefined);
        }
      };
      this.activeModal = {
        contributionId,
        input: cloneJson(input),
        resolve,
        signal: scope.signal,
        abort,
      };
      scope.signal.addEventListener("abort", abort, { once: true });
      this.modalRevision += 1;
      this.emitChange();
    });
  }

  private finishActiveModal(result: JsonValue | undefined): void {
    const active = this.activeModal;
    if (!active) return;
    this.activeModal = null;
    active.signal.removeEventListener("abort", active.abort);
    this.modalRevision += 1;
    active.resolve(result);
    this.emitChange();
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // UI observers are derived render notifications only.
      }
    }
  }
}

/** @deprecated Use ExtensionUiContributionRegistry for new host code. */
export { ExtensionUiContributionRegistry as ExtensionUiSlotRegistry };

export const extensionUiSlotRegistry = new ExtensionUiContributionRegistry();
