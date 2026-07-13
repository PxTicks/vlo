import { registerCustomControl } from "../../panelUI";
import { jsonValueSchema } from "../persistence/extensionPayload";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionDefinition,
  type RegisteredExtensionContribution,
} from "../registry/ExtensionContributionRegistry";
import { createHostCustomControl } from "./createHostCustomControl";
import type {
  ExtensionApiScope,
  ExtensionPanelControlDefinition,
  ExtensionPanelControlPlacement,
  ExtensionPanelControlProps,
  ExtensionPanelControlRegistration,
  JsonValue,
} from "../types";

/**
 * Panel zones the host declares. An extension may only place a control in one of
 * these; it cannot invent a target or mount React at an arbitrary location.
 *
 * `filterName` is the concrete filter catalogue identity, deliberately not the
 * generic transform type (`filter`).
 */
export const HOST_PANEL_CONTROL_TARGETS = [
  { kind: "filter", filterName: "ColorGradeFilter", zone: "extensions" },
] as const;

function targetKey(target: ExtensionPanelControlPlacement["target"]): string {
  return `${target.kind}:${target.filterName}:${target.zone}`;
}

const DECLARED_TARGET_KEYS: ReadonlySet<string> = new Set(
  HOST_PANEL_CONTROL_TARGETS.map(targetKey),
);

export interface RuntimePanelControlPlacement {
  readonly target: ExtensionPanelControlPlacement["target"];
  readonly order: number;
  readonly config: Readonly<Record<string, JsonValue>>;
}

export interface RuntimePanelControlDefinition
  extends ExtensionContributionDefinition {
  readonly kind: "trusted-react";
  readonly component: (props: ExtensionPanelControlProps) => unknown;
  readonly placements: readonly RuntimePanelControlPlacement[];
  readonly report: ExtensionApiScope["report"];
}

export type RegisteredExtensionPanelControl =
  RegisteredExtensionContribution<RuntimePanelControlDefinition>;

function cloneAndFreezeJsonValue<TValue extends JsonValue>(
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

function cloneConfig(
  value: Readonly<Record<string, JsonValue>> | undefined,
  label: string,
): Readonly<Record<string, JsonValue>> {
  if (value === undefined) return Object.freeze({});
  const parsed = jsonValueSchema.safeParse(value);
  if (
    !parsed.success ||
    typeof parsed.data !== "object" ||
    parsed.data === null ||
    Array.isArray(parsed.data)
  ) {
    throw new Error(`${label} config must be a finite JSON object.`);
  }
  return cloneAndFreezeJsonValue(
    structuredClone(parsed.data) as Record<string, JsonValue>,
  );
}

export class ExtensionPanelControlRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<RuntimePanelControlDefinition>(
      "panel-control",
    );

  bind(scope: ExtensionApiScope): {
    registerPanelControl(
      definition: ExtensionPanelControlDefinition,
    ): ExtensionPanelControlRegistration;
  } {
    const bound = this.registry.bind(scope);
    return Object.freeze({
      registerPanelControl: (definition: ExtensionPanelControlDefinition) => {
        // Compile before registering so an invalid definition rolls back the
        // whole activation rather than half-publishing a contribution.
        const compiled = this.compile(definition, scope.report);
        const registration = bound.register(compiled);
        const releaseControl = registerCustomControl(
          registration.id,
          createHostCustomControl({
            contributionId: registration.id,
            component: compiled.component,
            report: scope.report,
          }),
        );
        return scope.own(
          Object.freeze({
            id: registration.id,
            dispose: () => {
              releaseControl();
              void registration.dispose();
            },
          }),
        );
      },
    });
  }

  /** Contributions placed in one host zone, ordered deterministically. */
  list(
    target: ExtensionPanelControlPlacement["target"],
  ): readonly {
    readonly contribution: RegisteredExtensionPanelControl;
    readonly placement: RuntimePanelControlPlacement;
  }[] {
    const key = targetKey(target);
    return this.registry
      .list()
      .flatMap((contribution) =>
        contribution.definition.placements
          .filter((placement) => targetKey(placement.target) === key)
          .map((placement) => ({ contribution, placement })),
      )
      .sort(
        (left, right) =>
          left.placement.order - right.placement.order ||
          left.contribution.id.localeCompare(right.contribution.id),
      );
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener);
  }

  getRevision(): number {
    return this.registry.getRevision();
  }

  private compile(
    definition: ExtensionPanelControlDefinition,
    report: ExtensionApiScope["report"],
  ): RuntimePanelControlDefinition {
    if (definition.apiVersion !== 1 || definition.kind !== "trusted-react") {
      throw new Error(
        `Panel control '${definition.id}' must use trusted-react API 1.`,
      );
    }
    if (typeof definition.component !== "function") {
      throw new Error(
        `Panel control '${definition.id}' must provide a component function.`,
      );
    }
    const placements = (definition.placements ?? []).map((placement) => {
      if (typeof placement !== "object" || placement === null) {
        throw new Error(
          `Panel control '${definition.id}' has an invalid placement.`,
        );
      }
      const target = placement.target;
      if (
        typeof target !== "object" ||
        target === null ||
        !DECLARED_TARGET_KEYS.has(targetKey(target))
      ) {
        throw new Error(
          `Panel control '${definition.id}' targets an undeclared host panel zone.`,
        );
      }
      const order = placement.order ?? 0;
      if (!Number.isFinite(order)) {
        throw new Error(
          `Panel control '${definition.id}' placement order must be finite.`,
        );
      }
      return Object.freeze({
        target: Object.freeze({ ...target }),
        order,
        config: cloneConfig(
          placement.config,
          `Panel control '${definition.id}' placement`,
        ),
      });
    });

    return Object.freeze({
      id: definition.id,
      apiVersion: 1,
      kind: "trusted-react",
      component: definition.component,
      placements: Object.freeze(placements),
      execution: "trusted",
      report,
    });
  }
}

export const extensionPanelControlRegistry = new ExtensionPanelControlRegistry();
