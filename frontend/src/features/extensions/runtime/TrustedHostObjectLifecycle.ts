import type { ExtensionTrustedPixiObjectInstance } from "../types";

export type TrustedHostObjectFailureReporter = (
  key: string,
  level: "error" | "warning",
  message: string,
  detail?: unknown,
) => void;

export interface TrustedHostObjectSlotAdapter<
  TObject extends object,
  TSlot,
  TAttachment,
> {
  readonly slotKind: string;
  validate(object: object): object is TObject;
  isSameSlot?(left: TSlot, right: TSlot): boolean;
  attach(object: TObject, slot: TSlot, attachment: TAttachment): void;
  detach(object: TObject, slot: TSlot): void;
  destroy(object: TObject): void;
}

export interface TrustedHostObjectManagerOptions<
  TObject extends object,
  TParameters,
  TUpdateContext,
  TSlot,
  TAttachment,
> {
  readonly contributionId: string;
  readonly create: () => ExtensionTrustedPixiObjectInstance<
    TParameters,
    TUpdateContext
  >;
  readonly adapter: TrustedHostObjectSlotAdapter<
    TObject,
    TSlot,
    TAttachment
  >;
  readonly reportFailureOnce: TrustedHostObjectFailureReporter;
}

interface GlobalTrustedHostObjectOwner {
  readonly token: symbol;
  readonly release: () => void;
}

interface TrustedHostObjectRecord<
  TObject extends object,
  TParameters,
  TUpdateContext,
  TSlot,
> {
  readonly object: TObject;
  readonly instance: ExtensionTrustedPixiObjectInstance<
    TParameters,
    TUpdateContext
  >;
  slot?: TSlot;
  released: boolean;
}

const TRUSTED_HOST_OBJECT_OWNERS = new WeakMap<
  object,
  GlobalTrustedHostObjectOwner
>();

export class TrustedHostObjectManager<
  TObject extends object,
  TParameters,
  TUpdateContext,
  TSlot,
  TAttachment,
