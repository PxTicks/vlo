import type {
  ExtensionApiScope,
  ExtensionDisposable,
} from "../types";

interface PatchLayer {
  readonly ownerId: string;
  readonly createDescriptor: (
    previous: PropertyDescriptor | undefined,
  ) => PropertyDescriptor;
  readonly report: ExtensionApiScope["report"];
}

interface PatchStack {
  readonly target: object;
  readonly property: PropertyKey;
  readonly original: PropertyDescriptor | undefined;
  readonly layers: PatchLayer[];
  installed: PropertyDescriptor;
}

function cloneDescriptor(
  descriptor: PropertyDescriptor | undefined,
): PropertyDescriptor | undefined {
  return descriptor ? { ...descriptor } : undefined;
}

function descriptorsEqual(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    Object.is(left.value, right.value) &&
    Object.is(left.get, right.get) &&
    Object.is(left.set, right.set) &&
    left.writable === right.writable &&
    left.enumerable === right.enumerable &&
    left.configurable === right.configurable
  );
}

function normalizeDescriptor(
  property: PropertyKey,
  descriptor: PropertyDescriptor,
): PropertyDescriptor {
  if (typeof descriptor !== "object" || descriptor === null) {
    throw new TypeError(
      "A trusted patch factory must return a property descriptor.",
    );
  }
  const probe = {};
  Object.defineProperty(probe, property, descriptor);
  const normalized = Object.getOwnPropertyDescriptor(probe, property);
  if (!normalized || normalized.configurable !== true) {
    throw new TypeError(
      "A tracked patch descriptor must remain configurable so it can be restored.",
    );
  }
  return normalized;
}

function buildDescriptor(
  stack: Pick<PatchStack, "property" | "original">,
  layers: readonly PatchLayer[],
): PropertyDescriptor {
  let descriptor = cloneDescriptor(stack.original);
  for (const layer of layers) {
    descriptor = normalizeDescriptor(
      stack.property,
      layer.createDescriptor(cloneDescriptor(descriptor)),
    );
  }
  if (!descriptor) {
    throw new TypeError("A trusted patch chain did not produce a descriptor.");
  }
  return descriptor;
}

export class TrustedHostPatchManager {
  private readonly stacks = new WeakMap<object, Map<PropertyKey, PatchStack>>();

  patchProperty(
    scope: ExtensionApiScope,
    target: object,
    property: PropertyKey,
    createDescriptor: PatchLayer["createDescriptor"],
  ): ExtensionDisposable {
    if (
      (typeof target !== "object" && typeof target !== "function") ||
      target === null
    ) {
      throw new TypeError("Trusted property patches require an object target.");
    }
    if (typeof createDescriptor !== "function") {
      throw new TypeError("Trusted property patches require a descriptor factory.");
    }

    let targetStacks = this.stacks.get(target);
    let stack = targetStacks?.get(property);
    if (!stack) {
      const original = Object.getOwnPropertyDescriptor(target, property);
      if (original && !original.configurable) {
        throw new TypeError(
          `Property '${String(property)}' is non-configurable and cannot be patched.`,
        );
      }
      stack = {
        target,
        property,
        original: cloneDescriptor(original),
        layers: [],
        installed: original ?? {},
      };
    } else if (
      !descriptorsEqual(
        Object.getOwnPropertyDescriptor(target, property),
        stack.installed,
      )
    ) {
      scope.report(
        "error",
        `Cannot patch '${String(property)}' because an untracked write replaced the managed descriptor.`,
      );
      throw new Error(`Trusted patch conflict for '${String(property)}'.`);
    }

    const layer: PatchLayer = {
      ownerId: scope.extension.id,
      createDescriptor,
      report: scope.report,
    };
    const installed = buildDescriptor(stack, [...stack.layers, layer]);
    Object.defineProperty(target, property, installed);
    stack.installed = installed;
    stack.layers.push(layer);
    if (!targetStacks) {
      targetStacks = new Map();
      this.stacks.set(target, targetStacks);
    }
    targetStacks.set(property, stack);

    let disposed = false;
    const disposable: ExtensionDisposable = Object.freeze({
      dispose: () => {
        if (disposed) return;
        this.removeLayer(stack, layer);
        disposed = true;
      },
    });
    try {
      scope.own(disposable);
    } catch (error) {
      this.removeLayer(stack, layer);
      throw error;
    }
    return disposable;
  }

  private removeLayer(stack: PatchStack, layer: PatchLayer): void {
    const layerIndex = stack.layers.indexOf(layer);
    if (layerIndex < 0) return;
    const current = Object.getOwnPropertyDescriptor(
      stack.target,
      stack.property,
    );
    if (!descriptorsEqual(current, stack.installed)) {
      layer.report(
        "error",
        `Trusted patch '${String(stack.property)}' owned by '${layer.ownerId}' was not restored because an untracked write replaced it.`,
      );
      stack.layers.splice(layerIndex, 1);
      this.deleteStackIfEmpty(stack);
      return;
    }

    const surviving = stack.layers.filter((candidate) => candidate !== layer);
    let next: PropertyDescriptor | undefined;
    try {
      next =
        surviving.length > 0
          ? buildDescriptor(stack, surviving)
          : cloneDescriptor(stack.original);
    } catch (error) {
      const responsible = surviving.find((candidate) => {
        try {
          buildDescriptor(
            stack,
            surviving.slice(0, surviving.indexOf(candidate) + 1),
          );
          return false;
        } catch {
          return true;
        }
      });
      (responsible ?? layer).report(
        "error",
        `Trusted patch factory for '${String(stack.property)}' failed during descriptor rebuild; the installed chain was left unchanged.`,
        error,
      );
      throw error;
    }

    if (next) {
      Object.defineProperty(stack.target, stack.property, next);
      stack.installed = next;
    } else {
      if (!Reflect.deleteProperty(stack.target, stack.property)) {
        throw new TypeError(
          `Failed to restore absent property '${String(stack.property)}'.`,
        );
      }
    }
    stack.layers.splice(layerIndex, 1);
    if (surviving.length === 0) this.deleteStackIfEmpty(stack);
  }

  private deleteStackIfEmpty(stack: PatchStack): void {
    if (stack.layers.length > 0) return;
    const targetStacks = this.stacks.get(stack.target);
    targetStacks?.delete(stack.property);
    if (targetStacks?.size === 0) this.stacks.delete(stack.target);
  }
}

export const trustedHostPatchManager = new TrustedHostPatchManager();
