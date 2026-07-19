import type {
  ExtensionApiScope,
  ExtensionMenuApi,
  ExtensionMenuCommandContribution,
  ExtensionMenuCondition,
  ExtensionMenuInfo,
  ExtensionUiRegistration,
  JsonValue,
} from "../types";
import {
  hostMenuCatalog,
  type HostMenuCatalog,
} from "../../../core/shell/hostMenuCatalog";
import {
  hostCommandTable,
  type HostCommandTable,
} from "../../../core/shell/commandTable";
import {
  assertContextKeyExpression,
  evaluateContextKeyExpression,
  hostContextKeys,
} from "../../../core/shell/contextKeys";
import { jsonValueSchema } from "../../../core/shell/jsonValue";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionDefinition,
  type RegisteredExtensionContribution,
} from "../registry/ExtensionContributionRegistry";
import { cloneAndFreezeJsonValue } from "../registry/frozenJson";

const MAX_CONDITION_DEPTH = 8;

/**
 * Structural validation for a placement's declarative visibility condition
 * (plan §3.3). Conditions are data, never callbacks, so they stay evaluable
 * in a future restricted profile; malformed shapes reject at registration.
 */
export function assertMenuCondition(
  condition: ExtensionMenuCondition,
  label: string,
  depth = 0,
): void {
  if (depth > MAX_CONDITION_DEPTH) {
    throw new Error(`${label} condition nests too deeply.`);
  }
  if (typeof condition !== "object" || condition === null) {
    throw new Error(`${label} condition must be an object.`);
  }
  if ("context" in condition) {
    assertContextKeyExpression(condition.context, label);
    return;
  }
  if ("subject" in condition) {
    const subject = condition.subject;
    if (
      typeof subject !== "object" ||
      subject === null ||
      !Array.isArray(subject.path) ||
      subject.path.length === 0 ||
      subject.path.some((segment) => typeof segment !== "string")
    ) {
      throw new Error(
        `${label} subject condition needs a non-empty string path.`,
      );
    }
    if (
      subject.equals !== undefined &&
      !jsonValueSchema.safeParse(subject.equals).success
    ) {
      throw new Error(`${label} subject 'equals' must be finite JSON.`);
    }
    return;
  }
  if ("not" in condition) {
    assertMenuCondition(condition.not, label, depth + 1);
    return;
  }
  if ("all" in condition || "any" in condition) {
    const branches = "all" in condition ? condition.all : condition.any;
    if (!Array.isArray(branches) || branches.length === 0) {
      throw new Error(`${label} condition branches must be non-empty.`);
    }
    for (const branch of branches) {
      assertMenuCondition(branch, label, depth + 1);
    }
    return;
  }
  throw new Error(`${label} condition has no recognised operator.`);
}