> {
  readonly contributionId: string;

  private readonly token = Symbol("trusted-host-object-owner");
  private readonly createInstance: () =>
    ExtensionTrustedPixiObjectInstance<TParameters, TUpdateContext>;
  private readonly adapter: TrustedHostObjectSlotAdapter<
    TObject,
    TSlot,
    TAttachment
  >;
  private readonly reportFailureOnce: TrustedHostObjectFailureReporter;
  private readonly records = new Set<
    TrustedHostObjectRecord<TObject, TParameters, TUpdateContext, TSlot>
  >();
  private readonly recordsByObject = new WeakMap<
    TObject,
    TrustedHostObjectRecord<TObject, TParameters, TUpdateContext, TSlot>
  >();
  private disposed = false;

  constructor(
    options: TrustedHostObjectManagerOptions<
      TObject,
      TParameters,
      TUpdateContext,
      TSlot,
      TAttachment
    >,
  ) {
    this.contributionId = options.contributionId;
    this.createInstance = options.create;
    this.adapter = options.adapter;
    this.reportFailureOnce = options.reportFailureOnce;
  }

  create(): TObject | null {
    if (this.disposed) {
      this.reportFailureOnce(
        "create-after-disposal",
        "error",
        `Trusted ${this.adapter.slotKind} '${this.contributionId}' was used after disposal.`,
      );
      return null;
    }

    let instance: ExtensionTrustedPixiObjectInstance<
      TParameters,
      TUpdateContext
    >;
    try {
      instance = this.createInstance();
    } catch (error) {
      this.reportFailureOnce(
        "create",
        "error",
        `Trusted ${this.adapter.slotKind} '${this.contributionId}' failed during creation.`,
        error,
      );
      return null;
    }

    if (
      typeof instance !== "object" ||
      instance === null ||
      typeof instance.object !== "object" ||
      instance.object === null ||
      typeof instance.update !== "function"
    ) {
      this.cleanupUnownedInstance(instance, "invalid-instance-cleanup");
      this.reportFailureOnce(
        "invalid-instance",
        "error",
        `Trusted ${this.adapter.slotKind} '${this.contributionId}' returned an invalid lifecycle instance.`,
      );
      return null;
    }

    const candidate = instance.object;
    let object: TObject | null = null;
    try {
      if (this.adapter.validate(candidate)) {
        object = candidate;
      }
    } catch (error) {
      this.cleanupUnownedInstance(instance, "validation-cleanup");
      this.reportFailureOnce(
        "validation",
        "error",
        `Trusted ${this.adapter.slotKind} '${this.contributionId}' failed host validation.`,
        error,
      );
      return null;
    }
    if (!object) {
      this.cleanupUnownedInstance(instance, "invalid-object-cleanup");
      this.reportFailureOnce(
        "invalid-object",
        "error",
        `Trusted ${this.adapter.slotKind} '${this.contributionId}' returned an object incompatible with its host slot.`,
      );
      return null;
    }

    if (TRUSTED_HOST_OBJECT_OWNERS.has(object)) {
      this.cleanupUnownedInstance(instance, "duplicate-object-cleanup");
      this.reportFailureOnce(
        "duplicate-object",
        "error",
        `Trusted ${this.adapter.slotKind} '${this.contributionId}' returned an object that is already owned.`,
      );
      return null;
    }

    const record: TrustedHostObjectRecord<
      TObject,
      TParameters,
      TUpdateContext,
      TSlot
    > = {
      object,
      instance,
      released: false,
    };
    this.records.add(record);
    this.recordsByObject.set(object, record);
    TRUSTED_HOST_OBJECT_OWNERS.set(object, {
      token: this.token,
      release: () => this.release(object),
    });
    return object;
  }

  owns(object: object): object is TObject {
    return TRUSTED_HOST_OBJECT_OWNERS.get(object)?.token === this.token;
  }

  update(
    object: TObject,
    parameters: TParameters,
    context: TUpdateContext,
    slot: TSlot,
    attachment: TAttachment,
  ): boolean {
    const record = this.findRecord(object);
    if (!record || record.released) {
      this.reportFailureOnce(
        "unknown-object",
        "error",
        `Trusted ${this.adapter.slotKind} '${this.contributionId}' received an object it does not own.`,
      );
      return false;
    }

    if (
      record.slot !== undefined &&
      !(this.adapter.isSameSlot?.(record.slot, slot) ??
        Object.is(record.slot, slot))
    ) {
      const previousSlot = record.slot;
      record.slot = undefined;
      try {
        this.adapter.detach(object, previousSlot);
      } catch (error) {
        this.reportFailureOnce(
          "slot-move-detach",
          "error",
          `Trusted ${this.adapter.slotKind} '${this.contributionId}' failed to detach from its previous host slot.`,
          error,
        );
        this.release(object);
        return false;
      }
    }

    try {
      record.instance.update(parameters, context);
      // Record the slot before attachment so a partially successful adapter
      // can still be detached when it throws.
      record.slot = slot;
      this.adapter.attach(object, slot, attachment);
      return true;
    } catch (error) {
      this.reportFailureOnce(
        "update",
        "error",
        `Trusted ${this.adapter.slotKind} '${this.contributionId}' failed during update or attachment.`,
        error,
      );
      this.release(object);
      return false;
    }
  }

  release(object: TObject): void {
    const record = this.findRecord(object);
    if (!record || record.released) return;
    record.released = true;
    this.records.delete(record);
    this.recordsByObject.delete(record.object);
    TRUSTED_HOST_OBJECT_OWNERS.delete(record.object);

    if (record.slot !== undefined) {
      const slot = record.slot;
      record.slot = undefined;
      try {
        this.adapter.detach(record.object, slot);
      } catch (error) {
        this.reportFailureOnce(
          "detach",
          "error",
          `Trusted ${this.adapter.slotKind} '${this.contributionId}' failed to detach from its host slot.`,
          error,
        );
      }
    }

    try {
      record.instance.destroy?.();
    } catch (error) {
      this.reportFailureOnce(
        "instance-destroy",
        "error",
        `Trusted ${this.adapter.slotKind} '${this.contributionId}' failed to release extension-owned resources.`,
        error,
      );
    }

    try {
      this.adapter.destroy(record.object);
    } catch (error) {
      this.reportFailureOnce(
        "host-destroy",
        "error",
        `Trusted ${this.adapter.slotKind} '${this.contributionId}' failed host destruction.`,
        error,
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of [...this.records]) {
      this.release(record.object);
    }
  }

  private findRecord(
    object: TObject,
  ):
    | TrustedHostObjectRecord<TObject, TParameters, TUpdateContext, TSlot>
    | undefined {
    if (!this.owns(object)) return undefined;
    return this.recordsByObject.get(object);
  }

  private cleanupUnownedInstance(
    instance:
      | Partial<
          ExtensionTrustedPixiObjectInstance<TParameters, TUpdateContext>
        >
      | null,
    key: string,
  ): void {
    try {
      instance?.destroy?.();
    } catch (error) {
      this.reportFailureOnce(
        key,
        "error",
        `Trusted ${this.adapter.slotKind} '${this.contributionId}' failed to clean up a rejected instance.`,
        error,
      );
    }
  }
}

export function releaseTrustedHostObject(object: object): boolean {
  const owner = TRUSTED_HOST_OBJECT_OWNERS.get(object);
  if (!owner) return false;
  owner.release();
  return true;
}
