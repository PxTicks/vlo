import type {
  ExtensionContextKeyExpression,
  JsonValue,
} from "@vlo/extension-sdk";
import {
  assertContextKeyExpression,
  evaluateContextKeyExpression,
  hostContextKeys,
  type HostContextKeyService,
} from "./contextKeys";
import { jsonValueSchema } from "./jsonValue";
import type { ShellDisposable } from "./hostMenuCatalog";

const CATALOGUE_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;
const OPTION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

function cloneAndFreezeJson<TValue extends JsonValue>(value: TValue): TValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreezeJson)) as TValue;
  }
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          cloneAndFreezeJson(entry),
        ]),
      ),
    ) as TValue;
  }
  return value;
}

/**
 * A host-declared option catalogue (extension-shell-surfaces plan §3.7): a
 * named list of options a host dropdown renders and extensions may extend.
 * Not a generic data bus — each catalogue declares a structural validator
 * for its option values, checked on every registration, and options are
 * frozen data thereafter.
 */
export interface HostCatalogueDeclaration {
  readonly id: string;
  /** Structural check for option values; registrations failing it reject. */
  readonly validateValue: (value: unknown) => boolean;
  /**
   * Serialisable structural description of the value shape, surfaced through
   * extension discovery. Documentation-grade; `validateValue` is
   * authoritative.
   */
  readonly valueSchema: JsonValue;
}

/** Discovery projection of one declared catalogue. */
export interface HostCatalogueDescription {
  readonly id: string;
  readonly valueSchema: JsonValue;
}

export interface CatalogueOptionEntry {
  /** Owner-qualified for contributed options. */
  readonly id: string;
  readonly label: string;
  /** Frozen, detached value satisfying the catalogue's schema. */
  readonly value: JsonValue;
  readonly order: number;
  /** Visibility condition over host context keys; fails closed. */
  readonly when?: ExtensionContextKeyExpression;
  readonly source: "host" | "contributed";
}

interface RegisterOptionInput {
  readonly id: string;
  readonly label: string;
  readonly value: JsonValue;
  readonly order?: number;
  readonly when?: ExtensionContextKeyExpression;
}