// Mirrors the shell context-key evaluator's equality semantics.
function jsonEquals(left: JsonValue | undefined, right: JsonValue): boolean {
  if (left === undefined) return false;
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (left === null || right === null) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveSubjectPath(
  subject: JsonValue,
  path: readonly string[],
): JsonValue | undefined {
  let current: JsonValue | undefined = subject;
  for (const segment of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * Evaluates a placement's structured visibility condition against the menu's
 * detached subject and the host context keys. Missing subject paths and
 * unknown context keys fail closed (falsy), never throw.
 */
export function evaluateMenuCondition(
  condition: ExtensionMenuCondition,
  subject: JsonValue,
  getContextKey: (key: string) => JsonValue | undefined,
): boolean {
  if ("context" in condition) {
    return evaluateContextKeyExpression(condition.context, getContextKey);
  }
  if ("subject" in condition) {
    const value = resolveSubjectPath(subject, condition.subject.path);
    if (condition.subject.equals !== undefined) {
      return jsonEquals(value, condition.subject.equals);
    }
    return Boolean(value);
  }
  if ("not" in condition) {
    return !evaluateMenuCondition(condition.not, subject, getContextKey);
  }
  if ("all" in condition) {
    return condition.all.every((branch) =>
      evaluateMenuCondition(branch, subject, getContextKey),
    );
  }
  return condition.any.some((branch) =>
    evaluateMenuCondition(branch, subject, getContextKey),
  );
}

export interface RuntimeMenuPlacementDefinition
  extends ExtensionContributionDefinition {
  readonly menuId: string;
  readonly kind: "command";
  /** Fully qualified (owner-scoped) command ID. */
  readonly commandId: string;
  readonly group: string;
  readonly order: number;
  readonly when?: ExtensionMenuCondition;
  readonly report: ExtensionApiScope["report"];
}

export type RegisteredMenuPlacement =
  RegisteredExtensionContribution<RuntimeMenuPlacementDefinition>;

// Matches the contribution registries' local-ID grammar; groups ("1_clip",
// "9_extensions") share it.
const LOCAL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/**
 * Menu placements (plan §3.3): every ordinary extension menu item is a
 * reference to a command the same extension already registered. Labels,
 * icons, and enablement project from the command definition, so menus,
 * keybindings, and future palette/toolbar surfaces stay projections of one
 * command table.
 */
export class ExtensionMenuPlacementRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<RuntimeMenuPlacementDefinition>(
      "menu-placement",
    );
  private readonly catalog: HostMenuCatalog;
  private readonly table: HostCommandTable;

  constructor(
    catalog: HostMenuCatalog = hostMenuCatalog,
    table: HostCommandTable = hostCommandTable,
  ) {
    this.catalog = catalog;
    this.table = table;
  }

  bind(scope: ExtensionApiScope): ExtensionMenuApi {
    const bound = this.registry.bind(scope);
    return Object.freeze({
      addItem: (
        definition: ExtensionMenuCommandContribution,
      ): ExtensionUiRegistration =>
        bound.register(this.compilePlacement(definition, scope)),
      listMenus: (): readonly ExtensionMenuInfo[] =>
        this.catalog
          .describeAll()
          .map((description) =>
            cloneAndFreezeJsonValue({
              id: description.id,
              subjectSchema: description.subjectSchema,
            }),
          ),
    });
  }

  listForMenu(menuId: string): readonly RegisteredMenuPlacement[] {
    return this.registry
      .list()
      .filter((entry) => entry.definition.menuId === menuId)
      .sort(
        (left, right) =>
          left.definition.order - right.definition.order ||
          left.id.localeCompare(right.id),
      );
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener);
  }

  getRevision(): number {
    return this.registry.getRevision();
  }

  private compilePlacement(
    definition: ExtensionMenuCommandContribution,
    scope: ExtensionApiScope,
  ): RuntimeMenuPlacementDefinition {
    if (definition.apiVersion !== 1 || definition.kind !== "command") {
      throw new Error(
        `Menu placement '${definition.id}' must use command placement API 1.`,
      );
    }
    if (!this.catalog.has(definition.menuId)) {
      throw new Error(
        `Menu placement '${definition.id}' targets undeclared host menu '${definition.menuId}'.`,
      );
    }
    // Cross-owner and host command references reject here: only the local-ID
    // grammar is accepted, and qualification scopes it to this owner.
    if (
      typeof definition.command !== "string" ||
      !LOCAL_ID_PATTERN.test(definition.command)
    ) {
      throw new Error(
        `Menu placement '${definition.id}' must reference a local command ID.`,
      );
    }
    const commandId = `${scope.extension.id}/${definition.command}`;
    if (!this.table.has(commandId)) {
      throw new Error(
        `Menu placement '${definition.id}' references unregistered command ` +
          `'${definition.command}'. Register the command first.`,
      );
    }
    if (
      typeof definition.group !== "string" ||
      !LOCAL_ID_PATTERN.test(definition.group)
    ) {
      throw new Error(
        `Menu placement '${definition.id}' needs a group like "9_extensions".`,
      );
    }
    const order = definition.order ?? 0;
    if (!Number.isFinite(order)) {
      throw new Error(`Menu placement '${definition.id}' order must be finite.`);
    }
    let when: ExtensionMenuCondition | undefined;
    if (definition.when !== undefined) {
      assertMenuCondition(definition.when, `Menu placement '${definition.id}'`);
      // Conditions are JSON-shaped data; detach so later extension-side
      // mutation cannot change registered visibility.
      when = cloneAndFreezeJsonValue(
        definition.when as unknown as JsonValue,
      ) as unknown as ExtensionMenuCondition;
    }
    return Object.freeze({
      id: definition.id,
      apiVersion: 1,
      menuId: definition.menuId,
      kind: "command",
      commandId,
      group: definition.group,
      order,
      when,
      report: scope.report,
    });
  }
}

export const extensionMenuPlacementRegistry =
  new ExtensionMenuPlacementRegistry();

/** One placement ready for the shell renderer (icon still a component). */
export interface ResolvedMenuPlacement {
  /** Owner-qualified placement ID. */
  readonly id: string;
  /** Fully qualified command ID present in the command table. */
  readonly command: string;
  readonly group: string;
  readonly order: number;
  /** Trusted icon component from the command definition, if any. */
  readonly icon: (() => unknown) | null;
  /** Detached, frozen subject clone shared by this resolve pass. */
  readonly subject: JsonValue;
  /** Owner-scoped diagnostics sink (icon render failures). */
  readonly report: ExtensionApiScope["report"];
}

export interface MenuPlacementResolveDeps {
  readonly registry?: ExtensionMenuPlacementRegistry;
  readonly table?: HostCommandTable;
  readonly getContextKey?: (key: string) => JsonValue | undefined;
}

// One diagnostic per orphaned placement, not one per render; re-reports if
// the command reappears and is disposed again.
const reportedOrphans = new Set<string>();

/**
 * Resolves the placements contributed to one menu against the live command
 * table and context keys: orphaned placements (command disposed) are inert
 * with an owner diagnostic, structured `when` conditions are evaluated
 * against the detached subject, and the subject is cloned and frozen for the
 * command invocation. Subjects reaching this resolver already passed the
 * menu's catalogued schema.
 */
export function resolveMenuPlacements(
  menuId: string,
  subject: unknown,
  deps: MenuPlacementResolveDeps = {},
): readonly ResolvedMenuPlacement[] {
  const registry = deps.registry ?? extensionMenuPlacementRegistry;
  const table = deps.table ?? hostCommandTable;
  const getContextKey =
    deps.getContextKey ?? ((key: string) => hostContextKeys.get(key));

  const placements = registry.listForMenu(menuId);
  if (placements.length === 0) return [];

  const parsed = jsonValueSchema.safeParse(subject);
  if (!parsed.success) return [];
  const detachedSubject = cloneAndFreezeJsonValue(parsed.data);

  const resolved: ResolvedMenuPlacement[] = [];
  for (const placement of placements) {
    const definition = placement.definition;
    if (!table.has(definition.commandId)) {
      if (!reportedOrphans.has(placement.id)) {
        reportedOrphans.add(placement.id);
        definition.report(
          "warning",
          `Menu placement '${placement.id}' references disposed command '${definition.commandId}' and is inert. Dispose the placement or re-register the command.`,
        );
      }
      continue;
    }
    reportedOrphans.delete(placement.id);
    if (
      definition.when !== undefined &&
      !evaluateMenuCondition(definition.when, detachedSubject, getContextKey)
    ) {
      continue;
    }
    resolved.push({
      id: placement.id,
      command: definition.commandId,
      group: definition.group,
      order: definition.order,
      icon: table.getEntry(definition.commandId)?.icon ?? null,
      subject: detachedSubject,
      report: definition.report,
    });
  }
  return resolved;
}