export class HostOptionCatalog {
  private readonly declarations = new Map<string, HostCatalogueDeclaration>();
  private readonly options = new Map<string, CatalogueOptionEntry[]>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  declare(declaration: HostCatalogueDeclaration): ShellDisposable {
    const { id } = declaration;
    if (!CATALOGUE_ID_PATTERN.test(id)) {
      throw new Error(`Invalid catalogue ID '${id}'.`);
    }
    if (this.declarations.has(id)) {
      throw new Error(`Catalogue '${id}' is already declared.`);
    }
    if (typeof declaration.validateValue !== "function") {
      throw new Error(`Catalogue '${id}' must declare validateValue().`);
    }
    const parsedSchema = jsonValueSchema.safeParse(declaration.valueSchema);
    if (!parsedSchema.success) {
      throw new Error(`Catalogue '${id}' must declare a finite-JSON valueSchema.`);
    }
    this.declarations.set(
      id,
      Object.freeze({
        ...declaration,
        valueSchema: cloneAndFreezeJson(parsedSchema.data),
      }),
    );
    this.emitChange();
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.declarations.delete(id);
        this.options.delete(id);
        this.emitChange();
      },
    });
  }

  has(catalogueId: string): boolean {
    return this.declarations.has(catalogueId);
  }

  describeAll(): readonly HostCatalogueDescription[] {
    return Object.freeze(
      [...this.declarations.values()].map((declaration) =>
        Object.freeze({
          id: declaration.id,
          valueSchema: cloneAndFreezeJson(declaration.valueSchema),
        }),
      ),
    );
  }

  registerHostOption(
    catalogueId: string,
    option: RegisterOptionInput,
  ): ShellDisposable {
    return this.add(catalogueId, option, "host");
  }

  /**
   * A non-host option whose owner-scoped policy (ID qualification, value
   * detachment, ownership) was already applied by the contributing layer —
   * the shell never sees owner scopes (§3.10).
   */
  registerContributedOption(
    catalogueId: string,
    option: RegisterOptionInput,
  ): ShellDisposable {
    const segments = option.id.split("/");
    if (
      segments.length !== 2 ||
      segments.some((segment) => !OPTION_ID_PATTERN.test(segment))
    ) {
      throw new Error(
        `Contributed catalogue option ID '${option.id}' must be owner-qualified ('owner/local').`,
      );
    }
    return this.add(catalogueId, option, "contributed");
  }

  /** All options of one catalogue: order, host-before-contributed, then ID. */
  listOptions(catalogueId: string): readonly CatalogueOptionEntry[] {
    return Object.freeze(
      [...(this.options.get(catalogueId) ?? [])].sort(
        (left, right) =>
          left.order - right.order ||
          Number(left.source === "contributed") -
            Number(right.source === "contributed") ||
          left.id.localeCompare(right.id),
      ),
    );
  }

  /** Options whose `when` condition passes; missing keys fail closed. */
  resolveOptions(
    catalogueId: string,
    contextKeys: HostContextKeyService = hostContextKeys,
  ): readonly CatalogueOptionEntry[] {
    return Object.freeze(
      this.listOptions(catalogueId).filter(
        (option) =>
          option.when === undefined ||
          evaluateContextKeyExpression(option.when, (key) =>
            contextKeys.get(key),
          ),
      ),
    );
  }

  getOption(
    catalogueId: string,
    optionId: string,
  ): CatalogueOptionEntry | undefined {
    return this.options
      .get(catalogueId)
      ?.find((option) => option.id === optionId);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.revision;
  }

  private add(
    catalogueId: string,
    option: RegisterOptionInput,
    source: "host" | "contributed",
  ): ShellDisposable {
    const declaration = this.declarations.get(catalogueId);
    if (!declaration) {
      throw new Error(
        `Option '${option.id}' targets undeclared catalogue '${catalogueId}'.`,
      );
    }
    const localId =
      source === "contributed" ? option.id.split("/")[1] : option.id;
    if (!localId || !OPTION_ID_PATTERN.test(localId)) {
      throw new Error(`Invalid catalogue option ID '${option.id}'.`);
    }
    if (typeof option.label !== "string" || option.label.trim().length === 0) {
      throw new Error(`Catalogue option '${option.id}' needs a label.`);
    }
    if (!declaration.validateValue(option.value)) {
      throw new Error(
        `Catalogue option '${option.id}' value fails the '${catalogueId}' schema.`,
      );
    }
    const parsedValue = jsonValueSchema.safeParse(option.value);
    if (!parsedValue.success) {
      throw new Error(`Catalogue option '${option.id}' value must be finite JSON.`);
    }
    if (option.when !== undefined) {
      assertContextKeyExpression(option.when, `Catalogue option '${option.id}'`);
    }
    const order = option.order ?? 0;
    if (!Number.isFinite(order)) {
      throw new Error(`Catalogue option '${option.id}' order must be finite.`);
    }
    const bucket = this.options.get(catalogueId) ?? [];
    if (bucket.some((existing) => existing.id === option.id)) {
      throw new Error(
        `Catalogue option '${option.id}' is already registered in '${catalogueId}'.`,
      );
    }
    const entry: CatalogueOptionEntry = Object.freeze({
      id: option.id,
      label: option.label.trim(),
      value: cloneAndFreezeJson(parsedValue.data),
      order,
      when:
        option.when === undefined
          ? undefined
          : (cloneAndFreezeJson(
              option.when as unknown as JsonValue,
            ) as unknown as ExtensionContextKeyExpression),
      source,
    });
    bucket.push(entry);
    this.options.set(catalogueId, bucket);
    this.emitChange();
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const current = this.options.get(catalogueId);
        if (!current) return;
        const index = current.indexOf(entry);
        if (index === -1) return;
        current.splice(index, 1);
        this.emitChange();
      },
    });
  }

  private emitChange(): void {
    this.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Catalogue observers are derived render notifications only.
      }
    }
  }
}

export const hostOptionCatalog = new HostOptionCatalog();
